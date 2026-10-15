import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { scryptSync } from 'node:crypto';
import { resolveRuntimeTarget, assertActualRuntimeTarget } from '../server/runtime-target.mjs';
import { assertFundingApiTarget } from '../server/funding-position-api.mjs';
import { createFundingReferenceHandler } from '../server/funding-reference-api.mjs';
import { assertShadowTarget } from '../server/shadow-master-api.mjs';
import { createAdminUploadHandler } from '../server/admin-upload-api.mjs';
import { assertAdminPositionTarget } from '../server/admin-position-pipeline.mjs';
import { MysqlPositionRepository } from '../server/imports/mysql-position-repository.mjs';
import { getDatabaseConfig } from '../server/db.js';

const development = { host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' };
const production = { host: 'db.internal.example', port: 3306, database: 'dashboard_funding' };
const productionEnv = {
  DASHBOARD_RUNTIME_ENV: 'production',
  DASHBOARD_PRODUCTION_DB_HOST: production.host,
  DASHBOARD_PRODUCTION_DB_PORT: String(production.port),
  DASHBOARD_PRODUCTION_DB_NAME: production.database,
  DASHBOARD_PUBLIC_ORIGIN: 'https://funding.example.com',
};

test('development tetap hanya menerima database uji lokal', () => {
  assert.equal(resolveRuntimeTarget(development, {}).mode, 'development');
  assertFundingApiTarget(development, {});
  assertShadowTarget(development, {});
  assertAdminPositionTarget(development, {});
  for (const target of [production, { ...development, database: 'dashboard_funding' }]) {
    assert.throws(() => resolveRuntimeTarget(target, {}), /Target database runtime/);
  }
});

test('production memerlukan allowlist host, port, dan database eksplisit tanpa wildcard', async () => {
  assert.equal(resolveRuntimeTarget(production, productionEnv).mode, 'production');
  assertFundingApiTarget(production, productionEnv);
  assertShadowTarget(production, productionEnv);
  assertAdminPositionTarget(production, productionEnv);
  for (const env of [{ ...productionEnv, DASHBOARD_PRODUCTION_DB_HOST: '' },
    { ...productionEnv, DASHBOARD_PRODUCTION_DB_HOST: '*' },
    { ...productionEnv, DASHBOARD_PRODUCTION_DB_PORT: '' },
    { ...productionEnv, DASHBOARD_PRODUCTION_DB_NAME: '' },
    { ...productionEnv, DASHBOARD_RUNTIME_ENV: 'unknown' }]) {
    assert.throws(() => resolveRuntimeTarget(production, env), /Target database runtime/);
  }
  for (const target of [{ ...production, host: 'other.internal' },
    { ...production, port: 3307 }, { ...production, database: 'other_db' }]) {
    assert.throws(() => resolveRuntimeTarget(target, productionEnv), /Target database runtime/);
  }
  await assertActualRuntimeTarget({ execute: async () => [[{ database_name: production.database, server_port: production.port }]] }, production, productionEnv);
  await assert.rejects(() => assertActualRuntimeTarget({ execute: async () => [[{ database_name: 'other_db', server_port: production.port }]] }, production, productionEnv));
});

test('endpoint Funding production membaca target yang cocok dan menolak database aktual lain', async () => {
  let calls = 0;
  const connection = {
    async execute(sql) {
      calls++;
      if (sql.includes('SELECT DATABASE()')) return [[{ database_name: production.database, server_port: production.port }]];
      if (sql.includes('information_schema.COLUMNS')) return [[
        ...Object.entries({
          dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
          dashboard_source_registry: ['source_id', 'source_key'],
          dashboard_import_batch: ['batch_id', 'source_id', 'status', 'finished_at'],
          dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
          dashboard_import_object: ['object_id', 'batch_id', 'source_checksum', 'source_row_count'],
          dashboard_stg_office_row: ['object_id', 'source_row_number', 'raw_record', 'parse_status'],
          dashboard_stg_rmft_row: ['object_id', 'source_row_number', 'raw_record', 'parse_status'],
          dashboard_stg_rka_row: ['object_id', 'source_row_number', 'raw_record', 'parse_status'],
          dashboard_stg_prognosis_row: ['object_id', 'sheet_name', 'source_row_number', 'raw_row', 'row_status'],
          dashboard_stg_appraisal_row: ['object_id', 'source_type', 'source_sheet', 'source_period', 'source_row_number', 'raw_record', 'schema_status'],
        }).flatMap(([TABLE_NAME, cols]) => cols.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME }))),
      ]];
      if (sql.includes("p.domain_key='office_master'")) return [[{ object_id: 1, source_row_count: 1 }]];
      if (sql.includes('COUNT(*) AS total')) return [[{ total: 1, invalid_rows: 0 }]];
      if (sql.includes('SELECT source_row_number,raw_record FROM dashboard_stg_office_row')) return [[{ source_row_number: 1, raw_record: '{"BRANCH CODE":"1"}' }]];
      throw new Error('Unexpected SELECT');
    }, release() {},
  };
  const handler = createFundingReferenceHandler({ env: productionEnv,
    getConfig: () => production, getPool: () => ({ getConnection: async () => connection }) });
  const response = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
  await handler({ method: 'GET', url: '/api/funding/master/offices' }, response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).recordCount, 1);
  assert.ok(calls > 0);

  const rejected = createFundingReferenceHandler({ env: productionEnv,
    getConfig: () => ({ ...production, database: 'other_db' }),
    getPool: () => ({ getConnection: async () => { throw new Error('Must reject before connection'); } }) });
  const denied = { status: 0, body: '', writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
  await rejected({ method: 'GET', url: '/api/funding/master/offices' }, denied);
  assert.equal(denied.status, 403);
});

