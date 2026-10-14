import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { executeOfficeImport, prepareOfficeSnapshot, UKER_PARSER_VERSION } from '../server/imports/uker-importer.mjs';
import { assertExpectedImportTarget } from '../server/imports/mysql-uker-repository.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const workbook = await readDashboardWorkbookSheet(new URL('../data/import/dashboard_funding.xlsx', import.meta.url), 'uker_list', {
  expectedHeaders: ['BRANCH CODE', 'BRANCH', 'BRANCH TYPE', 'MAIN BRANCH CODE', 'AREA', 'MAIN BRANCH CLASS', 'Rural Urban'],
});
const sourceBytes = workbook.recordsJson;
const prepared = prepareOfficeSnapshot(sourceBytes);

test('snapshot sumber sesuai jumlah, kode unik, tipe, dan referensi parent yang diaudit', () => {
  assert.equal(prepared.errors.length, 0);
  assert.deepEqual(prepared.counts, { total: 611, KC: 46, KCP: 35, UNIT: 530 });
  assert.equal(new Set(prepared.rows.map((row) => row.code)).size, 611);
  assert.equal(prepared.rows.length, 611);
  assert.equal(prepared.rows.filter((row) => !prepared.rows.some((candidate) => candidate.code === row.mainCode)).length, 0);
  assert.equal(prepared.relationships.length, 586);
  assert.equal(prepared.relationships.some((edge) => edge.childCode === edge.parentCode), false);
  const officeType = new Map(prepared.rows.map((row) => [row.code, row.sourceType]));
  assert.equal(prepared.relationships.some((edge) => officeType.get(edge.childCode) === 'UNIT' && officeType.get(edge.parentCode) === 'KCP'), false);
  assert.equal(prepared.rows.every((row) => row.mappingStatus === 'resolved' && row.parseStatus === 'valid'), true);
});

test('adapter membaca sheet XLSX yang disetujui dan identitas snapshot memakai checksum workbook', () => {
  const snapshot = prepareOfficeSnapshot(workbook.recordsJson, { checksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes });
  assert.equal(workbook.sheetName, 'uker_list');
  assert.equal(workbook.rowCount, 611);
  assert.equal(snapshot.checksum, workbook.checksum);
  assert.equal(snapshot.sourceSizeBytes, workbook.sourceSizeBytes);
  assert.equal(UKER_PARSER_VERSION, 'uker-xlsx-v1');
});

test('kode dicocokkan sebagai teks dan raw record mempertahankan nilai sumber', () => {
  assert.equal(typeof prepared.rows[0].code, 'string');
  const raw = JSON.parse(prepared.rows[0].rawRecord);
  assert.equal(typeof raw['BRANCH CODE'], 'number');
  assert.equal(raw['BRANCH CODE'], Number(prepared.rows[0].code));
  assert.equal(prepared.rows[0].rowNumber, 1);
});

test('nilai yang melewati panjang kolom ditandai tanpa dipotong', () => {
  const rows = JSON.parse(sourceBytes.toString('utf8'));
  rows[0]['BRANCH CODE'] = 'X'.repeat(33);
  const invalid = prepareOfficeSnapshot(Buffer.from(JSON.stringify(rows)));
  assert.equal(invalid.rows[0].code.length, 33);
  assert.equal(invalid.errors.some((issue) => issue.rowNumber === 1 && issue.code === 'value_exceeds_column_length'), true);
  assert.equal(invalid.errors.some((issue) => issue.rowNumber === 1 && issue.fieldName === 'MAIN BRANCH CODE' && issue.code === 'unsupported_parent_relationship'), false);
});

test('target database dibatasi ke konfigurasi lokal yang disetujui', () => {
  assert.doesNotThrow(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }));
  assert.doesNotThrow(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertExpectedImportTarget({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }), /Target impor/);
  assert.throws(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3307, database: 'dashboard_funding_test' }), /Target impor/);
  assert.throws(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_prod' }), /Target impor/);
  assert.throws(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'other_db' }), /Target impor/);
});

class FakeRepository {
  batches = new Map();
  published = new Set();
  versions = [];
  relationships = [];
  stagingRows = [];
  activeBatch = null;
  failNextPublish = false;
  nextId = 1;

  async withSourceLock(_key, callback) { return callback(); }

