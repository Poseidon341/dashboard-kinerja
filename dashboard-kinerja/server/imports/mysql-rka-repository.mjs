import { randomUUID } from 'node:crypto';
import { assertExpectedImportTarget } from './mysql-uker-repository.mjs';

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type', 'display_name', 'source_location'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'finished_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'source_size_bytes', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count', 'metadata'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['batch_id', 'severity', 'issue_code', 'object_name', 'source_row_number', 'field_name', 'safe_message', 'context'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_dim_rka_category: ['rka_category_id', 'source_system', 'source_category', 'observed_at', 'source_object_id'],
  dashboard_stg_rka_row: ['batch_id', 'object_id', 'source_row_number', 'source_no_urut', 'source_rka_key', 'source_category', 'source_unit_code', 'raw_month_values', 'raw_record', 'parse_status', 'mapping_status'],
});

const REQUIRED_TYPES = Object.freeze({
  'dashboard_source_registry.source_key': 'varchar(100)',
  'dashboard_import_batch.source_checksum': 'char(64)',
  'dashboard_import_batch_detail.parser_version': 'varchar(64)',
  'dashboard_import_object_identity.object_key': 'varchar(255)',
  'dashboard_import_idempotency.parser_version': 'varchar(64)',
  'dashboard_import_issue.issue_code': 'varchar(100)',
  'dashboard_import_issue.field_name': 'varchar(255)',
  'dashboard_dim_office.source_system': 'varchar(50)',
  'dashboard_dim_office.source_code': 'varchar(32)',
  'dashboard_dim_rka_category.source_system': 'varchar(50)',
  'dashboard_dim_rka_category.source_category': 'varchar(255)',
  'dashboard_dim_rka_category.observed_at': 'datetime(3)',
  'dashboard_stg_rka_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_rka_row.source_no_urut': 'varchar(64)',
  'dashboard_stg_rka_row.source_rka_key': 'varchar(255)',
  'dashboard_stg_rka_row.source_category': 'varchar(255)',
  'dashboard_stg_rka_row.source_unit_code': 'varchar(64)',
  'dashboard_stg_rka_row.raw_month_values': 'json',
  'dashboard_stg_rka_row.raw_record': 'longtext',
  'dashboard_stg_rka_row.parse_status': 'varchar(24)',
  'dashboard_stg_rka_row.mapping_status': 'varchar(24)',
});

