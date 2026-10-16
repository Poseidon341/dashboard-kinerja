import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertAssignmentSnapshotMatches,
  executeRmftImport,
  prepareRmftSnapshot,
  RMFT_PARSER_VERSION,
} from '../server/imports/rmft-importer.mjs';
import { assertExpectedImportTarget } from '../server/imports/mysql-uker-repository.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const workbookPath = process.env.DASHBOARD_TEST_WORKBOOK_PATH || new URL('../data/import/dashboard_funding.xlsx', import.meta.url);
const [rmftWorkbook, officeWorkbook] = await Promise.all([
  readDashboardWorkbookSheet(workbookPath, 'rmft_list', { expectedHeaders: ['PN', 'Nama', 'JG', 'Jabatan', 'Kode Uker'] }),
  readDashboardWorkbookSheet(workbookPath, 'uker_list', { expectedHeaders: ['BRANCH CODE'] }),
]);
const rmftBytes = rmftWorkbook.recordsJson;
const officeBytes = officeWorkbook.recordsJson;
const officeRecords = JSON.parse(officeBytes.toString('utf8'));
const officeCodes = new Set(officeRecords.map((row) => String(row['BRANCH CODE'])));
const prepared = prepareRmftSnapshot(rmftBytes, {
  knownOfficeCodes: officeCodes, checksum: rmftWorkbook.checksum, sourceSizeBytes: rmftWorkbook.sourceSizeBytes,
  expectedSnapshot: { records: 190, uniqueUnitCodes: 59, unresolved854: 0 },
});

test('snapshot RMFT Excel adalah snapshot 190 baris yang berbeda dari snapshot JSON lama', () => {
  assert.equal(prepared.errors.length, 0);
  assert.equal(prepared.rows.length, 190);
  assert.equal(prepared.counts.total, 190);
  assert.equal(prepared.counts.uniquePn, 190);
  assert.equal(prepared.counts.uniqueUnitCodes, 59);
  assert.equal(prepared.counts.unresolvedByCode['854'] ?? 0, 0);
  assert.equal(new Set(prepared.rows.map((row) => row.pn)).size, 190);
  assert.equal(prepared.checksum, rmftWorkbook.checksum);
  assert.equal(prepared.sourceSizeBytes, rmftWorkbook.sourceSizeBytes);
  assert.equal(prepared.rows.every((row) => typeof row.pn === 'string' && typeof row.unitCode === 'string'), true);
});

test('adapter hanya menandai kantor unresolved bila kode exact tidak ada di master', () => {
  const unresolved = prepared.rows.filter((row) => row.mappingStatus === 'unresolved');
  assert.ok(unresolved.every((row) => !officeCodes.has(row.unitCode)));
  assert.equal(unresolved.length, 0);
  assert.equal(prepared.rows.every((row) => officeCodes.has(row.unitCode)), true);
});

test('raw record utuh dan nomor baris mengikuti posisi array, bukan kolom No', () => {
  const first = prepared.rows[0];
  assert.equal(first.rowNumber, 1);
  assert.deepEqual(JSON.parse(first.rawRecord), prepared.records[0]);
  assert.equal(typeof JSON.parse(first.rawRecord).PN, 'number');
  assert.equal(typeof JSON.parse(first.rawRecord)['Kode Uker'], 'number');
  const records = JSON.parse(rmftBytes.toString('utf8'));
  records[0].No = 'not-the-row-number';
  const altered = prepareRmftSnapshot(Buffer.from(JSON.stringify(records)), { knownOfficeCodes: officeCodes, strictSnapshot: false });
  assert.equal(altered.rows[0].rowNumber, 1);
  assert.equal(JSON.parse(altered.rows[0].rawRecord).No, 'not-the-row-number');
});

