import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, getDatabaseErrorInfo, getDatabasePool } from './db.js';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const applyRequested = process.argv.includes('--apply');
const unknownArgs = process.argv.slice(2).filter((argument) => argument !== '--apply');
if (unknownArgs.length) {
  console.error(`Argumen tidak dikenal: ${unknownArgs.join(', ')}`);
  process.exit(2);
}

function splitTopLevelDefinitions(body) {
  const definitions = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === quote && body[index - 1] !== '\\') {
        if (body[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) throw new Error('Definisi CREATE TABLE memiliki tanda kurung yang tidak seimbang.');
    } else if (character === ',' && depth === 0) {
      definitions.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) throw new Error('Definisi CREATE TABLE memiliki literal atau tanda kurung yang tidak lengkap.');
  definitions.push(body.slice(start).trim());
  return definitions.filter(Boolean);
}

function parseCreateTableContract(statement, migrationName) {
  const header = statement.match(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(dashboard_[a-z0-9_]+)\s*\(/i);
  if (!header) throw new Error(`Statement pada ${migrationName} bukan CREATE TABLE dashboard_* yang didukung.`);
  const tableName = header[1].toLowerCase();
  const openIndex = statement.indexOf('(', header[0].length - 1);
  let depth = 0;
  let quote = null;
  let closeIndex = -1;
  for (let index = openIndex; index < statement.length; index += 1) {
    const character = statement[index];
    if (quote) {
      if (character === quote && statement[index - 1] !== '\\') {
        if (statement[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) { closeIndex = index; break; }
    }
  }
  if (closeIndex < 0) throw new Error(`CREATE TABLE ${tableName} tidak memiliki penutup definisi.`);

  const tableOptions = statement.slice(closeIndex + 1);
  const engine = tableOptions.match(/\bENGINE\s*=\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase();
  const characterSet = tableOptions.match(/\bDEFAULT\s+CHARSET\s*=\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase();
  if (!engine || !characterSet) throw new Error(`Engine atau charset tidak dinyatakan pada tabel ${tableName}.`);
  const contract = { tableName, engine, characterSet, columns: new Map(), primaryKey: [], indexes: new Map(), foreignKeys: new Map() };
  for (const definition of splitTopLevelDefinitions(statement.slice(openIndex + 1, closeIndex))) {
    let match = definition.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (match) {
      contract.primaryKey = match[1].split(',').map((column) => column.trim().replaceAll('`', '').toLowerCase());
      continue;
    }
    match = definition.match(/^(UNIQUE\s+)?KEY\s+([a-z0-9_]+)\s*\(([^)]+)\)/i);
    if (match) {
      const name = match[2].toLowerCase();
      contract.indexes.set(name, {
        unique: Boolean(match[1]),
        columns: match[3].split(',').map((column) => column.trim().replaceAll('`', '').toLowerCase()),
      });
      continue;
    }
    match = definition.match(/^CONSTRAINT\s+([a-z0-9_]+)\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(dashboard_[a-z0-9_]+)\s*\(([^)]+)\)/i);
    if (match) {
      const name = match[1].toLowerCase();
      contract.foreignKeys.set(name, {
        columns: match[2].split(',').map((column) => column.trim().replaceAll('`', '').toLowerCase()),
        referencedTable: match[3].toLowerCase(),
        referencedColumns: match[4].split(',').map((column) => column.trim().replaceAll('`', '').toLowerCase()),
      });
      continue;
    }
    if (/^(?:UNIQUE\s+)?KEY\b/i.test(definition) || /^CONSTRAINT\b/i.test(definition)) {
      throw new Error(`Definisi key/constraint tidak didukung pada tabel ${tableName}.`);
    }

    match = definition.match(/^`?([a-z][a-z0-9_]*)`?\s+([a-z]+(?:\(\d+(?:,\s*\d+)?\))?(?:\s+unsigned)?)(?:\s+(.*))?$/i);
    if (!match) throw new Error(`Definisi kolom tidak dikenali pada tabel ${tableName}.`);
    const columnName = match[1].toLowerCase();
    const columnType = match[2].replace(/\s+/g, ' ').toLowerCase();
    const attributes = match[3] ?? '';
    if (contract.columns.has(columnName)) throw new Error(`Kolom ${tableName}.${columnName} didefinisikan lebih dari sekali.`);
    contract.columns.set(columnName, {
      type: columnType,
      nullable: !/\bNOT\s+NULL\b/i.test(attributes),
      autoIncrement: /\bAUTO_INCREMENT\b/i.test(attributes),
    });
    if (/\bPRIMARY\s+KEY\b/i.test(attributes)) contract.primaryKey.push(columnName);
  }

  if (!contract.columns.size || !contract.primaryKey.length) throw new Error(`Tabel ${tableName} harus memiliki kolom dan primary key.`);
  const knownColumns = new Set(contract.columns.keys());
  for (const [indexName, index] of contract.indexes) {
    if (index.columns.some((column) => !knownColumns.has(column))) throw new Error(`Indeks ${tableName}.${indexName} memakai kolom yang tidak terdefinisi.`);
  }
  for (const [constraintName, foreignKey] of contract.foreignKeys) {
    if (foreignKey.columns.length !== foreignKey.referencedColumns.length || foreignKey.columns.some((column) => !knownColumns.has(column))) {
      throw new Error(`Foreign key ${tableName}.${constraintName} memiliki kolom yang tidak konsisten.`);
    }
  }
  return contract;
}

const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => {
  const contents = await readFile(resolve(migrationsDirectory, name), 'utf8');
  const version = Number(name.slice(0, 3));
  const statements = contents
    .split(/^\s*-- statement-break\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
  const executableText = contents.replace(/^\s*--.*$/gm, '');
  const onlyAdditiveCreateTables = statements.every((statement) => (
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+dashboard_[a-z0-9_]+\s*\(/i.test(statement.replace(/^\s*--.*$/gm, '').trim())
  ));
  if (/\b(DROP|TRUNCATE|DELETE|ALTER)\b/i.test(executableText) || !onlyAdditiveCreateTables) {
    throw new Error(`Migrasi ${name} hanya boleh membuat tabel baru dashboard_* dengan CREATE TABLE IF NOT EXISTS.`);
  }
  if (!statements.length) throw new Error(`Migrasi ${name} tidak memiliki statement.`);
  const contracts = statements.map((statement) => parseCreateTableContract(
    statement.replace(/^\s*--.*$/gm, '').trim(),
    name,
  ));
  return { name, version, contents, statements, contracts, checksum: createHash('sha256').update(contents).digest('hex') };
}));

const declaredTables = new Set();
for (const migration of migrations) {
  for (const contract of migration.contracts) {
    if (declaredTables.has(contract.tableName)) throw new Error(`Tabel ${contract.tableName} didefinisikan pada lebih dari satu migration.`);
    for (const [constraintName, foreignKey] of contract.foreignKeys) {
      if (!declaredTables.has(foreignKey.referencedTable)) {
        throw new Error(`Urutan dependensi salah: ${contract.tableName}.${constraintName} merujuk tabel yang belum dideklarasikan.`);
      }
    }
    declaredTables.add(contract.tableName);
  }
}

const migrationLedgerContract = {
  tableName: 'dashboard_schema_migrations',
  engine: 'innodb',
  characterSet: 'utf8mb4',
  columns: new Map([
    ['version', { type: 'int unsigned', nullable: false, autoIncrement: false }],
    ['migration_name', { type: 'varchar(255)', nullable: false, autoIncrement: false }],
    ['checksum', { type: 'char(64)', nullable: false, autoIncrement: false }],
    ['applied_at', { type: 'datetime(3)', nullable: false, autoIncrement: false }],
  ]),
  primaryKey: ['version'],
  indexes: new Map(),
  foreignKeys: new Map(),
};

if (!applyRequested) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    databaseConnection: false,
    pendingMigrations: migrations.map(({ name, version, statements, contracts }) => ({
      name,
      version,
      statementCount: statements.length,
      tableCount: contracts.length,
      schemaContractParsed: true,
    })),
    instruction: 'Periksa target dan backup sebelum persetujuan penerapan; dry-run tidak mengubah database.',
  }, null, 2));
  process.exit(0);
}

