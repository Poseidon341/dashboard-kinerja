import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executePrognosisStage, preparePrognosisSnapshot, PROGNOSIS_PARSER_VERSION, PROGNOSIS_SHEETS,
} from '../server/imports/prognosis-importer.mjs';
import { assertPrognosisTestTarget } from '../server/imports/mysql-prognosis-repository.mjs';
import { parseArguments } from './import-prognosis.mjs';

function fixtureBytes({ changed = false } = {}) {
  const metadata = JSON.stringify({ includedSheets: PROGNOSIS_SHEETS, currencyUnit: null, pipelineWeekDateRanges: null, formulaPolicy: 'cached only' });
  const sheets = PROGNOSIS_SHEETS.map((sheet, index) => {
    const rowNumber = index + 2;
    const row = index === 0
      ? `{ "row": ${rowNumber}, "values": [null, "", 0, "catatan", 9007199254740993${changed ? '1' : ''}] }`
      : `{ "row": ${rowNumber}, "values": [${index}, null] }`;
    const details = JSON.stringify({ sourceRange: `A1:B${rowNumber}`, firstColumn: 'A', lastColumn: 'B', headerRows: [rowNumber], formulaCellCount: 1, cachedFormulaCellCount: 1, mergedRanges: [] });
    const detailObject = JSON.parse(details);
    return `${JSON.stringify(sheet)}:{"sourceRange":${JSON.stringify(detailObject.sourceRange)},"firstColumn":"A","lastColumn":"B","headerRows":[${rowNumber}],"formulaCellCount":1,"cachedFormulaCellCount":1,"mergedRanges":[],"rows":[${row}]}`;
  }).join(',');
  return Buffer.from(`{"metadata":${metadata},"sheets":{${sheets}}}`, 'utf8');
}

class FakeRepository {
  constructor() { this.batches = new Map(); this.stageCalls = 0; this.failed = []; this.publications = 0; }
  async withSourceLock(_sourceKey, callback) { return callback(this); }
  async reserveBatch(args) {
    const key = `${args.checksum}:${args.parserVersion}`;
    const existing = this.batches.get(key);
    if (existing?.status === 'completed') return { ...existing, alreadyStaged: true };
    if (existing) return { ...existing, alreadyStaged: false };
    const batch = { batchId: `batch-${this.batches.size + 1}`, objectIds: Object.fromEntries(args.sheets.map((sheet, i) => [sheet.sheetName, i + 1])), observedAt: 'fixed-observation-time', status: 'loading', alreadyStaged: false };
    this.batches.set(key, batch); return batch;
  }
  async stageSnapshot({ batch, snapshot }) {
    this.stageCalls += 1;
    if (snapshot.failDuringStage) throw new Error('simulated staging failure');
    batch.status = snapshot.errors.length ? 'failed' : 'completed';
    return { status: batch.status === 'completed' ? 'staged' : 'validation_failed', batchId: batch.batchId, rows: snapshot.totalRows };
  }
  async markFailed(batchId) { this.failed.push(batchId); }
}

test('empat sheet disiapkan terpisah dengan jumlah dan nomor baris fisik, header, serta identitas kolom', () => {
  const snapshot = preparePrognosisSnapshot(fixtureBytes(), { strictSnapshot: false });
  assert.deepEqual(snapshot.sheets.map(({ sheetName }) => sheetName), PROGNOSIS_SHEETS);
  assert.deepEqual(snapshot.sheets.map(({ sourceRowCount }) => sourceRowCount), [1, 1, 1, 1]);
  assert.deepEqual(snapshot.sheets.map(({ rows }) => rows[0].sourceRowNumber), [2, 3, 4, 5]);
  assert.equal(snapshot.totalRows, 4);
  assert.deepEqual(snapshot.sheets.map(({ rows }) => rows[0].sourceRange), ['A2:B2', 'A3:B3', 'A4:B4', 'A5:B5']);
  assert.ok(snapshot.sheets[0].rows[0].headerLevels.includes('"headers":[{ "row": 2'));
  assert.ok(snapshot.sheets[0].rows[0].headerLevels.includes('"formulaCellCount":1'));
  assert.equal(snapshot.errors.length, 0);
});

test('raw row mempertahankan null, string kosong, nol, teks, angka, dan lexeme angka presisi tinggi', () => {
  const snapshot = preparePrognosisSnapshot(fixtureBytes(), { strictSnapshot: false });
  const raw = snapshot.sheets[0].rows[0].rawRow;
  assert.match(raw, /null, "", 0, "catatan", 9007199254740993/);
  assert.equal(snapshot.valueCounts.null, 4);
  assert.equal(snapshot.valueCounts.blankString, 1);
  assert.equal(snapshot.valueCounts.zero, 1);
  assert.equal(snapshot.valueTypes.number, 5);
  assert.equal(snapshot.metadata.currencyUnit, null);
  assert.equal(snapshot.metadata.pipelineWeekDateRanges, null);
});

test('snapshot yang sama idempoten berdasarkan checksum dan parser; checksum berbeda membuat batch baru', async () => {
  const repository = new FakeRepository();
  const first = preparePrognosisSnapshot(fixtureBytes(), { strictSnapshot: false });
  const changed = preparePrognosisSnapshot(fixtureBytes({ changed: true }), { strictSnapshot: false });
  assert.notEqual(first.checksum, changed.checksum);
  const staged = await executePrognosisStage(first, repository);
  const repeated = await executePrognosisStage(first, repository);
  const nextSnapshot = await executePrognosisStage(changed, repository);
  assert.equal(staged.status, 'staged');
  assert.equal(repeated.status, 'already_staged');
  assert.equal(repeated.batchId, staged.batchId);
  assert.notEqual(nextSnapshot.batchId, staged.batchId);
  assert.equal(repository.stageCalls, 2);
  assert.equal(repository.publications, 0);
  assert.equal(PROGNOSIS_PARSER_VERSION, 'prognosis-xlsx-stage-v1');
});

test('kegagalan staging menandai batch gagal dan tidak memublikasikan domain', async () => {
  const repository = new FakeRepository();
  const snapshot = preparePrognosisSnapshot(fixtureBytes(), { strictSnapshot: false });
  snapshot.failDuringStage = true;
  await assert.rejects(executePrognosisStage(snapshot, repository), /simulated staging failure/);
  assert.equal(repository.failed.length, 1);
  assert.equal(repository.publications, 0);
});

test('guard CLI dan target hanya menerima database test dengan host dan port yang diizinkan', () => {
  assert.throws(() => parseArguments(['--apply', '--confirm-target', 'dashboard_funding']), /hanya mengizinkan/);
  assert.deepEqual(parseArguments(['--dry-run']), { help: false, apply: false, confirmation: undefined });
  assert.doesNotThrow(() => assertPrognosisTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertPrognosisTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }), /hanya diizinkan/);
  assert.throws(() => assertPrognosisTestTarget({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }), /tidak sesuai/);
});
