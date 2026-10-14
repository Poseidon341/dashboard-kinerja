import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPRAISAL_EXPECTED_HEADERS, executeAppraisalStage, fetchAppraisalSnapshot,
} from '../server/imports/appraisal-importer.mjs';
import { assertAppraisalTestTarget } from '../server/imports/mysql-appraisal-repository.mjs';
import { parseArguments } from './import-appraisal.mjs';

const sources = [
  { period: '2026-04', type: 'RO', sheetName: 'Master Data April 2026 (RO)', rowCount: 550, sheetId: 111 },
  { period: '2026-05', type: 'KP', sheetName: 'Master Data Mei 2026 (KP)', rowCount: 20, sheetId: 222 },
  { period: '2026-05', type: 'RO', sheetName: 'Master Data Mei 2026 (RO)', rowCount: 20, sheetId: 333 },
];

function makeRecord(sourceRow, overrides = {}) {
  const record = Object.fromEntries(APPRAISAL_EXPECTED_HEADERS.map((header) => [header, null]));
  Object.assign(record, {
    sourceRow,
    'Nama RM': 'fixture', PN: '000045', 'Kode KC': '101', 'Kantor Cabang': 'KC fixture',
    'Kode Uker': '201', 'Unit Kerja': 'unit fixture', Jabatan: 'RMFT', JG: 'JG fixture',
    'Target Daily Average Tabungan': '', 'Daily Average Tabungan': 0,
    '% Realisasi Daily Average Tabungan': 1.25, 'Score Daily Average Tabungan': 'score text',
    Score: 0, Tier: 'Tier 2', targetAvailability: { 'Daily Average Tabungan': 'available' },
    ...overrides,
  });
  return record;
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), async json() { return payload; } };
}

function createFetch({ sourceList = sources, recordCountOverrides = {}, rowOverrides = {}, failDataStatus = null } = {}) {
  const offsets = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/sources')) return response({ spreadsheetId: 'must-not-be-retained', sources: sourceList });
    if (failDataStatus) return response({ error: 'source_schema_mismatch', message: 'safe generic error' }, failDataStatus);
    const period = parsed.searchParams.get('period'); const type = parsed.searchParams.get('type');
    const offset = Number(parsed.searchParams.get('offset')); const limit = Number(parsed.searchParams.get('limit'));
    offsets.push({ period, type, offset, limit });
    const source = sourceList.find((item) => item.period === period && item.type === type);
    const key = `${period}|${type}`;
    const count = recordCountOverrides[key] ?? (period === '2026-04' ? 501 : 1);
    const rows = Array.from({ length: count }, (_, index) => makeRecord(index + 5, rowOverrides[key]?.[index] ?? {}));
    const page = rows.slice(offset, offset + limit);
    return response({
      source: { period, type, sheetName: source.sheetName, range: 'safe range', valueRenderOption: 'UNFORMATTED_VALUE' },
      recordCount: count,
      pagination: { limit, offset, returned: page.length },
      records: page,
    });
  };
  return { fetchImpl, offsets };
}

test('daftar sumber mencakup setiap pasangan periode/tipe valid dan pagination mengambil seluruh halaman', async () => {
  const { fetchImpl, offsets } = createFetch();
  const snapshot = await fetchAppraisalSnapshot({ fetchImpl, knownOfficeTypes: new Map([['101', 'KC']]), sleep: async () => {} });
  assert.equal(snapshot.metadata.sourceCount, 3);
  assert.deepEqual(snapshot.sheets.map(({ period, type }) => `${period}|${type}`), ['2026-04|RO', '2026-05|KP', '2026-05|RO']);
  assert.equal(snapshot.totalRows, 503);
  assert.deepEqual(offsets.filter((x) => x.period === '2026-04').map((x) => x.offset), [0, 500]);
  assert.ok(snapshot.sheets.every((sheet) => sheet.sourceRowCount === sheet.recordCount));
});

