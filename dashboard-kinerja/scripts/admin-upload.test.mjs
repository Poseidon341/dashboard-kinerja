import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdminUploadHandler, verifyAdminCredentials } from '../server/admin-upload-api.mjs';
import { assertAdminPositionTarget, sha256File, validatePeriodDecisions } from '../server/admin-position-pipeline.mjs';
import { compareFactRows, planFactChunk } from '../server/imports/position-fact-builder.mjs';
import { scanPositionFile } from '../server/imports/position-importer.mjs';

function fakeRequest(method, url, body = null, headers = {}) {
  const input = body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const request = Readable.from(input);
  Object.assign(request, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  return request;
}

async function call(handler, method, path, body = null, headers = {}) {
  let status = 0; let output = ''; let responseHeaders = {};
  const response = { writeHead(code, head) { status = code; responseHeaders = head; }, end(data) { output = data; } };
  await handler(fakeRequest(method, path, body, headers), response);
  return { status, data: JSON.parse(output), headers: responseHeaders };
}

const config = { host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' };
const preview = {
  checksum: 'a'.repeat(64), totalRows: 3, validRows: 3, invalidRows: 0, validationErrors: {},
  headers: ['Posisi', 'Segmentasi BPR', 'Produk', 'Nama Cabang', 'Nama Uker', 'Jumlah Rekening', 'Saldo'],
  previewRows: [], periods: { '2026-11': { rows: 2, dates: 1, existing: null }, '2026-12': { rows: 1, dates: 1, existing: null } },
};

test('validasi periode baru, multi-periode, lama, cancel, dan konfirmasi replace', () => {
  assert.deepEqual(validatePeriodDecisions({ '2026-11': 2, '2026-12': 1 }, {},
    { '2026-11': 'add', '2026-12': 'add' }, ''), [
    { period: '2026-11', action: 'add', sourceRows: 2, previousRows: 0 },
    { period: '2026-12', action: 'add', sourceRows: 1, previousRows: 0 },
  ]);
  const old = { '2026-11': { rows: 5 } };
  assert.throws(() => validatePeriodDecisions({ '2026-11': 2 }, old, { '2026-11': 'add' }, ''), /sudah tersedia/);
  assert.throws(() => validatePeriodDecisions({ '2026-11': 2 }, old, { '2026-11': 'replace' }, ''), /GANTI DATA PERIODE/);
  assert.deepEqual(validatePeriodDecisions({ '2026-11': 2, '2026-12': 1 }, old,
    { '2026-11': 'cancel', '2026-12': 'add' }, '').map(item => item.period), ['2026-12']);
  assert.deepEqual(validatePeriodDecisions({ '2026-11': 2 }, old,
    { '2026-11': 'replace' }, 'GANTI DATA PERIODE')[0].previousRows, 5);
  assert.throws(() => validatePeriodDecisions({ '2026-11': 2 }, old, { '2026-11': 'cancel' }, ''), /Tidak ada periode/);
  assert.throws(() => validatePeriodDecisions({ '2026-11': 2 }, {}, { '2027-01': 'add' }, ''), /di luar preview/);
});

test('periode terdeteksi dari tanggal baris sumber, termasuk Januari tahun berikutnya; tanggal invalid ditolak', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-period-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const record = date => ({ Posisi: date, 'Segmentasi BPR': 'MIKRO', Produk: 'TABUNGAN',
    'Nama Cabang': 'KC Contoh', 'Nama Uker': 'UNIT Contoh', 'Jumlah Rekening': 0, Saldo: '0' });
  await writeFile(path, JSON.stringify([record('30/11/2026'), record('01/12/2026'),
    record('02/12/2026'), record('01/01/2027'), record('31/02/2027')]));
  const result = await scanPositionFile(path, { strictSnapshot: false, expectedRows: 5 });
  assert.deepEqual(result.periods, { '2026-11': 1, '2026-12': 2, '2027-01': 1 });
  assert.equal(result.invalidRows, 1);
  assert.equal(result.validationErrors.invalid_date, 1);
});

test('guard menolak database utama, host lain, dan port lain', () => {
  assert.doesNotThrow(() => assertAdminPositionTarget(config));
  for (const changed of [{ database: 'dashboard_funding' }, { host: 'db.example' }, { port: 3306 }]) {
    assert.throws(() => assertAdminPositionTarget({ ...config, ...changed }), /hanya diizinkan/);
  }
});

test('retry fakta dengan skala DECIMAL MySQL tidak menggandakan identitas sumber; konflik ditolak', () => {
  const expected = { batch_id: 'b', object_id: '2', source_row_number: '3', position_date: '2026-11-01',
    office_id: null, segment_id: null, product_id: null, source_segment_label: 'MIKRO',
    source_product_label: 'TABUNGAN', source_branch_label: 'KC', source_office_label: 'UNIT',
    source_account_count_text: '0', account_count: '0', source_balance_text: '1.5', balance: '1.5',
    amount_unit_code: null, parse_status: 'valid', mapping_status: 'unresolved' };
  const existing = { ...expected, position_date: new Date('2026-11-01T00:00:00.000Z'), balance: '1.500000000000000' };
  assert.equal(compareFactRows(existing, expected), true);
  assert.deepEqual(planFactChunk([expected], [existing]), { missing: [], validatedExisting: 1 });
  assert.deepEqual(planFactChunk([expected], []), { missing: [expected], validatedExisting: 0 });
  assert.throws(() => planFactChunk([expected], [{ ...existing, balance: '2.000000000000000' }]), /tidak identik/);
});

test('API Admin mensyaratkan login khusus, CSRF, template XLSX dan mengembalikan preview', async () => {
  const salt = Buffer.alloc(16, 1).toString('hex');
  const env = { DASHBOARD_ADMIN_USER: 'admin-test', DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt}:${scryptSync('secret-fixture', Buffer.from(salt, 'hex'), 32).toString('hex')}` };
  assert.equal(verifyAdminCredentials('admin-test', 'secret-fixture', env), true);
  assert.equal(verifyAdminCredentials('admin-test', 'wrong', env), false);
  let dbQueries = 0;
  const connection = { async execute(sql) {
    dbQueries += 1;
    if (sql.includes('SELECT DATABASE()')) return [[{ database_name: config.database, server_port: config.port }]];
    if (sql.includes('o.source_row_count=1039742')) return [[{ object_id: 4 }]];
    if (sql.includes('GROUP BY DATE_FORMAT')) return [[]];
    if (sql.includes("p.domain_key=?")) return [[]];
    throw new Error('Unexpected SELECT in mock');
  }, release() {} };
  const handler = createAdminUploadHandler({ env, getConfig: () => config,
    getPool: () => ({ getConnection: async () => connection }),
    previewWorkbook: async path => ({ ...preview, checksum: await sha256File(path) }),
  });
  const unauthorized = await call(handler, 'POST', '/api/admin/preview?type=position');
  assert.equal(unauthorized.status, 401); assert.equal(dbQueries, 0);
  const loggedIn = await call(handler, 'POST', '/api/admin/login',
    JSON.stringify({ username: 'admin-test', password: 'secret-fixture' }), { 'content-type': 'application/json' });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers['Set-Cookie'].split(';')[0];
  const noCsrf = await call(handler, 'POST', '/api/admin/preview?type=position', null, { cookie });
  assert.equal(noCsrf.status, 403);
  const badType = await call(handler, 'POST', '/api/admin/preview?type=rka', null,
    { cookie, 'x-admin-csrf': loggedIn.data.csrf });
  assert.equal(badType.status, 422);
  const invalidWorkbook = await call(handler, 'POST', '/api/admin/preview?type=position', Buffer.from('not-xlsx'),
    { cookie, 'x-admin-csrf': loggedIn.data.csrf, 'x-admin-filename': 'bad.xlsx',
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  assert.equal(invalidWorkbook.status, 422);
  const uploaded = await call(handler, 'POST', '/api/admin/preview?type=position', Buffer.from([0x50,0x4b,0x03,0x04,1]),
    { cookie, 'x-admin-csrf': loggedIn.data.csrf, 'x-admin-filename': 'fixture.xlsx',
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(Object.keys(uploaded.data.periods), ['2026-11', '2026-12']);
  assert.ok(dbQueries > 0);
});

test('kegagalan commit asinkron tidak melaporkan sukses dan tidak mengubah periode lain', async () => {
  const salt = Buffer.alloc(16, 2).toString('hex');
  const env = { DASHBOARD_ADMIN_USER: 'admin-test', DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt}:${scryptSync('secret-fixture', Buffer.from(salt, 'hex'), 32).toString('hex')}` };
  const before = { '2026-10': 5 };
  const connection = { async execute(sql) {
    if (sql.includes('SELECT DATABASE()')) return [[{ database_name: config.database, server_port: config.port }]];
    if (sql.includes('o.source_row_count=1039742')) return [[{ object_id: 4 }]];
    if (sql.includes('GROUP BY DATE_FORMAT')) return [[{ period: '2026-10', row_count: 5, date_count: 1 }]];
    if (sql.includes("p.domain_key=?")) return [[]];
    throw new Error('Unexpected SQL');
  }, release() {} };
  const handler = createAdminUploadHandler({ env, getConfig: () => config,
    getPool: () => ({ getConnection: async () => connection }), previewWorkbook: async path => ({ ...preview, checksum: await sha256File(path) }),
    commitWorkbook: async () => { throw new Error('Transaksi sintetis gagal; tidak dipublikasikan.'); },
  });
  const loggedIn = await call(handler, 'POST', '/api/admin/login',
    JSON.stringify({ username: 'admin-test', password: 'secret-fixture' }), { 'content-type': 'application/json' });
  const headers = { cookie: loggedIn.headers['Set-Cookie'].split(';')[0], 'x-admin-csrf': loggedIn.data.csrf };
  const uploaded = await call(handler, 'POST', '/api/admin/preview?type=position', Buffer.from([0x50,0x4b,0x03,0x04,1]),
    { ...headers, 'x-admin-filename': 'fixture.xlsx',
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  assert.equal(uploaded.status, 200);
  const started = await call(handler, 'POST', '/api/admin/commit', JSON.stringify({
    previewId: uploaded.data.previewId, decisions: { '2026-11': 'add', '2026-12': 'add' }, confirmation: '',
  }), { ...headers, 'content-type': 'application/json' });
  assert.equal(started.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const job = await call(handler, 'GET', `/api/admin/jobs/${started.data.jobId}`, null, { cookie: headers.cookie });
  assert.equal(job.data.status, 'failed');
  assert.equal(job.data.result, null);
  assert.deepEqual(before, { '2026-10': 5 });
});