test('kode kantor hanya terselesaikan dengan kode exact dari master kantor', () => {
  const exact = prepareRmftSnapshot(rmftBytes, { knownOfficeCodes: officeCodes, strictSnapshot: false });
  const withoutOneOffice = new Set([...officeCodes].filter((code) => code !== prepared.rows[0].unitCode));
  const missingMaster = prepareRmftSnapshot(rmftBytes, { knownOfficeCodes: withoutOneOffice, strictSnapshot: false });
  const validCode = prepared.rows[0].unitCode;
  assert.equal(exact.rows.find((row) => row.unitCode === validCode).mappingStatus, 'resolved');
  assert.equal(missingMaster.rows.find((row) => row.unitCode === validCode).mappingStatus, 'unresolved');
  assert.equal(prepared.rows.filter((row) => !officeCodes.has(row.unitCode)).every((row) => row.mappingStatus === 'unresolved'), true);
});

test('nilai yang melebihi kolom skema ditandai dan tidak dipotong', () => {
  const records = JSON.parse(rmftBytes.toString('utf8'));
  records[0].PN = 'P'.repeat(33);
  records[1]['Kode Uker'] = 'U'.repeat(33);
  const invalid = prepareRmftSnapshot(Buffer.from(JSON.stringify(records)), { knownOfficeCodes: officeCodes, strictSnapshot: false });
  assert.equal(invalid.rows[0].pn.length, 33);
  assert.equal(invalid.rows[1].unitCode.length, 33);
  assert.equal(invalid.errors.some((error) => error.rowNumber === 1 && error.fieldName === 'dimension_pn' && error.code === 'value_exceeds_column_length'), true);
  assert.equal(invalid.errors.some((error) => error.rowNumber === 2 && error.fieldName === 'assignment_unit_code' && error.code === 'value_exceeds_column_length'), true);
});

test('target impor mempertahankan allowlist host, port, dan database eksplisit', () => {
  assert.doesNotThrow(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertExpectedImportTarget({ host: '127.0.0.1', port: 3308, database: 'other_db' }), /Target impor/);
  assert.throws(() => assertExpectedImportTarget({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }), /Target impor/);
});

class FakeRmftRepository {
  batches = new Map();
  staging = [];
  dimensions = new Map();
  assignments = [];
  publications = [];
  activeBatch = null;
  failNextPublish = false;

  async withSourceLock(_key, callback) { return callback(); }

