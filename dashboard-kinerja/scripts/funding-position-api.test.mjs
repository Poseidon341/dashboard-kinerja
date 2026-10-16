import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertFundingApiTarget, buildSourceOfficeInventory, classifySourceOfficeType, clearPositionRowsCacheForTests, createFundingPositionHandler, overlayPositionScopes, readPositionSummary } from '../server/funding-position-api.mjs';

const columns = {
  dashboard_source_registry: ['source_id', 'source_key'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'finished_at'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_object: ['object_id', 'source_checksum', 'source_row_count'],
  dashboard_fact_position_daily: ['object_id', 'source_row_number', 'position_date', 'office_id', 'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label', 'account_count', 'balance', 'parse_status', 'mapping_status'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
  dashboard_dim_office_version: ['office_id', 'office_type', 'office_name', 'area_name', 'source_object_id'],
};

function connectionFor({ sourceRows = 1_039_742, snapshotRows = 1_039_742, resolved = 1_038_051, unresolved = 1_691, invalidRows = 0, publishedPeriod = null } = {}) {
  const statements = [];
  const connection = {
    statements,
    async execute(sql) {
      statements.push(sql);
      if (/SELECT DATABASE\(\)/i.test(sql)) return [[{ database_name: 'dashboard_funding_test', server_port: 3308 }]];
      if (/information_schema\.COLUMNS/i.test(sql)) return [Object.entries(columns).flatMap(([TABLE_NAME, names]) => names.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME })))];
      if (/FROM dashboard_source_registry s/i.test(sql)) return [[{ object_id: 4, source_checksum: 'a'.repeat(64), source_row_count: snapshotRows, batch_id: 'test-batch' }]];
      if (/COUNT\(\*\) AS fact_rows/i.test(sql)) throw new Error('API must not run a second full-fact validation scan');
      if (/p\.domain_key='position_daily'/i.test(sql)) return [publishedPeriod ? [{ period: publishedPeriod, batch_id: 'new-batch', publication_version: 1, object_id: 8, source_checksum: 'b'.repeat(64) }] : []];
      if (/FROM dashboard_domain_publication p/i.test(sql)) return [[{ object_id: 1 }]];
      if (/FROM dashboard_stg_position_row WHERE object_id/i.test(sql)) return [[{ total: 2 }]];
      if (/GROUP BY f\.position_date/i.test(sql)) return [[{
        Posisi: sql.includes('f.position_date>=?') ? (publishedPeriod.length === 10 ? publishedPeriod : `${publishedPeriod}-02`) : '2026-10-04', 'Segmentasi BPR': 'MIKRO', Produk: 'TABUNGAN', 'Nama Cabang': 'KC BANYUWANGI',
        'Nama Uker': 'KC BANYUWANGI', 'Jumlah Rekening': '4', Saldo: '125.25', officeId: '11', mappingStatus: 'resolved',
        officeType: 'KC', officeName: 'KC Banyuwangi', areaName: 'Area Jember', sourceRows: sql.includes('f.position_date>=?') ? 2 : sourceRows,
        resolvedRows: sql.includes('f.position_date>=?') ? 2 : resolved, unresolvedRows: sql.includes('f.position_date>=?') ? 0 : unresolved, inconsistentRows: 0, invalidRows,
      }]];
      throw new Error(`Unexpected test query: ${sql}`);
    },
    release() {},
  };
  return connection;
}

function responseCapture() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('API hanya menerima database uji lokal port 3308', () => {
  assertFundingApiTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' });
  for (const config of [
    { host: '127.0.0.1', port: 3308, database: 'dashboard_funding' },
    { host: 'db.example', port: 3308, database: 'dashboard_funding_test' },
    { host: 'localhost', port: 3307, database: 'dashboard_funding_test' },
  ]) assert.throws(() => assertFundingApiTarget(config), /target database runtime/);
});

test('publikasi bulan baru menambah fakta tanpa menghilangkan snapshot lama', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor({ publishedPeriod: '2026-11' });
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const response = responseCapture();
  await handler(Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' }), response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.recordCount, 1_039_744);
  assert.deepEqual(payload.records.map(row => row.Posisi), ['2026-10-04', '2026-11-02']);
});

