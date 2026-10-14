import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundingReferenceHandler, fundingReferenceInternals } from '../server/funding-reference-api.mjs';

function harness({ host = '127.0.0.1', port = 3308, database = 'dashboard_funding_test' } = {}) {
  const statements = [];
  const connection = {
    async execute(sql) {
      statements.push(sql.trim());
      if (/^SELECT DATABASE\(\)/i.test(sql.trim())) return [[{ database_name: database, server_port: port }]];
      if (/FROM information_schema\.COLUMNS/i.test(sql)) return [Object.entries(fundingReferenceInternals.REQUIRED).flatMap(([TABLE_NAME, columns]) => columns.map((COLUMN_NAME) => ({ TABLE_NAME, COLUMN_NAME })))];
      if (/FROM dashboard_domain_publication p/i.test(sql) && /office_master/.test(sql)) return [[{ batch_id: 'batch-office', object_id: 10, source_row_count: 1, source_checksum: 'a'.repeat(64) }]];
      if (/FROM dashboard_domain_publication p/i.test(sql) && /rmft_master/.test(sql)) return [[{ batch_id: 'batch-rmft', object_id: 11, source_row_count: 1, source_checksum: 'b'.repeat(64) }]];
      if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1, invalid_rows: 0 }]];
      if (/SELECT source_row_number,raw_record FROM dashboard_stg_office_row/.test(sql)) return [[{ source_row_number: 1, raw_record: '{"BRANCH":"TEST OFFICE","BRANCH CODE":"001"}' }]];
      if (/SELECT source_row_number,raw_record FROM dashboard_stg_rmft_row/.test(sql)) return [[{ source_row_number: 1, raw_record: '{"PN":"masked","Nama RM":"masked"}' }]];
      if (/SELECT b\.batch_id,o\.object_id,o\.source_row_count,o\.source_checksum/.test(sql)) return [[{ batch_id: 'batch-rka', object_id: 12, source_row_count: 1, source_checksum: 'c'.repeat(64) }]];
      if (/SELECT raw_record FROM dashboard_stg_rka_row/.test(sql)) return [[{ raw_record: '{"KODE UKER":"001","MATA ANGGARAN":"RKA","JAN":0}' }]];
      throw new Error('Unexpected SQL in fixture');
    },
    release() {},
  };
  let connections = 0;
  const handler = createFundingReferenceHandler({
    getConfig: () => ({ host, port, database }),
    getPool: () => ({ getConnection: async () => { connections += 1; return connection; } }),
  });
  return { handler, statements, get connections() { return connections; } };
}

async function request(harnessValue, path) {
  const response = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await harnessValue.handler({ method: 'GET', url: path }, response);
  return response;
}

test('published office raw snapshot is exposed without writes', async () => {
  const h = harness();
  const response = await request(h, '/api/funding/master/offices');
  assert.equal(response.status, 200);
  assert.equal(response.body.recordCount, 1);
  assert.equal(response.body.records[0]['BRANCH CODE'], '001');
  assert.ok(h.statements.every((sql) => /^SELECT\b/i.test(sql)));
});

test('RKA API preserves raw JSON values including numeric zero', async () => {
  const h = harness();
  const response = await request(h, '/api/funding/rka');
  assert.equal(response.status, 200);
  assert.equal(response.body.records[0].JAN, 0);
  assert.equal(response.body.records[0]['KODE UKER'], '001');
  assert.ok(h.statements.every((sql) => /^SELECT\b/i.test(sql)));
});

test('wrong MySQL target is rejected before opening a connection', async () => {
  const h = harness({ database: 'dashboard_funding' });
  const response = await request(h, '/api/funding/master/offices');
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'funding_target_not_allowed');
  assert.equal(h.connections, 0);
});

test('no unsupported query can leak through a failing backend response', async () => {
  const h = harness({ port: 3307 });
  const response = await request(h, '/api/funding/master/rmft');
  assert.equal(response.status, 403);
  assert.doesNotMatch(JSON.stringify(response.body), /password|token|PN|Nama RM/i);
  assert.equal(h.connections, 0);
});
