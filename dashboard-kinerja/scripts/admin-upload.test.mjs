import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdminUploadHandler, verifyAdminCredentials } from '../server/admin-upload-api.mjs';
import { assertAdminPositionTarget, commitPositionWorkbook, publishPositionDates, sha256File, validateDateDecisions } from '../server/admin-position-pipeline.mjs';
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
  previewRows: [], dates: { '2026-11-01': { rows: 2, validRows: 2, invalidRows: 0, existing: null },
    '2026-12-01': { rows: 1, validRows: 1, invalidRows: 0, existing: null } },
};

test('validasi tanggal baru, tanggal kedua dalam bulan sama, replace, skip, dan konfirmasi', () => {
  const source = { '2026-11-01': 2, '2026-11-02': 1, '2026-12-01': 1 };
  assert.deepEqual(validateDateDecisions(source, {},
    { '2026-11-01': 'add', '2026-11-02': 'add', '2026-12-01': 'add' }, '', true), [
    { date: '2026-11-01', action: 'add', sourceRows: 2, previousRows: 0 },
    { date: '2026-11-02', action: 'add', sourceRows: 1, previousRows: 0 },
    { date: '2026-12-01', action: 'add', sourceRows: 1, previousRows: 0 },
  ]);
  const old = { '2026-11-01': { rows: 5 } };
  assert.throws(() => validateDateDecisions({ '2026-11-01': 2 }, old, { '2026-11-01': 'add' }, '', true), /sudah tersedia/);
  assert.throws(() => validateDateDecisions({ '2026-11-01': 2 }, old, { '2026-11-01': 'replace' }, '', true), /GANTI SNAPSHOT TANGGAL/);
  assert.deepEqual(validateDateDecisions(source, old,
    { '2026-11-01': 'cancel', '2026-11-02': 'add', '2026-12-01': 'cancel' }, '', true).map(item => item.date), ['2026-11-02']);
  assert.equal(validateDateDecisions({ '2026-11-01': 2 }, old,
    { '2026-11-01': 'replace' }, 'GANTI SNAPSHOT TANGGAL', true)[0].previousRows, 5);
  assert.throws(() => validateDateDecisions({ '2026-11-01': 2 }, old, { '2026-11-01': 'cancel' }, '', true), /Tidak ada tanggal/);
  assert.throws(() => validateDateDecisions({ '2026-11-01': 2 }, {}, { '2027-01-01': 'add' }, '', true), /di luar preview/);
  assert.throws(() => validateDateDecisions({ '2026-11-01': 2 }, {}, { '2026-11-01': 'add' }, '', false), /kelengkapan snapshot/);
  assert.throws(() => validateDateDecisions({ '2026-02-31': 2 }, {}, { '2026-02-31': 'add' }, '', true), /tidak valid/);
});