test('endpoint membaca publikasi tanggal baru pada bulan yang sama tanpa menghapus tanggal lama', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor({ publishedPeriod: '2026-10-05' });
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const response = responseCapture();
  await handler(Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' }), response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.recordCount, 1_039_744);
  assert.deepEqual(payload.records.map(row => row.Posisi), ['2026-10-04', '2026-10-05']);
  assert.ok(connection.statements.every(sql => /^\s*SELECT\b/i.test(sql)));
});

test('penggantian Oktober memilih hanya snapshot bulan baru dan tidak menghitung base dua kali', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor({ publishedPeriod: '2026-10' });
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const response = responseCapture();
  await handler(Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' }), response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.recordCount, 2);
  assert.deepEqual(payload.records.map(row => row.Posisi), ['2026-10-02']);
});

test('snapshot tanggal baru dan penggantian satu tanggal tidak menghapus tanggal lain', () => {
  const base = [
    { Posisi: '2026-10-03', Saldo: 30 },
    { Posisi: '2026-10-04', Saldo: 40 },
    { Posisi: '2026-12-01', Saldo: 120 },
  ];
  const active = overlayPositionScopes(base, [
    { scopeKey: '2026-10-04', rows: [{ Posisi: '2026-10-04', Saldo: 41 }] },
    { scopeKey: '2026-11-01', rows: [{ Posisi: '2026-11-01', Saldo: 11 }] },
    { scopeKey: '2026-11-02', rows: [{ Posisi: '2026-11-02', Saldo: 12 }] },
  ]);
  assert.deepEqual(active.map(row => [row.Posisi, row.Saldo]), [
    ['2026-10-03', 30], ['2026-10-04', 41], ['2026-11-01', 11],
    ['2026-11-02', 12], ['2026-12-01', 120],
  ]);
  assert.deepEqual(base.map(row => row.Saldo), [30, 40, 120]);
});

test('publikasi harian mengungguli publikasi bulan lama tanpa saldo ganda', () => {
  const active = overlayPositionScopes([{ Posisi: '2026-10-01', Saldo: 1 }], [
    { scopeKey: '2026-10', rows: [{ Posisi: '2026-10-02', Saldo: 20 }, { Posisi: '2026-10-03', Saldo: 30 }] },
    { scopeKey: '2026-10-02', rows: [{ Posisi: '2026-10-02', Saldo: 21 }] },
  ]);
  assert.deepEqual(active.map(row => [row.Posisi, row.Saldo]), [['2026-10-02', 21], ['2026-10-03', 30]]);
});

test('ringkasan menolak fakta yang belum lengkap atau unresolved yang hilang', async () => {
  clearPositionRowsCacheForTests();
  await assert.rejects(() => readPositionSummary(connectionFor({ snapshotRows: 2000 })), /Snapshot fakta Posisi Dana belum lengkap/);
});

test('endpoint memvalidasi agregat dalam query yang sama tanpa kehilangan unresolved', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor();
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' });
  const response = responseCapture();
  await handler(request, response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.recordCount, 1_039_742);
  assert.equal(payload.snapshot.unresolvedRows, 1_691);
  assert.equal(payload.records[0].Saldo, 125.25);
  assert.match(response.headers['Server-Timing'], /aggregate;dur=/);
  assert.match(response.headers['Server-Timing'], /cache;desc="miss"/);
  assert.equal(connection.statements.filter(sql => /GROUP BY f\.position_date/i.test(sql)).length, 1);
  assert.ok(connection.statements.every(sql => /^\s*SELECT\b/i.test(sql)));
});

test('detail-unit memakai cache snapshot penuh dan menghasilkan subset Mikro-Tabungan tanpa query agregasi kedua', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor();
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const mainRequest = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' });
  const mainResponse = responseCapture();
  await handler(mainRequest, mainResponse);
  assert.equal(mainResponse.status, 200);
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/detail-unit/positions' });
  const response = responseCapture();
  await handler(request, response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.aggregateRows, 1);
  assert.equal(payload.recordCount, 1_039_742);
  assert.equal(payload.sourceOfficeInventory.length, 1);
  assert.equal(payload.sourceOfficeInventory[0].sourceType, 'KC');
  assert.equal(payload.sourceOfficeInventory[0].detailMetricGroups, 1);
  assert.equal(Object.hasOwn(payload.sourceOfficeInventory[0], 'Saldo'), false);
  assert.match(response.headers['Server-Timing'], /cache;desc="hit"/);
  assert.equal(connection.statements.filter(sql => /GROUP BY f\.position_date/i.test(sql)).length, 1);

  let opened = false;
  const blocked = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }),
    getPool: () => ({ getConnection: async () => { opened = true; throw new Error('must not connect'); } }),
  });
  const blockedResponse = responseCapture();
  await blocked(request, blockedResponse);
  assert.equal(blockedResponse.status, 403);
  assert.equal(opened, false);
});