test('importer CLI tetap test-only; Admin production perlu opt-in dan target cocok', () => {
  assert.throws(() => new MysqlPositionRepository({}, production), /Target impor tidak sesuai/);
  assert.doesNotThrow(() => new MysqlPositionRepository({}, production, { allowProductionAdmin: true, env: productionEnv }));
  assert.throws(() => new MysqlPositionRepository({}, { ...production, database: 'other_db' },
    { allowProductionAdmin: true, env: productionEnv }), /Target database runtime/);
});

test('Admin production menolak Origin salah dan memberi cookie Secure pada Origin resmi', async () => {
  const salt = Buffer.alloc(16, 3).toString('hex');
  const env = { ...productionEnv, DASHBOARD_ADMIN_USER: 'admin-fixture',
    DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt}:${scryptSync('synthetic-password', Buffer.from(salt, 'hex'), 32).toString('hex')}` };
  const handler = createAdminUploadHandler({ env, getConfig: () => production,
    getPool: () => ({ getConnection: async () => { throw new Error('Login must not connect to database'); } }) });
  const call = async origin => {
    const request = Readable.from([Buffer.from(JSON.stringify({ username: 'admin-fixture', password: 'synthetic-password' }))]);
    Object.assign(request, { method: 'POST', url: '/api/admin/login', headers: { origin, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
    const response = { status: 0, headers: {}, writeHead(code, headers) { this.status = code; this.headers = headers; }, end() {} };
    await handler(request, response);
    return response;
  };
  assert.equal((await call('https://wrong.example')).status, 403);
  const allowed = await call('https://funding.example.com');
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Secure;/);
});

test('production remote MySQL memerlukan CA TLS', () => {
  const env = { MYSQL_HOST: production.host, MYSQL_PORT: '3306', MYSQL_DATABASE: production.database,
    MYSQL_USER: 'synthetic', MYSQL_PASSWORD: 'synthetic', DASHBOARD_RUNTIME_ENV: 'production' };
  assert.throws(() => getDatabaseConfig(env), error => error.code === 'MYSQL_TLS_REQUIRED');
});