test('mapping berbasis kontrak backend menjaga PN sebagai teks, nilai null/angka/teks, realisasi tanpa skala ulang, dan unresolved KC', async () => {
  const { fetchImpl } = createFetch({
    sourceList: [sources[1]], recordCountOverrides: { '2026-05|KP': 2 },
    rowOverrides: { '2026-05|KP': [{}, { PN: '000854', 'Kode KC': '854', 'Target Daily Average Tabungan': null, 'Daily Average Tabungan': '125.50', '% Realisasi Daily Average Tabungan': 0.75 }] },
  });
  const snapshot = await fetchAppraisalSnapshot({ fetchImpl, knownOfficeTypes: new Map([['101', 'KC']]), sleep: async () => {} });
  const [matched, unresolved] = snapshot.sheets[0].rows;
  assert.equal(matched.pnText, '000045');
  assert.equal(matched.officeMapping, 'matched');
  assert.equal(unresolved.pnText, '000854');
  assert.equal(unresolved.officeMapping, 'unresolved');
  assert.equal(matched.rawValues['Target Daily Average Tabungan'], '');
  assert.equal(matched.rawValues['Daily Average Tabungan'], 0);
  assert.equal(matched.rawValues['% Realisasi Daily Average Tabungan'], 1.25);
  assert.equal(unresolved.rawValues['Target Daily Average Tabungan'], null);
  assert.equal(unresolved.rawValues['Daily Average Tabungan'], '125.50');
  assert.equal(unresolved.rawValues['% Realisasi Daily Average Tabungan'], 0.75);
  assert.equal(snapshot.metadata.headerFingerprint, null);
});

test('snapshot identik memakai idempotensi yang sama, snapshot berubah berbeda, dan tidak ada publikasi/fakta', async () => {
  const { fetchImpl } = createFetch({ sourceList: [sources[1]], recordCountOverrides: { '2026-05|KP': 1 } });
  const snapshot = await fetchAppraisalSnapshot({ fetchImpl, sleep: async () => {} });
  const { fetchImpl: changedFetch } = createFetch({
    sourceList: [sources[1]], recordCountOverrides: { '2026-05|KP': 1 },
    rowOverrides: { '2026-05|KP': [{ Score: 99 }] },
  });
  const changed = await fetchAppraisalSnapshot({ fetchImpl: changedFetch, sleep: async () => {} });
  assert.notEqual(snapshot.checksum, changed.checksum);
  const repository = {
    batches: new Map(), stageCalls: 0, publicationCalls: 0,
    async withSourceLock(_key, callback) { return callback(this); },
    async reserveBatch(args) {
      const existing = this.batches.get(args.checksum);
      if (existing) return { ...existing, alreadyStaged: true };
      const result = { batchId: `batch-${this.batches.size + 1}`, alreadyStaged: false };
      this.batches.set(args.checksum, result); return result;
    },
    async stageSnapshot({ batch, snapshot: value }) { this.stageCalls += 1; return { status: 'staged', batchId: batch.batchId, rows: value.totalRows }; },
  };
  const first = await executeAppraisalStage(snapshot, repository);
  const retry = await executeAppraisalStage(snapshot, repository);
  const next = await executeAppraisalStage(changed, repository);
  assert.equal(retry.status, 'already_staged');
  assert.notEqual(first.batchId, next.batchId);
  assert.equal(repository.stageCalls, 2);
  assert.equal(repository.publicationCalls, 0);
  assert.equal(snapshot.facts, undefined);
});

test('schema mismatch dihentikan tanpa retry dan daftar header hilang tidak direkayasa', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({ error: 'source_schema_mismatch', message: 'safe generic error' }, 502); };
  await assert.rejects(fetchAppraisalSnapshot({ fetchImpl, sleep: async () => {} }), (error) => {
    assert.equal(error.applicationError, 'source_schema_mismatch');
    assert.equal(error.status, 502);
    return true;
  });
  assert.equal(calls, 1);
});

test('kegagalan jaringan dicoba ulang terbatas lalu gagal tanpa staging', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('network'); };
  await assert.rejects(fetchAppraisalSnapshot({ fetchImpl, sleep: async () => {} }), /Koneksi ke endpoint Appraisal lokal gagal/);
  assert.equal(calls, 3);
});

test('guard target hanya menerima database test dan CLI menolak database utama', () => {
  assert.doesNotThrow(() => assertAppraisalTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertAppraisalTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }), /hanya diizinkan/);
  assert.throws(() => parseArguments(['--apply', '--confirm-target', 'dashboard_funding']), /hanya mengizinkan/);
});
