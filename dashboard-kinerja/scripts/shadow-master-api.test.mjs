import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createShadowServer, SHADOW_TARGET } from '../server/shadow-master-api.mjs';
import { getShadowPort } from '../server/shadow.js';

function createFakeDatabase({ target = true, schema = true, queryFailure = null } = {}) {
  const statements = [];
  let connections = 0;
  const connection = {
    async execute(sql) {
      statements.push(sql.trim());
      if (sql.includes('DATABASE() AS database_name')) {
        return [[{ database_name: target ? SHADOW_TARGET.database : 'dashboard_funding', server_port: SHADOW_TARGET.port }]];
      }
      if (sql.includes('information_schema.COLUMNS')) {
        if (!schema) return [[]];
        const tableNames = [
          'dashboard_domain_publication', 'dashboard_import_object', 'dashboard_dim_office',
          'dashboard_dim_office_version', 'dashboard_office_relationship',
          'dashboard_dim_rmft', 'dashboard_rmft_assignment',
        ];
        const columns = {
          dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
          dashboard_import_object: ['object_id', 'batch_id'],
          dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
          dashboard_dim_office_version: ['office_version_id', 'office_id', 'office_type', 'observed_at', 'source_object_id'],
          dashboard_office_relationship: ['relationship_id', 'child_office_id', 'parent_office_id', 'relationship_type', 'observed_at', 'verification_status', 'source_object_id'],
          dashboard_dim_rmft: ['rmft_id', 'source_system', 'pn'],
          dashboard_rmft_assignment: ['assignment_id', 'rmft_id', 'office_id', 'source_unit_code', 'mapping_status', 'observed_at', 'source_object_id'],
        };
        return [[...tableNames.flatMap((table) => columns[table].map((column) => ({ TABLE_NAME: table, COLUMN_NAME: column })) )]];
      }
      if (queryFailure) throw queryFailure;
      if (sql.includes('COUNT(DISTINCT d.office_id)')) return [[{ office_count: 611, unique_code_count: 611, kc_count: 46, kcp_count: 35, unit_count: 530, published_version_count: 611 }]];
      if (sql.includes('COUNT(*) AS version_count')) return [[{ version_count: 611 }]];
      if (sql.includes('COUNT(*) AS relationship_count')) return [[{ relationship_count: 586 }]];
      if (sql.includes('GROUP BY child_v.office_type')) return [[{ child_type: 'UNIT', parent_type: 'KC', relationship_count: 530 }, { child_type: 'KCP', parent_type: 'KC', relationship_count: 35 }, { child_type: 'UNIT', parent_type: 'KCP', relationship_count: 21 }]];
      if (sql.includes('COUNT(DISTINCT r.rmft_id)')) return [[{ rmft_count: 192, unique_pn_count: 192, mapped_assignment_count: 190, unresolved_assignment_count: 2 }]];
      if (sql.includes('GROUP BY source_unit_code')) return [[{ office_code: '854', assignment_count: 2 }]];
      throw new Error('Unexpected SELECT in test fixture.');
    },
    release() {},
  };
  const pool = { async getConnection() { connections += 1; return connection; } };
  return { pool, statements, get connections() { return connections; } };
}