  async reserveBatch({ checksum, parserVersion, sourceRowCount }) {
    const key = `${checksum}:${parserVersion}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { batchId: `batch-${this.nextId++}`, status: 'loading', sourceRowCount };
      this.batches.set(key, batch);
    }
    return { ...batch, alreadyPublished: this.published.has(batch.batchId) };
  }

  async publishSnapshot({ batch, snapshot }) {
    const staged = snapshot.rows.map((row) => `${batch.batchId}:${row.rowNumber}`);
    const versions = snapshot.rows.map((row) => `${batch.batchId}:${row.code}`);
    const relationships = snapshot.relationships.map((row) => `${batch.batchId}:${row.childCode}:${row.parentCode}`);
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('Simulated transactional failure');
    }
    this.stagingRows.push(...staged);
    this.versions.push(...versions);
    this.relationships.push(...relationships);
    this.activeBatch = batch.batchId;
    this.published.add(batch.batchId);
    for (const item of this.batches.values()) if (item.batchId === batch.batchId) item.status = 'completed';
  }

  async markFailed(batchId) {
    for (const item of this.batches.values()) if (item.batchId === batchId && item.status !== 'completed') item.status = 'failed';
  }
}

test('retry file dan parser identik tidak menggandakan versi, relasi, atau publikasi', async () => {
  const repository = new FakeRepository();
  const first = await executeOfficeImport(prepared, repository);
  const second = await executeOfficeImport(prepared, repository);
  assert.equal(first.status, 'published');
  assert.equal(second.status, 'already_published');
  assert.equal(first.batchId, second.batchId);
  assert.equal(repository.versions.length, 611);
  assert.equal(repository.relationships.length, 586);
  assert.equal(repository.stagingRows.length, 611);
  assert.equal(repository.published.size, 1);
});

test('checksum berbeda membuat snapshot baru dan mempertahankan snapshot sebelumnya', async () => {
  const repository = new FakeRepository();
  const first = await executeOfficeImport(prepared, repository);
  const changedRows = JSON.parse(sourceBytes.toString('utf8'));
  changedRows[0].AREA = `${changedRows[0].AREA} `;
  const changed = prepareOfficeSnapshot(Buffer.from(JSON.stringify(changedRows)));
  assert.equal(changed.errors.length, 0);
  const result = await executeOfficeImport(changed, repository, { parserVersion: UKER_PARSER_VERSION });
  assert.equal(result.status, 'published');
  assert.notEqual(result.batchId, first.batchId);
  assert.equal(repository.batches.size, 2);
  assert.equal(repository.versions.length, 1222);
  assert.equal(repository.relationships.length, 1172);
  assert.equal(repository.stagingRows.length, 1222);
  assert.equal(repository.published.size, 2);
  assert.equal([...repository.batches.values()].filter((batch) => batch.status === 'completed').length, 2);
});

test('kegagalan sebelum commit tidak memublikasikan batch dan retry memakai batch yang sama', async () => {
  const repository = new FakeRepository();
  repository.failNextPublish = true;
  await assert.rejects(executeOfficeImport(prepared, repository), /Simulated transactional failure/);
  const failedBatch = [...repository.batches.values()][0];
  assert.equal(failedBatch.status, 'failed');
  assert.equal(repository.activeBatch, null);
  assert.equal(repository.versions.length, 0);
  assert.equal(repository.stagingRows.length, 0);
  const retry = await executeOfficeImport(prepared, repository);
  assert.equal(retry.batchId, failedBatch.batchId);
  assert.equal(retry.status, 'published');
  assert.equal(repository.versions.length, 611);
  assert.equal(repository.stagingRows.length, 611);
});

test('DDL memiliki natural key staging/master dan constraint relasi yang dipakai importer', async () => {
  const migration = await readFile(new URL('../server/migrations/002_dashboard_business_schema.sql', import.meta.url), 'utf8');
  const metadata = await readFile(new URL('../server/migrations/001_import_metadata.sql', import.meta.url), 'utf8');
  assert.match(metadata, /UNIQUE KEY uq_dashboard_source_registry_source_key \(source_key\)/);
  assert.match(migration, /UNIQUE KEY uq_stg_office_source_row \(object_id, source_row_number\)/);
  assert.match(migration, /UNIQUE KEY uq_office_source_code \(source_system, source_code\)/);
  assert.match(migration, /UNIQUE KEY uq_office_version_observation \(office_id, observed_at\)/);
  assert.match(migration, /UNIQUE KEY uq_office_relationship_snapshot \(child_office_id, parent_office_id, relationship_type, observed_at\)/);
  assert.match(migration, /UNIQUE KEY uq_import_content_parser \(source_id, source_checksum, parser_version\)/);
  assert.match(migration, /CONSTRAINT fk_stg_office_batch FOREIGN KEY \(batch_id\) REFERENCES dashboard_import_batch/);
  assert.match(migration, /CONSTRAINT fk_stg_office_object FOREIGN KEY \(object_id\) REFERENCES dashboard_import_object/);
  assert.match(migration, /CONSTRAINT fk_office_version_office FOREIGN KEY \(office_id\) REFERENCES dashboard_dim_office/);
  assert.match(migration, /CONSTRAINT fk_office_relationship_parent FOREIGN KEY \(parent_office_id\) REFERENCES dashboard_dim_office/);
});
