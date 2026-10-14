import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  executeRkaStage, parseRkaDecimal, prepareRkaSnapshot, RKA_EXPECTED_ROWS, RKA_MONTHS, RKA_PARSER_VERSION,
} from '../server/imports/rka-importer.mjs';
import { assertRkaTestTarget } from '../server/imports/mysql-rka-repository.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const workbookPath = new URL('../data/import/dashboard_funding.xlsx', import.meta.url);
const recordsFrom = (bytes) => JSON.parse(bytes.toString('utf8'));
const codesFromMaster = (records) => new Set(records.map((row) => String(row['BRANCH CODE'])));

test('snapshot sumber berisi tepat 4.577 baris, 17 kategori, 589 kode kantor yang cocok, dan pasangan unit-kategori unik', async () => {
  const [rkaWorkbook, officeWorkbook] = await Promise.all([
    readDashboardWorkbookSheet(workbookPath, 'tabel_rka', { expectedHeaders: ['NO URUT', 'RKA KEY', 'MATA ANGGARAN', 'KODE UKER', ...RKA_MONTHS] }),
    readDashboardWorkbookSheet(workbookPath, 'uker_list', { expectedHeaders: ['BRANCH CODE'] }),
  ]);
  const snapshot = prepareRkaSnapshot(rkaWorkbook.recordsJson, {
    knownOfficeCodes: codesFromMaster(recordsFrom(officeWorkbook.recordsJson)),
    checksum: rkaWorkbook.checksum, sourceSizeBytes: rkaWorkbook.sourceSizeBytes,
  });
  assert.equal(snapshot.rows.length, RKA_EXPECTED_ROWS);
  assert.equal(snapshot.summary.categories, 17);
  assert.equal(snapshot.categories.length, 17);
  assert.equal(snapshot.summary.uniqueOfficeCodes, 589);
  assert.equal(snapshot.summary.officeCodesMatched, 589);
  assert.deepEqual(snapshot.summary.officeCodesUnmatched, []);
  assert.equal(snapshot.summary.duplicateUnitCategoryPairs, 0);
  assert.equal(snapshot.errors.length, 0);
  assert.ok(snapshot.rows.every((row, index) => row.rowNumber === index + 1));
  assert.ok(snapshot.rows.every((row) => row.mappingStatus === 'unresolved'));
  assert.equal(snapshot.checksum, rkaWorkbook.checksum);
  assert.equal(snapshot.sourceSizeBytes, rkaWorkbook.sourceSizeBytes);
  const firstRaw = JSON.parse(snapshot.rows[0].rawRecord);
  assert.equal(typeof firstRaw['KODE UKER'], 'number');
  assert.equal(typeof firstRaw.JAN, 'number');
});

test('raw record dan raw_month_values mempertahankan nilai sumber, termasuk token angka presisi tinggi', () => {
  const source = '[{"NO URUT":1,"RKA KEY":"K","MATA ANGGARAN":"Kategori","KODE UKER":"001","JAN":1234567890123.123456789012345,"FEB":"1.234,50","MAR":"","APR":"0"}]';
  const snapshot = prepareRkaSnapshot(Buffer.from(source), { knownOfficeCodes: new Set(['001']), strictSnapshot: false });
  assert.equal(snapshot.errors.length, 0);
  assert.equal(snapshot.rows[0].rowNumber, 1);
  assert.equal(snapshot.rows[0].rawRecord, source.slice(1, -1));
  assert.match(snapshot.rows[0].rawMonthValues, /"JAN":1234567890123\.123456789012345/);
  assert.equal(snapshot.rows[0].monthValues.JAN.decimalText, '1234567890123.123456789012345');
  assert.equal(snapshot.rows[0].monthValues.FEB.decimalText, '1234.5');
  assert.equal(snapshot.rows[0].monthValues.MAR.kind, 'blank');
  assert.equal(snapshot.rows[0].monthValues.APR.decimalText, '0');
});

test('parser membedakan kosong dan nol, serta deterministik untuk ribuan titik dan desimal koma', () => {
  assert.deepEqual(parseRkaDecimal(''), { kind: 'blank', decimalText: null });
  assert.equal(parseRkaDecimal('0').isZero, true);
  assert.equal(parseRkaDecimal('1.234.567,8900').decimalText, '1234567.89');
  assert.equal(parseRkaDecimal('-12,50').decimalText, '-12.5');
  assert.equal(parseRkaDecimal('1.23').kind, 'invalid');
  assert.equal(parseRkaDecimal('1.234,1234567890123456').reason, 'decimal_out_of_range');
});

test('preserves exact JSON decimal token rather than the rounded JavaScript number', () => {
  const snapshot = prepareRkaSnapshot(Buffer.from('[{"NO URUT":1,"RKA KEY":"K","MATA ANGGARAN":"C","KODE UKER":"1","JAN":9007199254740993.123456789012345}]'), {
    knownOfficeCodes: new Set(['1']), strictSnapshot: false,
  });
  assert.equal(snapshot.rows[0].monthValues.JAN.decimalText, '9007199254740993.123456789012345');
  assert.equal(snapshot.errors.length, 0);
});