export function assertRkaTestTarget(config) {
  assertExpectedImportTarget(config);
  if (config.database !== 'dashboard_funding_test') {
    const error = new Error('Importer RKA tahap ini hanya diizinkan ke dashboard_funding_test.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}

function valuesFor(rows, columns) {
  return {
    placeholders: rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', '),
    values: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export class MysqlRkaRepository {
  constructor(pool, config) {
    assertRkaTestTarget(config);
    this.pool = pool;
    this.database = config.database;
    this.connection = null;
  }

  async withSourceLock(sourceKey, callback) {
    const connection = await this.pool.getConnection();
    this.connection = connection;
    let acquired = false;
    try {
      const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
      if (databaseRows[0]?.database_name !== this.database) throw new Error('Database aktif tidak sesuai target impor yang diizinkan.');
      const lockName = `dashboard_import:${sourceKey}`;
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
      acquired = Number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new Error('Tidak berhasil memperoleh lock impor RKA.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (acquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* released with connection */ }
      }
      this.connection = null;
      connection.release();
    }
  }

  async verifySchema() {
    const connection = this.connection;
    const tables = Object.keys(REQUIRED_COLUMNS);
    const [columnRows] = await connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables,
    );
    const columns = new Map();
    const types = new Map();
    for (const row of columnRows) {
      if (!columns.has(row.TABLE_NAME)) columns.set(row.TABLE_NAME, new Set());
      columns.get(row.TABLE_NAME).add(row.COLUMN_NAME);
      types.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE).toLowerCase());
    }
    const missing = [];
    for (const [table, names] of Object.entries(REQUIRED_COLUMNS)) {
      for (const name of names) if (!columns.get(table)?.has(name)) missing.push(`${table}.${name}`);
    }
    if (missing.length) throw new Error(`Skema impor RKA tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(REQUIRED_TYPES).filter(([column, type]) => types.get(column) !== type).map(([column]) => column);
    if (wrongTypes.length) throw new Error(`Tipe kolom impor RKA tidak sesuai: ${wrongTypes.join(', ')}.`);

    const [uniqueRows] = await connection.execute(
      `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND TABLE_NAME IN
       ('dashboard_source_registry','dashboard_import_object_identity','dashboard_import_idempotency','dashboard_stg_rka_row')
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );
    const unique = new Map();
    for (const row of uniqueRows) {
      const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
      if (!unique.has(key)) unique.set(key, []);
      unique.get(key).push(row.COLUMN_NAME);
    }
    const expected = [
      ['dashboard_source_registry.uq_dashboard_source_registry_source_key', ['source_key']],
      ['dashboard_import_object_identity.uq_object_identity_batch_key', ['batch_id', 'object_key']],
      ['dashboard_import_idempotency.uq_import_content_parser', ['source_id', 'source_checksum', 'parser_version']],
      ['dashboard_stg_rka_row.uq_stg_rka_source_row', ['object_id', 'source_row_number']],
    ];
    const missingUnique = expected.filter(([name, cols]) => JSON.stringify(unique.get(name) ?? []) !== JSON.stringify(cols)).map(([name]) => name);
    if (missingUnique.length) throw new Error(`Unique key impor RKA tidak sesuai: ${missingUnique.join(', ')}.`);

    const [foreignRows] = await connection.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE()
       AND REFERENCED_TABLE_NAME IS NOT NULL AND CONSTRAINT_NAME IN
       ('fk_dashboard_import_batch_source','fk_batch_detail_batch','fk_dashboard_import_object_batch',
        'fk_object_identity_object','fk_object_identity_batch','fk_idempotency_source','fk_idempotency_batch',
        'fk_dashboard_import_issue_batch','fk_rka_category_object','fk_stg_rka_batch','fk_stg_rka_object')`,
    );
    const found = new Set(foreignRows.map((row) => row.CONSTRAINT_NAME));
    const requiredForeign = [
      'fk_dashboard_import_batch_source', 'fk_batch_detail_batch', 'fk_dashboard_import_object_batch',
      'fk_object_identity_object', 'fk_object_identity_batch', 'fk_idempotency_source', 'fk_idempotency_batch',
      'fk_dashboard_import_issue_batch', 'fk_rka_category_object', 'fk_stg_rka_batch', 'fk_stg_rka_object',
    ];
    const missingForeign = requiredForeign.filter((name) => !found.has(name));
    if (missingForeign.length) throw new Error(`Foreign key impor RKA tidak tersedia: ${missingForeign.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, objectKey, parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary, sourceSystem }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor RKA harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute('SELECT source_id, source_type FROM dashboard_source_registry WHERE source_key = ? FOR UPDATE', [sourceKey]);
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [insertSource] = await connection.execute(
          'INSERT INTO dashboard_source_registry (source_key, source_type, display_name, source_location) VALUES (?, ?, ?, ?)',
          [sourceKey, 'json_file', 'Target RKA (staging)', 'data/source-archive/tabel_rka.json'],
        );
        sourceId = insertSource.insertId;
      } else if (sourceRows[0].source_type !== 'json_file') throw new Error('Registry sumber RKA memiliki source_type berbeda.');

      const [idemRows] = await connection.execute(
        `SELECT batch_id FROM dashboard_import_idempotency
         WHERE source_id = ? AND source_checksum = ? AND parser_version = ? FOR UPDATE`, [sourceId, checksum, parserVersion],
      );
      let batchId = idemRows[0]?.batch_id;
      let status;
      let observedAt;
      if (batchId) {
        const [batchRows] = await connection.execute(
          `SELECT status, source_checksum, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_import_batch WHERE batch_id = ? AND source_id = ? FOR UPDATE`, [batchId, sourceId],
        );
        if (!batchRows.length || batchRows[0].source_checksum !== checksum) throw new Error('Idempotency batch RKA tidak konsisten.');
        status = batchRows[0].status;
        observedAt = batchRows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(
          `INSERT INTO dashboard_import_batch (batch_id, source_id, status, source_checksum, rows_read, rows_staged, rows_rejected)
           VALUES (?, ?, 'loading', ?, 0, 0, 0)`, [batchId, sourceId, checksum],
        );
        const [timeRows] = await connection.execute(`SELECT DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_import_batch WHERE batch_id = ?`, [batchId]);
        observedAt = timeRows[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan waktu observasi batch RKA.');
        await connection.execute(
          'INSERT INTO dashboard_import_batch_detail (batch_id, parser_version, source_size_bytes, validation_summary) VALUES (?, ?, ?, ?)',
          [batchId, parserVersion, sourceSizeBytes, JSON.stringify(validationSummary)],
        );
        status = 'loading';
      }

      const [identityRows] = await connection.execute(
        `SELECT oi.object_id, o.object_name, o.object_type, o.source_checksum, o.source_row_count
         FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id = oi.object_id
         WHERE oi.batch_id = ? AND oi.object_key = ? FOR UPDATE`, [batchId, objectKey],
      );
      let objectId;
      if (identityRows.length) {
        const existing = identityRows[0];
        if (existing.object_name !== objectKey || existing.object_type !== 'json_file' || existing.source_checksum !== checksum) throw new Error('Identitas object RKA tidak konsisten.');
        objectId = existing.object_id;
        if (Number(existing.source_row_count) !== sourceRowCount) {
          await connection.execute('UPDATE dashboard_import_object SET source_row_count = ? WHERE object_id = ?', [sourceRowCount, objectId]);
        }
      } else {
        const [insertObject] = await connection.execute(
          `INSERT INTO dashboard_import_object (batch_id, object_name, object_type, source_checksum, source_row_count, metadata)
           VALUES (?, ?, 'json_file', ?, ?, ?)`,
          [batchId, objectKey, checksum, sourceRowCount, JSON.stringify({ sourceSystem })],
        );
        objectId = insertObject.insertId;
        await connection.execute('INSERT INTO dashboard_import_object_identity (object_id, batch_id, object_key) VALUES (?, ?, ?)', [objectId, batchId, objectKey]);
      }
      if (!idemRows.length) {
        await connection.execute('INSERT INTO dashboard_import_idempotency (source_id, source_checksum, parser_version, batch_id) VALUES (?, ?, ?, ?)', [sourceId, checksum, parserVersion, batchId]);
      }

      const [published] = await connection.execute(
        `SELECT COUNT(*) AS count FROM dashboard_import_batch WHERE batch_id = ? AND status = 'completed'`, [batchId],
      );
      if (Number(published[0]?.count) && status === 'completed') {
        const [stageRows] = await connection.execute('SELECT COUNT(*) AS count FROM dashboard_stg_rka_row WHERE object_id = ?', [objectId]);
        const [categoryRows] = await connection.execute('SELECT COUNT(*) AS count FROM dashboard_dim_rka_category WHERE source_object_id = ?', [objectId]);
        if (Number(stageRows[0]?.count) !== sourceRowCount || Number(categoryRows[0]?.count) !== Number(validationSummary.categories)) {
          throw new Error('Batch RKA completed tidak sesuai jumlah staging/kategori yang diharapkan.');
        }
        await connection.commit();
        return { batchId, objectId, observedAt, alreadyStaged: true };
      }
      await connection.execute("UPDATE dashboard_import_batch SET status='loading', finished_at=NULL WHERE batch_id=?", [batchId]);
      await connection.commit();
      return { batchId, objectId, observedAt, alreadyStaged: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async stageSnapshot({ batch, snapshot, sourceSystem }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor RKA harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const codes = [...new Set(snapshot.rows.map((row) => row.unitCodeKey).filter(Boolean))];
      const officeCodesFound = new Set();
      for (const part of chunk(codes, 500)) {
        const [rows] = await connection.execute(
          `SELECT source_code FROM dashboard_dim_office WHERE source_system='uker_list_json' AND source_code IN (${part.map(() => '?').join(',')})`, part,
        );
        for (const row of rows) officeCodesFound.add(String(row.source_code));
      }
      const missingOfficeCodes = codes.filter((code) => !officeCodesFound.has(code));
      if (missingOfficeCodes.length) throw new Error(`Kode KODE UKER belum seluruhnya tersedia pada master berkode sumber uker_list_json (${missingOfficeCodes.length} kode).`);

      const stageRows = snapshot.rows.map((row) => ({
        batch_id: batch.batchId, object_id: batch.objectId, source_row_number: row.rowNumber,
        source_no_urut: row.sourceNoUrut, source_rka_key: row.sourceRkaKey, source_category: row.sourceCategory,
        source_unit_code: row.sourceUnitCode, raw_month_values: row.rawMonthValues, raw_record: row.rawRecord,
        parse_status: row.parseStatus, mapping_status: row.mappingStatus,
      }));
      const stageColumns = ['batch_id', 'object_id', 'source_row_number', 'source_no_urut', 'source_rka_key', 'source_category', 'source_unit_code', 'raw_month_values', 'raw_record', 'parse_status', 'mapping_status'];
      for (const part of chunk(stageRows, 200)) {
        const values = valuesFor(part, stageColumns);
        await connection.execute(
          `INSERT INTO dashboard_stg_rka_row (${stageColumns.join(',')}) VALUES ${values.placeholders}
           ON DUPLICATE KEY UPDATE source_no_urut=VALUES(source_no_urut), source_rka_key=VALUES(source_rka_key),
           source_category=VALUES(source_category), source_unit_code=VALUES(source_unit_code), raw_month_values=VALUES(raw_month_values),
           raw_record=VALUES(raw_record), parse_status=VALUES(parse_status), mapping_status=VALUES(mapping_status)`, values.values,
        );
      }

      const categoryNames = [...new Set(snapshot.categories)];
      const [existingCategories] = await connection.execute(
        'SELECT source_category FROM dashboard_dim_rka_category WHERE source_system=? AND observed_at=? AND source_object_id=?',
        [sourceSystem, batch.observedAt, batch.objectId],
      );
      const existingNames = new Set(existingCategories.map((row) => String(row.source_category)));
      const newNames = categoryNames.filter((name) => !existingNames.has(name));
      for (const part of chunk(newNames, 300)) {
        const categoryRows = part.map((name) => ({ source_system: sourceSystem, source_category: name, observed_at: batch.observedAt, source_object_id: batch.objectId }));
        const columns = ['source_system', 'source_category', 'observed_at', 'valid_from', 'valid_to', 'source_object_id'];
        const values = valuesFor(categoryRows.map((row) => ({ ...row, valid_from: null, valid_to: null })), columns);
        await connection.execute(`INSERT INTO dashboard_dim_rka_category (${columns.join(',')}) VALUES ${values.placeholders}`, values.values);
      }

      for (const error of snapshot.errors) {
        const code = `RKA_${String(error.code ?? 'VALIDATION').toUpperCase()}`.slice(0, 100);
        const [existing] = await connection.execute(
          `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code=? AND object_name=?
           AND source_row_number <=> ? AND field_name <=> ? LIMIT 1 FOR UPDATE`,
          [batch.batchId, code, 'tabel_rka.json', error.rowNumber ?? null, error.fieldName ?? null],
        );
        if (!existing.length) {
          await connection.execute(
            `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,source_row_number,field_name,safe_message,context)
             VALUES (?,'error',?,?,?,?,?,?)`,
            [batch.batchId, code, 'tabel_rka.json', error.rowNumber ?? null, error.fieldName ?? null, 'Baris sumber RKA gagal validasi; raw record tetap dipertahankan di staging.', JSON.stringify({ reason: error.code, ...(error.firstRowNumber ? { firstRowNumber: error.firstRowNumber } : {}) })],
          );
        }
      }

      const [counts] = await connection.execute(
        `SELECT COUNT(*) AS total, SUM(parse_status='valid') AS valid_rows, SUM(parse_status<>'valid') AS invalid_rows
         FROM dashboard_stg_rka_row WHERE object_id=?`, [batch.objectId],
      );
      const [categoryCount] = await connection.execute(
        'SELECT COUNT(*) AS total FROM dashboard_dim_rka_category WHERE source_object_id=? AND source_system=? AND observed_at=?',
        [batch.objectId, sourceSystem, batch.observedAt],
      );
      const invalidRows = Number(counts[0]?.invalid_rows ?? 0);
      const validationFailed = snapshot.errors.length > 0 || Number(counts[0]?.total) !== snapshot.rows.length
        || Number(counts[0]?.valid_rows) !== snapshot.rows.length || Number(categoryCount[0]?.total) !== categoryNames.length;
      if (Number(counts[0]?.total) !== snapshot.rows.length || Number(categoryCount[0]?.total) !== categoryNames.length) {
        throw new Error('Jumlah staging RKA atau kategori setelah insert tidak sesuai snapshot.');
      }
      if (validationFailed && snapshot.errors.length === 0) {
        const [existing] = await connection.execute(
          `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='RKA_STAGING_VALIDATION_FAILED'
           AND object_name=? AND source_row_number IS NULL AND field_name IS NULL LIMIT 1 FOR UPDATE`,
          [batch.batchId, 'tabel_rka.json'],
        );
        if (!existing.length) await connection.execute(
          `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context)
           VALUES (?,'error','RKA_STAGING_VALIDATION_FAILED',?,?,?)`,
          [batch.batchId, 'tabel_rka.json', 'Validasi agregat staging RKA tidak cocok dengan snapshot sumber.', JSON.stringify({ sourceRows: snapshot.rows.length, stagedRows: Number(counts[0]?.total), validRows: Number(counts[0]?.valid_rows), categoryRows: Number(categoryCount[0]?.total), expectedCategories: categoryNames.length })],
        );
      }

      await connection.execute(
        `UPDATE dashboard_import_batch SET status=?, finished_at=CURRENT_TIMESTAMP(3), rows_read=?, rows_staged=?, rows_rejected=? WHERE batch_id=?`,
        [validationFailed ? 'failed' : 'completed', snapshot.rows.length, Number(counts[0]?.total), invalidRows, batch.batchId],
      );
      await connection.execute(
        'UPDATE dashboard_import_batch_detail SET validation_summary=? WHERE batch_id=?',
        [JSON.stringify({ ...snapshot.summary, categoryRows: Number(categoryCount[0]?.total), errorCount: snapshot.errors.length, stagingValidated: !validationFailed, publication: 'none' }), batch.batchId],
      );
      await connection.commit();
      return { status: validationFailed ? 'validation_failed' : 'staged', batchId: batch.batchId, rows: Number(counts[0]?.total), categories: Number(categoryCount[0]?.total), rejected: invalidRows };
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async markFailed(batchId) {
    const connection = this.connection;
    if (!connection) return;
    await connection.beginTransaction();
    try {
      const [batches] = await connection.execute('SELECT status FROM dashboard_import_batch WHERE batch_id=? FOR UPDATE', [batchId]);
      if (!batches.length || batches[0].status === 'completed') { await connection.commit(); return; }
      await connection.execute("UPDATE dashboard_import_batch SET status='failed', finished_at=CURRENT_TIMESTAMP(3) WHERE batch_id=?", [batchId]);
      const [issues] = await connection.execute(
        `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='RKA_IMPORT_FAILED' AND object_name=? LIMIT 1 FOR UPDATE`,
        [batchId, 'tabel_rka.json'],
      );
      if (!issues.length) await connection.execute(
        `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context)
         VALUES (?,'error','RKA_IMPORT_FAILED',?,?,?)`,
        [batchId, 'tabel_rka.json', 'Impor RKA gagal sebelum validasi staging selesai.', JSON.stringify({ phase: 'staging' })],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
}