async function withServer(options, callback) {
  const server = createShadowServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await callback(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

function isReadOnlySql(sql) {
  return /^(SELECT|WITH)\b/i.test(sql)
    && !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql);
}

test('ringkasan shadow mengembalikan agregat aman dan menjalankan SELECT saja', async () => {
  const db = createFakeDatabase();
  await withServer({ getConfig: () => ({ ...SHADOW_TARGET }), getPool: () => db.pool }, async (baseUrl) => {
    const offices = await getJson(baseUrl, '/api/shadow/master-offices/summary');
    assert.equal(offices.status, 200);
    assert.equal(offices.body.officeCount, 611);
    assert.equal(offices.body.uniqueCodeCount, 611);
    assert.deepEqual(offices.body.byType, { KC: 46, KCP: 35, UNIT: 530 });
    assert.equal(offices.body.relationshipCount, 586);
    assert.equal(offices.body.publishedVersionCount, 611);
    const rmft = await getJson(baseUrl, '/api/shadow/master-rmft/summary');
    assert.equal(rmft.status, 200);
    assert.equal(rmft.body.rmftCount, 192);
    assert.equal(rmft.body.uniquePnCount, 192);
    assert.equal(rmft.body.mappedAssignmentCount, 190);
    assert.deepEqual(rmft.body.unresolvedByOfficeCode, [{ officeCode: '854', count: 2 }]);
    assert.equal(JSON.stringify(rmft.body).includes('"pn"'), false);
    const rmftQueries = db.statements.filter((sql) => sql.includes('dashboard_rmft_assignment'));
    assert.equal(rmftQueries.length, 2);
    assert.ok(rmftQueries.every((sql) => sql.includes('ROW_NUMBER() OVER (PARTITION BY a.rmft_id')));
    assert.ok(rmftQueries.every((sql) => sql.includes('WHERE snapshot_rank = 1')));
    assert.ok(rmftQueries.every((sql) => !sql.includes("mapping_status = 'mapped'")));
    assert.ok(rmftQueries.every((sql) => sql.includes('office_id IS NULL') || sql.includes('office_id IS NOT NULL')));
  });
  assert.ok(db.statements.every(isReadOnlySql));
});

test('refuse la base, l’hôte ou le port non autorisés avant connexion', async () => {
  for (const config of [
    { ...SHADOW_TARGET, database: 'dashboard_funding' },
    { ...SHADOW_TARGET, host: 'db.example.invalid' },
    { ...SHADOW_TARGET, port: 3306 },
  ]) {
    const db = createFakeDatabase();
    await withServer({ getConfig: () => config, getPool: () => db.pool }, async (baseUrl) => {
      const result = await getJson(baseUrl, '/api/shadow/master-offices/summary');
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'shadow_target_not_allowed');
    });
    assert.equal(db.connections, 0);
  }
});

test('verifikasi identitas database aktif dan menolak mismatch secara aman', async () => {
  const db = createFakeDatabase({ target: false });
  await withServer({ getConfig: () => ({ ...SHADOW_TARGET }), getPool: () => db.pool }, async (baseUrl) => {
    const result = await getJson(baseUrl, '/api/shadow/master-rmft/summary');
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'shadow_target_not_allowed');
    assert.equal(result.body.message.includes('dashboard_funding'), false);
  });
  assert.ok(db.statements.every(isReadOnlySql));
});

test('skema hilang/tidak sesuai memberi error generik tanpa detail tabel atau data personal', async () => {
  const db = createFakeDatabase({ schema: false });
  await withServer({ getConfig: () => ({ ...SHADOW_TARGET }), getPool: () => db.pool }, async (baseUrl) => {
    const result = await getJson(baseUrl, '/api/shadow/master-offices/summary');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'shadow_schema_mismatch');
    assert.equal(JSON.stringify(result.body).includes('PN'), false);
  });
  assert.ok(db.statements.every(isReadOnlySql));
});

test('kesalahan query database tidak membocorkan pesan mentah', async () => {
  const db = createFakeDatabase({ queryFailure: new Error('secret PN personal value') });
  await withServer({ getConfig: () => ({ ...SHADOW_TARGET }), getPool: () => db.pool }, async (baseUrl) => {
    const result = await getJson(baseUrl, '/api/shadow/master-rmft/summary');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'shadow_read_failed');
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
  });
  assert.ok(db.statements.every(isReadOnlySql));
});

test('menerima hanya GET dan validasi port server shadow', async () => {
  const db = createFakeDatabase();
  await withServer({ getConfig: () => ({ ...SHADOW_TARGET }), getPool: () => db.pool }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/shadow/master-offices/summary`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 405);
    assert.equal(body.error, 'method_not_allowed');
  });
  assert.equal(getShadowPort({}).toString(), '8788');
  assert.equal(getShadowPort({ SHADOW_API_PORT: '8790' }), 8790);
  assert.throws(() => getShadowPort({ SHADOW_API_PORT: '0' }), /port TCP yang valid/);
});