test('menandai kode unit/kategori tidak cocok dan nilai di luar kapasitas tanpa memotong sumber mentah', () => {
  const row = {
    'NO URUT': 1, 'RKA KEY': 'K'.repeat(256), 'MATA ANGGARAN': 'Kategori', 'KODE UKER': 'UNKNOWN',
    ...Object.fromEntries(RKA_MONTHS.map((month) => [month, '999999999999999999999999,1'])),
  };
  const source = JSON.stringify([row]);
  const snapshot = prepareRkaSnapshot(Buffer.from(source), { knownOfficeCodes: new Set(['1']), strictSnapshot: false });
  assert.ok(snapshot.errors.some((error) => error.code === 'value_exceeds_column_length' && error.fieldName === 'RKA KEY'));
  assert.ok(snapshot.errors.some((error) => error.code === 'office_code_not_found_in_master'));
  assert.ok(snapshot.errors.some((error) => error.code === 'decimal_out_of_range'));
  assert.equal(snapshot.rows[0].sourceRkaKey, null);
  assert.equal(snapshot.rows[0].rawRecord, source.slice(1, -1));
  assert.equal(snapshot.rows[0].parseStatus, 'invalid');
});

class FakeStagingRepository {
  batches = new Map();
  staged = new Map();
  failNext = false;
  async withSourceLock(_key, callback) { return callback(this); }
  async reserveBatch({ checksum, parserVersion, sourceRowCount }) {
    const key = `${checksum}:${parserVersion}`;
    let batch = this.batches.get(key);
    if (batch?.status === 'completed') return { batchId: batch.id, objectId: batch.objectId, alreadyStaged: true };
    if (!batch) {
      batch = { id: `batch-${this.batches.size + 1}`, objectId: `object-${this.batches.size + 1}`, status: 'loading', sourceRowCount };
      this.batches.set(key, batch);
    }
    return { batchId: batch.id, objectId: batch.objectId, alreadyStaged: false };
  }
  async stageSnapshot({ batch, snapshot }) {
    if (this.failNext) { this.failNext = false; throw new Error('simulated staging failure'); }
    this.staged.set(batch.batchId, { rows: snapshot.rows.length, factsPublished: 0 });
    const found = [...this.batches.values()].find((entry) => entry.id === batch.batchId);
    found.status = snapshot.errors.length ? 'failed' : 'completed';
    return { status: snapshot.errors.length ? 'validation_failed' : 'staged', batchId: batch.batchId };
  }
  async markFailed(batchId) {
    const found = [...this.batches.values()].find((entry) => entry.id === batchId);
    if (found && found.status !== 'completed') found.status = 'failed';
  }
}

function smallSnapshot(label = '1') {
  return prepareRkaSnapshot(Buffer.from(`[${JSON.stringify({ 'NO URUT': 1, 'RKA KEY': label, 'MATA ANGGARAN': 'Kategori', 'KODE UKER': '1' })}]`), {
    knownOfficeCodes: new Set(['1']), strictSnapshot: false,
  });
}

test('retry checksum dan parser sama idempoten; checksum baru mempertahankan batch histori terpisah', async () => {
  const repo = new FakeStagingRepository();
  const first = smallSnapshot();
  const one = await executeRkaStage(first, repo, { parserVersion: RKA_PARSER_VERSION });
  const retry = await executeRkaStage(first, repo, { parserVersion: RKA_PARSER_VERSION });
  const changed = await executeRkaStage(smallSnapshot('2'), repo, { parserVersion: RKA_PARSER_VERSION });
  assert.equal(one.status, 'staged');
  assert.equal(retry.status, 'already_staged');
  assert.equal(repo.batches.size, 2);
  assert.equal(repo.staged.size, 2);
  assert.notEqual(one.batchId, changed.batchId);
});

test('kegagalan staging tidak menyisakan batch completed atau publikasi parsial dan retry dapat melanjutkan', async () => {
  const repo = new FakeStagingRepository();
  const snapshot = smallSnapshot();
  repo.failNext = true;
  await assert.rejects(executeRkaStage(snapshot, repo), /simulated staging failure/);
  assert.equal([...repo.batches.values()][0].status, 'failed');
  assert.equal(repo.staged.size, 0);
  const retry = await executeRkaStage(snapshot, repo);
  assert.equal(retry.status, 'staged');
  assert.equal([...repo.batches.values()][0].status, 'completed');
  assert.equal([...repo.staged.values()][0].factsPublished, 0);
});

test('guard repository hanya mengizinkan database uji untuk tahap RKA ini', () => {
  assert.doesNotThrow(() => assertRkaTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertRkaTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }), /hanya diizinkan ke dashboard_funding_test/);
});