function groupRows(rows, keyFields) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFields.map((field) => row[field]).join('.');
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

async function verifyMigrationTables(connection, contracts, { allowMissing = false } = {}) {
  const names = contracts.map(({ tableName }) => tableName);
  const placeholders = names.map(() => '?').join(',');
  const [tableRows] = await connection.execute(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME IN (${placeholders})`,
    names,
  );
  const existingNames = new Set(tableRows.map(({ TABLE_NAME: tableName }) => tableName.toLowerCase()));
  const tableMetadata = new Map(tableRows.map((row) => [row.TABLE_NAME.toLowerCase(), row]));
  const presentContracts = contracts.filter(({ tableName }) => existingNames.has(tableName));
  const absentNames = contracts.filter(({ tableName }) => !existingNames.has(tableName)).map(({ tableName }) => tableName);
  const problems = [];
  if (!allowMissing && absentNames.length) {
    for (const table of absentNames) problems.push({ table, issue: 'table_missing' });
  }
  if (!presentContracts.length) {
    if (problems.length) throw createSchemaConflict(problems);
    return;
  }

  const presentNames = presentContracts.map(({ tableName }) => tableName);
  const presentPlaceholders = presentNames.map(() => '?').join(',');
  const [columnRows] = await connection.execute(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${presentPlaceholders})`,
    presentNames,
  );
  const [indexRows] = await connection.execute(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${presentPlaceholders}) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    presentNames,
  );
  const [foreignKeyRows] = await connection.execute(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${presentPlaceholders}) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    presentNames,
  );

  const columnsByTable = groupRows(columnRows, ['TABLE_NAME']);
  const indexesByTable = groupRows(indexRows, ['TABLE_NAME', 'INDEX_NAME']);
  const foreignKeysByTable = groupRows(foreignKeyRows, ['TABLE_NAME', 'CONSTRAINT_NAME']);
  for (const contract of presentContracts) {
    const tableName = contract.tableName;
    const actualTable = tableMetadata.get(tableName);
    if (actualTable.ENGINE?.toLowerCase() !== contract.engine || !actualTable.TABLE_COLLATION?.toLowerCase().startsWith(contract.characterSet)) {
      problems.push({
        table: tableName,
        issue: 'table_engine_or_charset_mismatch',
        expected: { engine: contract.engine, characterSet: contract.characterSet },
        actual: { engine: actualTable.ENGINE?.toLowerCase() ?? null, collation: actualTable.TABLE_COLLATION?.toLowerCase() ?? null },
      });
    }
    const actualColumnRows = columnsByTable.get(tableName) ?? [];
    const actualColumns = new Map(actualColumnRows.map((row) => [row.COLUMN_NAME.toLowerCase(), row]));
    const expectedColumns = new Set(contract.columns.keys());
    for (const columnName of expectedColumns) {
      const expected = contract.columns.get(columnName);
      const actual = actualColumns.get(columnName);
      if (!actual) {
        problems.push({ table: tableName, issue: 'column_missing', column: columnName });
        continue;
      }
      const actualNullable = actual.IS_NULLABLE === 'YES';
      const actualAutoIncrement = /\bauto_increment\b/i.test(actual.EXTRA ?? '');
      if (actual.COLUMN_TYPE.toLowerCase() !== expected.type || actualNullable !== expected.nullable || actualAutoIncrement !== expected.autoIncrement) {
        problems.push({
          table: tableName,
          issue: 'column_definition_mismatch',
          column: columnName,
          expected: { type: expected.type, nullable: expected.nullable, autoIncrement: expected.autoIncrement },
          actual: { type: actual.COLUMN_TYPE.toLowerCase(), nullable: actualNullable, autoIncrement: actualAutoIncrement },
        });
      }
    }
    for (const columnName of actualColumns.keys()) {
      if (!expectedColumns.has(columnName)) problems.push({ table: tableName, issue: 'unexpected_column', column: columnName });
    }

    const actualPrimary = (indexesByTable.get(`${tableName}.PRIMARY`) ?? [])
      .sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX))
      .map(({ COLUMN_NAME: column }) => column.toLowerCase());
    if (JSON.stringify(actualPrimary) !== JSON.stringify(contract.primaryKey)) {
      problems.push({ table: tableName, issue: 'primary_key_mismatch', expected: contract.primaryKey, actual: actualPrimary });
    }

    for (const [indexName, expected] of contract.indexes) {
      const actualRows = (indexesByTable.get(`${tableName}.${indexName}`) ?? [])
        .sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX));
      const actualColumns = actualRows.map(({ COLUMN_NAME: column }) => column.toLowerCase());
      const actualUnique = actualRows.length > 0 && Number(actualRows[0].NON_UNIQUE) === 0;
      if (!actualRows.length || actualUnique !== expected.unique || JSON.stringify(actualColumns) !== JSON.stringify(expected.columns)) {
        problems.push({ table: tableName, issue: 'index_mismatch', index: indexName, expected, actual: { unique: actualUnique, columns: actualColumns } });
      }
    }

    const expectedForeignKeys = contract.foreignKeys;
    const actualForeignKeys = new Map();
    for (const [key, rows] of foreignKeysByTable) {
      if (!key.startsWith(`${tableName}.`)) continue;
      actualForeignKeys.set(key.slice(tableName.length + 1).toLowerCase(), rows.sort((left, right) => Number(left.ORDINAL_POSITION) - Number(right.ORDINAL_POSITION)));
    }
    for (const [constraintName, expected] of expectedForeignKeys) {
      const actualRows = actualForeignKeys.get(constraintName) ?? [];
      const actual = actualRows.length ? {
        columns: actualRows.map(({ COLUMN_NAME: column }) => column.toLowerCase()),
        referencedTable: actualRows[0].REFERENCED_TABLE_NAME.toLowerCase(),
        referencedColumns: actualRows.map(({ REFERENCED_COLUMN_NAME: column }) => column.toLowerCase()),
      } : null;
      if (!actual || actual.referencedTable !== expected.referencedTable || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns) || JSON.stringify(actual.referencedColumns) !== JSON.stringify(expected.referencedColumns)) {
        problems.push({ table: tableName, issue: 'foreign_key_mismatch', constraint: constraintName, expected, actual });
      }
      actualForeignKeys.delete(constraintName);
    }
    for (const constraintName of actualForeignKeys.keys()) {
      problems.push({ table: tableName, issue: 'unexpected_foreign_key', constraint: constraintName });
    }
  }
  if (problems.length) throw createSchemaConflict(problems);
}