test('unggah ulang file identik berhenti sebelum staging atau penulisan fakta', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-daily-retry-'));
  const filePath = join(directory, 'snapshot.xlsx');
  try {
    await writeFile(filePath, Buffer.from('synthetic checksum fixture'));
    const checksum = await sha256File(filePath);
    const statements = [];
    let activeRowCount = 2;
    const connection = {
      async execute(sql) {
        statements.push(sql);
        if (sql.includes('SELECT DATABASE()')) return [[{ database_name: config.database, server_port: config.port }]];
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql.includes('o.source_row_count=1039742')) return [[{ object_id: 4, batch_id: 'base-batch', source_checksum: 'b'.repeat(64) }]];
        if (sql.includes('GROUP BY position_date') && !sql.includes('position_date>=?')) return [[]];
        if (sql.includes('p.domain_key=?')) return [[{
          scope_key: '2026-11-01', batch_id: 'same-batch', publication_version: 1,
          object_id: 8, source_checksum: checksum,
        }]];
        if (sql.includes('GROUP BY position_date') && sql.includes('position_date>=?')) return [[{ date_value: '2026-11-01', row_count: activeRowCount }]];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
    };
    const result = await commitPositionWorkbook({ filePath,
      preview: { checksum, totalRows: 2, dates: { '2026-11-01': { rows: 2,
        existing: { rows: 2, source: 'published-day', version: 1, batchId: 'same-batch', checksum } } } },
      decisions: { '2026-11-01': 'replace' }, confirmation: 'GANTI SNAPSHOT TANGGAL', snapshotComplete: true,
      actor: 'synthetic-admin', pool: { getConnection: async () => connection }, config,
    });
    assert.deepEqual(result, { status: 'already_published', publishedDates: [], alreadyPublishedDates: ['2026-11-01'] });
    assert.ok(statements.every(sql => /^\s*SELECT\b/i.test(sql)));
    activeRowCount = 1;
    await assert.rejects(() => commitPositionWorkbook({ filePath,
      preview: { checksum, totalRows: 2, dates: { '2026-11-01': { rows: 2,
        existing: { rows: 1, source: 'published-day', version: 1, batchId: 'same-batch', checksum } } } },
      decisions: { '2026-11-01': 'replace' }, confirmation: 'GANTI SNAPSHOT TANGGAL', snapshotComplete: true,
      actor: 'synthetic-admin', pool: { getConnection: async () => connection }, config,
    }));
    assert.ok(statements.every(sql => /^\s*SELECT\b/i.test(sql)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publikasi tanggal memakai transaksi, menjaga tanggal lain, idempoten, dan rollback', async () => {
  const active = new Map([['2026-08-01', { batch_id: 'old-batch', publication_version: 1 }]]);
  const history = [];
  let transaction = null;
  let failDate = null;
  const connection = {
    async beginTransaction() { transaction = { pointers: new Map(active), events: [] }; },
    async commit() { active.clear(); for (const [key, value] of transaction.pointers) active.set(key, value);
      history.push(...transaction.events); transaction = null; },
    async rollback() { transaction = null; },
    async execute(sql, params) {
      if (sql.includes('COUNT(*) AS total FROM dashboard_fact_position_daily')) return [[{ total: 2 }]];
      if (sql.includes('FOR UPDATE')) return [transaction.pointers.has(params[1]) ? [transaction.pointers.get(params[1])] : []];
      if (sql.includes('UPDATE dashboard_domain_publication')) {
        transaction.pointers.set(params[3], { batch_id: params[0], publication_version: params[1] }); return [{}];
      }
      if (sql.includes('INSERT INTO dashboard_domain_publication (')) {
        if (params[1] === failDate) throw new Error('Synthetic transaction failure');
        transaction.pointers.set(params[1], { batch_id: params[2], publication_version: 1 }); return [{}];
      }
      if (sql.includes('INSERT INTO dashboard_domain_publication_history')) {
        transaction.events.push({ scope: params[1] }); return [{}];
      }
      throw new Error('Unexpected SQL in isolated publication test');
    },
  };
  const additions = ['2026-11-01', '2026-11-02'].map(date => ({ date, action: 'add', sourceRows: 2 }));
  await publishPositionDates(connection, { changes: additions, before: { dates: {} }, stagedBatchId: 'new-batch', objectId: '12', actor: 'fixture' });
  assert.deepEqual([...active.keys()].sort(), ['2026-08-01', '2026-11-01', '2026-11-02']);
  assert.equal(history.length, 2);
  const replace = [{ date: '2026-11-01', action: 'replace', sourceRows: 2 }];
  await publishPositionDates(connection, { changes: replace, before: { dates: { '2026-11-01': {
    rows: 2, source: 'published-day', version: 1, batchId: 'new-batch',
  } } }, stagedBatchId: 'replacement-batch', objectId: '13', actor: 'fixture' });
  assert.equal(active.get('2026-11-01').batch_id, 'replacement-batch');
  assert.equal(active.get('2026-11-02').batch_id, 'new-batch');
  assert.equal(active.get('2026-08-01').batch_id, 'old-batch');
  assert.equal(history.length, 3);
  await publishPositionDates(connection, { changes: replace, before: { dates: { '2026-11-01': {
    rows: 2, source: 'published-day', version: 2, batchId: 'replacement-batch',
  } } }, stagedBatchId: 'replacement-batch', objectId: '13', actor: 'fixture' });
  assert.equal(history.length, 3);
  failDate = '2026-12-02';
  await assert.rejects(() => publishPositionDates(connection, { changes: [
    { date: '2026-12-01', action: 'add', sourceRows: 2 }, { date: '2026-12-02', action: 'add', sourceRows: 2 },
  ], before: { dates: {} }, stagedBatchId: 'failed-batch', objectId: '14', actor: 'fixture' }), /Synthetic transaction failure/);
  assert.equal(active.has('2026-12-01'), false);
  assert.equal(active.has('2026-12-02'), false);
  assert.equal(history.length, 3);
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
    if (sql.includes('GROUP BY position_date')) return [[]];
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
  assert.deepEqual(Object.keys(uploaded.data.dates), ['2026-11-01', '2026-12-01']);
  assert.ok(dbQueries > 0);
  const activeSession = await call(handler, 'GET', '/api/admin/session', null, { cookie });
  assert.equal(activeSession.status, 200);
  assert.equal(activeSession.data.user, 'admin-test');
  assert.equal(activeSession.data.csrf, loggedIn.data.csrf);
  const logout = await call(handler, 'POST', '/api/admin/logout', null, { cookie });
  assert.equal(logout.status, 200);
  const expiredSession = await call(handler, 'GET', '/api/admin/session', null, { cookie });
  assert.equal(expiredSession.status, 401);
});

test('kegagalan commit asinkron tidak melaporkan sukses dan tidak mengubah tanggal lain', async () => {
  const salt = Buffer.alloc(16, 2).toString('hex');
  const env = { DASHBOARD_ADMIN_USER: 'admin-test', DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt}:${scryptSync('secret-fixture', Buffer.from(salt, 'hex'), 32).toString('hex')}` };
  const before = { '2026-10-04': 5 };
  const connection = { async execute(sql) {
    if (sql.includes('SELECT DATABASE()')) return [[{ database_name: config.database, server_port: config.port }]];
    if (sql.includes('o.source_row_count=1039742')) return [[{ object_id: 4 }]];
    if (sql.includes('GROUP BY position_date')) return [[{ date_value: '2026-10-04', row_count: 5 }]];
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
    previewId: uploaded.data.previewId, decisions: { '2026-11-01': 'add', '2026-12-01': 'add' }, confirmation: '', snapshotComplete: true,
  }), { ...headers, 'content-type': 'application/json' });
  assert.equal(started.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const job = await call(handler, 'GET', `/api/admin/jobs/${started.data.jobId}`, null, { cookie: headers.cookie });
  assert.equal(job.data.status, 'failed');
  assert.equal(job.data.result, null);
  assert.deepEqual(before, { '2026-10-04': 5 });
});

test('preview dan konfirmasi publikasi memakai akun uji serta repository sintetis', async () => {
  const salt = Buffer.alloc(16, 3).toString('hex');
  const env = { DASHBOARD_ADMIN_USER: 'isolated-admin',
    DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt}:${scryptSync('isolated-password', Buffer.from(salt, 'hex'), 32).toString('hex')}` };
  let commitCalls = 0;
  const connection = { async execute(sql) {
    if (sql.includes('SELECT DATABASE()')) return [[{ database_name: config.database, server_port: config.port }]];
    if (sql.includes('o.source_row_count=1039742')) return [[{ object_id: 4 }]];
    if (sql.includes('GROUP BY position_date')) return [[]];
    if (sql.includes("p.domain_key=?")) return [[]];
    throw new Error('Unexpected SELECT in mock');
  }, release() {} };
  const handler = createAdminUploadHandler({ env, getConfig: () => config,
    getPool: () => ({ getConnection: async () => connection }),
    previewWorkbook: async path => ({ ...preview, checksum: await sha256File(path) }),
    commitWorkbook: async ({ config: target }) => {
      assert.equal(target.database, 'dashboard_funding_test');
      commitCalls += 1;
      return { status: 'completed', publishedDates: ['2026-11-01', '2026-12-01'] };
    },
  });
  const login = await call(handler, 'POST', '/api/admin/login',
    JSON.stringify({ username: 'isolated-admin', password: 'isolated-password' }),
    { 'content-type': 'application/json' });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers['Set-Cookie'].split(';')[0], 'x-admin-csrf': login.data.csrf };
  const upload = await call(handler, 'POST', '/api/admin/preview?type=position', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]),
    { ...headers, 'x-admin-filename': 'fixture.xlsx',
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  assert.equal(upload.status, 200);
  const started = await call(handler, 'POST', '/api/admin/commit', JSON.stringify({
    previewId: upload.data.previewId, decisions: { '2026-11-01': 'add', '2026-12-01': 'add' }, confirmation: '', snapshotComplete: true,
  }), { ...headers, 'content-type': 'application/json' });
  assert.equal(started.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const job = await call(handler, 'GET', `/api/admin/jobs/${started.data.jobId}`, null, { cookie: headers.cookie });
  assert.equal(job.data.status, 'completed');
  assert.deepEqual(job.data.result.publishedDates, ['2026-11-01', '2026-12-01']);
  assert.equal(commitCalls, 1);
});