  async reserveBatch({ checksum, parserVersion, sourceRowCount }) {
    const key = `${checksum}:${parserVersion}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const batchId = `batch-${this.batches.size + 1}`;
      batch = { batchId, status: 'loading', sourceRowCount, objectId: `object-${batchId}`, observedAt: `time-${batchId}` };
      this.batches.set(key, batch);
    }
    return { ...batch, alreadyPublished: batch.status === 'completed' };
  }

  async publishSnapshot({ batch, snapshot }) {
    const expected = snapshot.rows.map((row) => ({
      rmft_id: row.pn,
      office_id: snapshot.knownOfficeCodes.includes(row.unitCode) ? row.unitCode : null,
      source_unit_code: row.unitCode,
      mapping_status: snapshot.knownOfficeCodes.includes(row.unitCode) ? 'resolved' : 'unresolved',
    }));
    if (new Set(expected.map((row) => row.rmft_id)).size !== expected.length) throw new Error('Duplicate PN assignment.');
    const current = this.assignments.filter((row) => row.objectId === batch.objectId && row.observedAt === batch.observedAt);
    if (current.length) assertAssignmentSnapshotMatches(expected, current);
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('Simulated transaction failure');
    }
    this.staging.push(...snapshot.rows.map((row) => `${batch.objectId}:${row.rowNumber}`));
    for (const row of snapshot.rows) this.dimensions.set(row.pn, { pn: row.pn, name: row.name, grade: row.grade, title: row.jobTitle });
    if (!current.length) this.assignments.push(...expected.map((row) => ({ ...row, objectId: batch.objectId, observedAt: batch.observedAt })));
    this.activeBatch = batch.batchId;
    this.publications.push(batch.batchId);
    const stored = [...this.batches.values()].find((entry) => entry.batchId === batch.batchId);
    stored.status = 'completed';
  }

  async markFailed(batchId) {
    for (const batch of this.batches.values()) if (batch.batchId === batchId && batch.status !== 'completed') batch.status = 'failed';
  }
}

test('retry checksum dan parser identik memakai publikasi dan assignment yang sama', async () => {
  const repository = new FakeRmftRepository();
  const first = await executeRmftImport(prepared, repository);
  const second = await executeRmftImport(prepared, repository);
  assert.equal(first.status, 'published');
  assert.equal(second.status, 'already_published');
  assert.equal(first.batchId, second.batchId);
  assert.equal(repository.staging.length, 190);
  assert.equal(repository.dimensions.size, 190);
  assert.equal(repository.assignments.length, 190);
  assert.equal(repository.publications.length, 1);
  assert.equal(repository.assignments.filter((row) => row.office_id === null && row.mapping_status === 'unresolved').length, prepared.counts.unresolved);
});

test('checksum berbeda mempertahankan snapshot lama dan menerbitkan histori baru', async () => {
  const repository = new FakeRmftRepository();
  const first = await executeRmftImport(prepared, repository);
  const records = JSON.parse(rmftBytes.toString('utf8'));
  records[0].Jabatan = `${records[0].Jabatan} `;
  const changed = prepareRmftSnapshot(Buffer.from(JSON.stringify(records)), {
    knownOfficeCodes: officeCodes,
    expectedSnapshot: { records: 190, uniqueUnitCodes: 59, unresolved854: 0 },
  });
  assert.equal(changed.errors.length, 0);
  const next = await executeRmftImport(changed, repository, { parserVersion: RMFT_PARSER_VERSION });
  assert.notEqual(first.batchId, next.batchId);
  assert.equal(repository.batches.size, 2);
  assert.equal(repository.staging.length, 380);
  assert.equal(repository.assignments.length, 380);
  assert.equal(repository.publications.length, 2);
});

test('kegagalan transaksi tidak memublikasikan data dan retry melanjutkan batch yang sama', async () => {
  const repository = new FakeRmftRepository();
  repository.failNextPublish = true;
  await assert.rejects(executeRmftImport(prepared, repository), /Simulated transaction failure/);
  const failedBatch = [...repository.batches.values()][0];
  assert.equal(failedBatch.status, 'failed');
  assert.equal(repository.activeBatch, null);
  assert.equal(repository.assignments.length, 0);
  const retry = await executeRmftImport(prepared, repository);
  assert.equal(retry.batchId, failedBatch.batchId);
  assert.equal(retry.status, 'published');
  assert.equal(repository.assignments.length, 190);
});

test('assignment replay menerima baris sama, menolak duplikasi karena DDL tidak memiliki unique key assignment', () => {
  const expected = [{ rmft_id: 1, office_id: null, source_unit_code: '854', mapping_status: 'unresolved' }];
  assert.equal(assertAssignmentSnapshotMatches(expected, [...expected]), true);
  assert.throws(() => assertAssignmentSnapshotMatches(expected, [...expected, ...expected]), /assignment duplikat/);
  assert.throws(() => assertAssignmentSnapshotMatches(expected, [{ ...expected[0], office_id: 99, mapping_status: 'resolved' }]), /berbeda dari snapshot/);
});

test('natural key dan struktur staging/assignment sesuai migration aktual', async () => {
  const sql = await readFile(new URL('../server/migrations/002_dashboard_business_schema.sql', import.meta.url), 'utf8');
  const rmftDim = sql.match(/CREATE TABLE IF NOT EXISTS dashboard_dim_rmft \(([\s\S]*?)\) ENGINE=/)?.[1] ?? '';
  const assignment = sql.match(/CREATE TABLE IF NOT EXISTS dashboard_rmft_assignment \(([\s\S]*?)\) ENGINE=/)?.[1] ?? '';
  assert.match(rmftDim, /UNIQUE KEY uq_rmft_source_pn \(source_system, pn\)/);
  assert.match(sql, /UNIQUE KEY uq_stg_rmft_source_row \(object_id, source_row_number\)/);
  assert.doesNotMatch(assignment, /UNIQUE\s+KEY/i);
  assert.match(assignment, /office_id BIGINT UNSIGNED NULL/);
  assert.match(assignment, /source_unit_code VARCHAR\(32\) NULL/);
  assert.match(assignment, /CONSTRAINT fk_rmft_assignment_office FOREIGN KEY \(office_id\) REFERENCES dashboard_dim_office/);
});