test('klasifikasi sumber bertoken memisahkan KC, KCP, KK, UNIT dan tidak memakai substring di tengah nama', () => {
  assert.equal(classifySourceOfficeType('KCP MUNCAR BANYUWANGI'), 'KCP');
  assert.equal(classifySourceOfficeType('KK YAYASAN PUSPA DUNIA'), 'KK');
  assert.equal(classifySourceOfficeType('KC BANYUWANGI'), 'KC');
  assert.equal(classifySourceOfficeType('UNIT A. YANI MAGETAN'), 'UNIT');
  assert.equal(classifySourceOfficeType('KANWIL MALANG'), null);
  assert.equal(classifySourceOfficeType('CABANG KCP MALANG'), null);
});

test('inventaris sumber mengutamakan tipe pada label dan hanya merangkum ketersediaan metrik tanpa saldo', () => {
  const inventory = buildSourceOfficeInventory([
    { 'Nama Uker': 'KK YAYASAN PUSPA DUNIA', 'Nama Cabang': 'KC BANYUWANGI', officeId: '9', officeCode: '009', officeType: 'KC', 'Segmentasi BPR': 'RITEL', Produk: 'DEPOSITO', sourceRows: 1, Saldo: 2_690_475_780 },
    { 'Nama Uker': 'KK YAYASAN PUSPA DUNIA', 'Nama Cabang': 'KC BANYUWANGI', officeId: '9', officeCode: '009', officeType: 'KC', 'Segmentasi BPR': 'MIKRO', Produk: 'TABUNGAN', sourceRows: 2, Saldo: 500 },
    { 'Nama Uker': 'UNIT A. YANI MAGETAN', 'Nama Cabang': 'KC MAGETAN', officeId: null, officeCode: null, officeType: null, 'Segmentasi BPR': 'MIKRO', Produk: 'GIRO', sourceRows: 1, Saldo: 100 },
  ]);
  const kk = inventory.find((office) => office.sourceType === 'KK');
  assert.equal(kk.masterType, 'KC');
  assert.equal(kk.officeCode, '009');
  assert.equal(kk.detailMetricGroups, 1);
  assert.equal(kk.detailMetricSourceRows, 2);
  assert.equal(Object.hasOwn(kk, 'Saldo'), false);
  const unresolved = inventory.find((office) => office.officeLabel.startsWith('UNIT'));
  assert.equal(unresolved.officeId, null);
  assert.equal(unresolved.detailMetricGroups, 0);
});

test('permintaan awal bersamaan berbagi satu query agregasi', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor();
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' });
  const responses = [responseCapture(), responseCapture()];
  await Promise.all(responses.map(response => handler(request, response)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(connection.statements.filter(sql => /GROUP BY f\.position_date/i.test(sql)).length, 1);
  assert.equal(responses.filter(response => /cache;desc="miss"/.test(response.headers['Server-Timing'])).length, 1);
});

test('agregat menolak baris yang hilang atau status mapping yang tidak konsisten', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor({ sourceRows: 1_039_741, resolved: 1_038_050, unresolved: 1_691 });
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' });
  const response = responseCapture();
  await handler(request, response);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error, 'funding_data_not_ready');
});

test('agregat menolak fakta parse-invalid walaupun snapshot sumber lengkap', async () => {
  clearPositionRowsCacheForTests();
  const connection = connectionFor({ invalidRows: 1 });
  const handler = createFundingPositionHandler({
    getConfig: () => ({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }),
    getPool: () => ({ getConnection: async () => connection }),
  });
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/funding/positions' });
  const response = responseCapture();
  await handler(request, response);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error, 'funding_data_not_ready');
});
