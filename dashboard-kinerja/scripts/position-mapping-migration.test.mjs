import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, runner, packageText, baseSchema] = await Promise.all([
  readFile(new URL('../server/migrations/003_position_staging_office_mapping.sql', import.meta.url), 'utf8'),
  readFile(new URL('../server/migrate.js', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../server/migrations/002_dashboard_business_schema.sql', import.meta.url), 'utf8'),
]);

test('migration 003 hanya menambah satu tabel baru dan tidak mengubah staging/raw rows', () => {
  const executableMigration = migration.replace(/^\s*--.*$/gm, '').trim();
  assert.match(executableMigration, /^CREATE TABLE IF NOT EXISTS dashboard_stg_position_office_mapping\s*\(/i);
  assert.equal((migration.match(/\bCREATE\s+TABLE\b/gi) || []).length, 1);
  assert.doesNotMatch(migration, /\b(ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
  assert.doesNotMatch(migration, /\b(raw_record|source_row_number)\b/i);
  assert.match(baseSchema, /CREATE TABLE IF NOT EXISTS dashboard_stg_position_row\s*\([\s\S]*?raw_record LONGTEXT NOT NULL[\s\S]*?source_row_number BIGINT UNSIGNED NOT NULL/);
});

test('mapping table has nullable office references and version/snapshot provenance', () => {
  assert.match(migration, /office_id BIGINT UNSIGNED NULL/);
  assert.match(migration, /office_version_id BIGINT UNSIGNED NULL/);
  assert.match(migration, /master_source_object_id BIGINT UNSIGNED NOT NULL/);
  assert.match(migration, /mapping_status VARCHAR\(24\) NOT NULL/);
  assert.match(migration, /PRIMARY KEY \(stg_position_id, master_source_object_id\)/);
  assert.match(migration, /FOREIGN KEY \(stg_position_id\) REFERENCES dashboard_stg_position_row \(stg_position_id\)/);
  assert.match(migration, /FOREIGN KEY \(master_source_object_id\) REFERENCES dashboard_import_object \(object_id\)/);
  assert.match(migration, /FOREIGN KEY \(office_id\) REFERENCES dashboard_dim_office \(office_id\)/);
  assert.match(migration, /FOREIGN KEY \(office_version_id\) REFERENCES dashboard_dim_office_version \(office_version_id\)/);
});

test('migration runner akan mengurutkan dan memvalidasi migration 003 dengan kontrak yang ada', () => {
  assert.match(runner, /\^\\d\{3\}_\[a-z0-9_\]\+\\\.sql\$/i);
  assert.match(runner, /onlyAdditiveCreateTables/);
  assert.match(runner, /parseCreateTableContract\(/);
  assert.match(runner, /unexpected_column/);
  assert.match(runner, /foreign_key_mismatch/);
  assert.match(runner, /index_mismatch/);
  assert.match(runner, /if \(!applyRequested\)[\s\S]*databaseConnection: false/);
  const scripts = JSON.parse(packageText).scripts;
  assert.equal(scripts['db:migrate'], 'node server/migrate.js');
});