function createSchemaConflict(problems) {
  const error = new Error('Struktur tabel tidak sesuai dengan kontrak migration; proses dihentikan tanpa memperbaiki atau menimpa tabel.');
  error.name = 'MigrationSchemaConflictError';
  error.problems = problems;
  return error;
}

let connection;
let lockAcquired = false;
try {
  const pool = getDatabasePool();
  connection = await pool.getConnection();
  const [lockRows] = await connection.execute("SELECT GET_LOCK('dashboard_funding_schema_migrations', 10) AS acquired");
  lockAcquired = Number(lockRows[0]?.acquired) === 1;
  if (!lockAcquired) throw new Error('Tidak berhasil memperoleh migration lock.');

  await connection.query(`CREATE TABLE IF NOT EXISTS dashboard_schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    migration_name VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await verifyMigrationTables(connection, [migrationLedgerContract]);

  const [appliedRows] = await connection.execute('SELECT version, migration_name, checksum FROM dashboard_schema_migrations');
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row]));
  const results = [];
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum || existing.migration_name !== migration.name) {
        throw new Error(`Checksum migrasi versi ${migration.version} berbeda; migrasi dihentikan.`);
      }
      await verifyMigrationTables(connection, migration.contracts);
      results.push({ version: migration.version, name: migration.name, status: 'already_applied', schemaVerified: true });
      continue;
    }

    await verifyMigrationTables(connection, migration.contracts, { allowMissing: true });
    for (const statement of migration.statements) await connection.query(statement);
    await verifyMigrationTables(connection, migration.contracts);
    await connection.execute(
      'INSERT INTO dashboard_schema_migrations (version, migration_name, checksum) VALUES (?, ?, ?)',
      [migration.version, migration.name, migration.checksum],
    );
    results.push({ version: migration.version, name: migration.name, status: 'applied', schemaVerified: true });
  }
  console.log(JSON.stringify({
    status: 'ok',
    migrations: results,
    schema: 'metadata, import controls, dimensions, staging, and domain facts; no business rows imported',
  }, null, 2));
} catch (error) {
  const safeError = getDatabaseErrorInfo(error);
  console.error(JSON.stringify({
    status: 'failed',
    category: error?.name === 'MigrationSchemaConflictError' ? 'schema_conflict' : safeError.category,
    code: safeError.code,
    ...(safeError.missingVariables ? { missingVariables: safeError.missingVariables } : {}),
    ...(error?.name === 'MigrationSchemaConflictError' ? { problems: error.problems } : {}),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (connection) {
    if (lockAcquired) {
      try { await connection.execute("SELECT RELEASE_LOCK('dashboard_funding_schema_migrations')"); } catch { /* connection is closing */ }
    }
    connection.release();
  }
  await closeDatabasePool();
}
