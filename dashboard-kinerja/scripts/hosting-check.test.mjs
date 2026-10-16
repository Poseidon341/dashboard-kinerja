import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkRuntimeDatabase, getHostingErrorInfo } from '../server/db.js';
import { startShadowServer } from '../server/shadow.js';

function fixture({ env = {}, config = {}, actual = {}, queryError } = {}) {
  const state = { acquisitions: 0, releases: 0, queries: [] };
  const settings = { host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test', ...config };
  return { state, options: {
    env, getConfig: () => settings,
    getPool: () => ({ getConnection: async () => {
      state.acquisitions++;
      return {
        execute: async (sql) => {
          state.queries.push(sql);
          assert.match(sql, /^SELECT /);
          if (queryError) throw queryError;
          return [[{ database_name: settings.database, server_port: settings.port, ...actual }]];
        },
        release: () => { state.releases++; },
      };
    } }),
  } };
}

test('development preflight verifies actual identity with SELECT only and releases connection', async () => {
  const { state, options } = fixture();
  assert.equal((await checkRuntimeDatabase(options)).database, 'dashboard_funding_test');
  assert.deepEqual(state, { acquisitions: 1, releases: 1,
    queries: ['SELECT DATABASE() AS database_name, @@port AS server_port'] });
});

test('production allows explicit port 3306; missing or mismatched allowlist fails before connection', async () => {
  const env = { DASHBOARD_RUNTIME_ENV: 'production', DASHBOARD_PRODUCTION_DB_HOST: 'localhost',
    DASHBOARD_PRODUCTION_DB_PORT: '3306', DASHBOARD_PRODUCTION_DB_NAME: 'funding_staging' };
  const config = { host: 'localhost', port: 3306, database: 'funding_staging' };
  assert.equal((await checkRuntimeDatabase(fixture({ env, config }).options)).port, 3306);
  for (const badEnv of [{ DASHBOARD_RUNTIME_ENV: 'production' }, { ...env, DASHBOARD_PRODUCTION_DB_PORT: '3308' }]) {
    const f = fixture({ env: badEnv, config });
    await assert.rejects(checkRuntimeDatabase(f.options), { code: 'PRODUCTION_TARGET_CONFIGURATION_MISMATCH' });
    assert.equal(f.state.acquisitions, 0);
  }
});

test('development rejects other databases/ports/hosts and invalid runtime mode', async () => {
  for (const config of [{ database: 'dashboard_funding' }, { port: 3306 }, { host: 'db.example' }]) {
    const f = fixture({ config });
    await assert.rejects(checkRuntimeDatabase(f.options), { code: 'DEVELOPMENT_TARGET_CONFIGURATION_MISMATCH' });
    assert.equal(f.state.acquisitions, 0);
  }
  await assert.rejects(checkRuntimeDatabase(fixture({ env: { DASHBOARD_RUNTIME_ENV: 'other' } }).options), { code: 'INVALID_RUNTIME_ENV' });
});

test('actual database or server port mismatch rejects and releases connection', async () => {
  for (const actual of [{ database_name: 'dashboard_funding' }, { server_port: 3306 }]) {
    const f = fixture({ actual });
    await assert.rejects(checkRuntimeDatabase(f.options), { code: 'ACTUAL_RUNTIME_TARGET_MISMATCH' });
    assert.equal(f.state.releases, 1);
  }
});

test('connection error is sanitized and does not disclose driver message or credentials', async () => {
  const error = Object.assign(new Error('private-password-and-account'), { code: 'ER_ACCESS_DENIED_ERROR' });
  const f = fixture({ queryError: error });
  await assert.rejects(checkRuntimeDatabase(f.options), error);
  assert.equal(f.state.releases, 1);
  const info = getHostingErrorInfo(error);
  assert.equal(info.code, 'ER_ACCESS_DENIED_ERROR');
  assert.ok(!JSON.stringify(info).includes('private-password'));
});

test('server does not create or bind HTTP socket until asynchronous preflight completes', async () => {
  let finish;
  let created = false;
  let bound = false;
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    assert.equal(port, 8788); assert.equal(host, '127.0.0.1'); bound = true; callback();
  };
  const pending = startShadowServer({ port: 8788,
    checkTarget: () => new Promise((resolve) => { finish = resolve; }),
    createServer: () => { created = true; return server; }, closePool: async () => {},
  });
  assert.equal(created, false); assert.equal(bound, false);
  finish();
  assert.equal(await pending, server);
  assert.equal(bound, true);
  server.emit('close');
});

test('failed preflight closes pool without opening HTTP port', async () => {
  let closed = false;
  await assert.rejects(startShadowServer({
    checkTarget: async () => { throw Object.assign(new Error('rejected'), { code: 'ACTUAL_RUNTIME_TARGET_MISMATCH' }); },
    createServer: () => assert.fail('must not create server'), closePool: async () => { closed = true; },
  }), { code: 'ACTUAL_RUNTIME_TARGET_MISMATCH' });
  assert.equal(closed, true);
});

test('occupied HTTP port fails startup and closes database pool', async () => {
  let closed = false;
  const server = new EventEmitter();
  server.listen = () => server.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
  await assert.rejects(startShadowServer({ port: 8788, checkTarget: async () => {},
    createServer: () => server, closePool: async () => { closed = true; },
  }), { code: 'EADDRINUSE' });
  assert.equal(closed, true);
});
