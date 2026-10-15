import http from 'node:http';
import { getDatabaseConfig, getDatabasePool } from './db.js';
import { createFundingPositionHandler } from './funding-position-api.mjs';
import { createFundingReferenceHandler } from './funding-reference-api.mjs';
import { createAdminUploadHandler } from './admin-upload-api.mjs';
import { resolveRuntimeTarget, assertActualRuntimeTarget, RuntimeTargetError } from './runtime-target.mjs';

export const SHADOW_TARGET = Object.freeze({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' });

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
  dashboard_import_object: ['object_id', 'batch_id'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_dim_office_version: ['office_version_id', 'office_id', 'office_type', 'observed_at', 'source_object_id'],
  dashboard_office_relationship: ['relationship_id', 'child_office_id', 'parent_office_id', 'relationship_type', 'observed_at', 'verification_status', 'source_object_id'],
  dashboard_dim_rmft: ['rmft_id', 'source_system', 'pn'],
  dashboard_rmft_assignment: ['assignment_id', 'rmft_id', 'office_id', 'source_unit_code', 'mapping_status', 'observed_at', 'source_object_id'],
});

export class ShadowTargetError extends Error {
  constructor(code = 'SHADOW_TARGET_NOT_ALLOWED') {
    super('Shadow API hanya tersedia untuk target database runtime yang diizinkan.');
    this.name = 'ShadowTargetError';
    this.code = code;
  }
}

export function assertShadowTarget(config, env = process.env) {
  try { return resolveRuntimeTarget(config, env); }
  catch { throw new ShadowTargetError(); }
}

async function assertActualDatabase(connection, config, env) {
  try { await assertActualRuntimeTarget(connection, config, env); }
  catch (error) { if (error instanceof RuntimeTargetError) throw new ShadowTargetError('SHADOW_ACTIVE_DATABASE_MISMATCH'); throw error; }
}

async function verifySchema(connection) {
  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const placeholders = tableNames.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    tableNames,
  );
  const found = new Map();
  for (const row of rows) {
    if (!found.has(row.TABLE_NAME)) found.set(row.TABLE_NAME, new Set());
    found.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }
  const valid = Object.entries(REQUIRED_COLUMNS).every(([table, columns]) => (
    columns.every((column) => found.get(table)?.has(column))
  ));
  if (!valid) {
    const error = new Error('Skema shadow tidak sesuai.');
    error.name = 'ShadowSchemaError';
    error.code = 'SHADOW_SCHEMA_MISMATCH';
    throw error;
  }
}

async function withReadConnection({ getConfig, getPool, env = process.env }, callback) {
  const config = getConfig();
  assertShadowTarget(config, env);
  const connection = await getPool().getConnection();
  try {
    await assertActualDatabase(connection, config, env);
    await verifySchema(connection);
    return await callback(connection);
  } finally {
    connection.release();
  }
}

async function readOfficeSummary(connection) {
  const [officeRows] = await connection.execute(
    `SELECT COUNT(DISTINCT d.office_id) AS office_count,
            COUNT(DISTINCT d.source_code) AS unique_code_count,
            SUM(v.office_type = 'KC') AS kc_count,
            SUM(v.office_type = 'KCP') AS kcp_count,
            SUM(v.office_type = 'UNIT') AS unit_count,
            COUNT(DISTINCT v.office_version_id) AS published_version_count
     FROM dashboard_domain_publication p
     JOIN dashboard_import_object io ON io.batch_id = p.batch_id
     JOIN dashboard_dim_office_version v ON v.source_object_id = io.object_id
     JOIN dashboard_dim_office d ON d.office_id = v.office_id
     WHERE p.domain_key = 'office_master' AND p.scope_key = 'default'`,
  );
  const [versionRows] = await connection.execute(
    'SELECT COUNT(*) AS version_count FROM dashboard_dim_office_version',
  );
  const [relationRows] = await connection.execute(
    `SELECT COUNT(*) AS relationship_count
     FROM dashboard_domain_publication p
     JOIN dashboard_import_object io ON io.batch_id = p.batch_id
     JOIN dashboard_office_relationship r ON r.source_object_id = io.object_id
     WHERE p.domain_key = 'office_master' AND p.scope_key = 'default'
       AND r.child_office_id <> r.parent_office_id`,
  );
  const [typeRows] = await connection.execute(
    `SELECT child_v.office_type AS child_type, parent_v.office_type AS parent_type,
            COUNT(*) AS relationship_count
     FROM dashboard_domain_publication p
     JOIN dashboard_import_object io ON io.batch_id = p.batch_id
     JOIN dashboard_office_relationship r ON r.source_object_id = io.object_id
     JOIN dashboard_dim_office_version child_v
       ON child_v.office_id = r.child_office_id AND child_v.source_object_id = io.object_id
     JOIN dashboard_dim_office_version parent_v
       ON parent_v.office_id = r.parent_office_id AND parent_v.source_object_id = io.object_id
     WHERE p.domain_key = 'office_master' AND p.scope_key = 'default'
       AND r.child_office_id <> r.parent_office_id
     GROUP BY child_v.office_type, parent_v.office_type
     ORDER BY child_v.office_type, parent_v.office_type`,
  );
  const offices = officeRows?.[0] || {};
  return {
    officeCount: Number(offices.office_count || 0),
    uniqueCodeCount: Number(offices.unique_code_count || 0),
    byType: {
      KC: Number(offices.kc_count || 0),
      KCP: Number(offices.kcp_count || 0),
      UNIT: Number(offices.unit_count || 0),
    },
    relationshipCount: Number(relationRows?.[0]?.relationship_count || 0),
    relationshipsByOfficeTypes: (typeRows || []).map((row) => ({
      childType: row.child_type ?? null,
      parentType: row.parent_type ?? null,
      count: Number(row.relationship_count || 0),
    })),
    publishedVersionCount: Number(offices.published_version_count || 0),
    totalVersionCount: Number(versionRows?.[0]?.version_count || 0),
  };
}

async function readRmftSummary(connection) {
  const [summaryRows] = await connection.execute(
    `WITH ranked_assignments AS (
       SELECT a.assignment_id, a.rmft_id, a.office_id, a.source_unit_code,
              ROW_NUMBER() OVER (PARTITION BY a.rmft_id ORDER BY a.observed_at DESC, a.assignment_id DESC) AS snapshot_rank
       FROM dashboard_domain_publication p
       JOIN dashboard_import_object io ON io.batch_id = p.batch_id
       JOIN dashboard_rmft_assignment a ON a.source_object_id = io.object_id
       WHERE p.domain_key = 'rmft_master' AND p.scope_key = 'default'
     ), active_assignments AS (
       SELECT assignment_id, rmft_id, office_id, source_unit_code
       FROM ranked_assignments WHERE snapshot_rank = 1
     )
     SELECT COUNT(DISTINCT r.rmft_id) AS rmft_count,
            COUNT(DISTINCT r.pn) AS unique_pn_count,
            SUM(a.office_id IS NOT NULL) AS mapped_assignment_count,
            SUM(a.office_id IS NULL) AS unresolved_assignment_count
     FROM active_assignments a
     JOIN dashboard_dim_rmft r ON r.rmft_id = a.rmft_id
    `,
  );
  const [unresolvedRows] = await connection.execute(
    `WITH ranked_assignments AS (
       SELECT a.assignment_id, a.rmft_id, a.office_id, a.source_unit_code,
              ROW_NUMBER() OVER (PARTITION BY a.rmft_id ORDER BY a.observed_at DESC, a.assignment_id DESC) AS snapshot_rank
       FROM dashboard_domain_publication p
       JOIN dashboard_import_object io ON io.batch_id = p.batch_id
       JOIN dashboard_rmft_assignment a ON a.source_object_id = io.object_id
       WHERE p.domain_key = 'rmft_master' AND p.scope_key = 'default'
     ), active_assignments AS (
       SELECT assignment_id, rmft_id, office_id, source_unit_code
       FROM ranked_assignments WHERE snapshot_rank = 1
     )
     SELECT source_unit_code AS office_code, COUNT(*) AS assignment_count
     FROM active_assignments
     WHERE office_id IS NULL
     GROUP BY source_unit_code
     ORDER BY source_unit_code`,
  );
  const summary = summaryRows?.[0] || {};
  return {
    rmftCount: Number(summary.rmft_count || 0),
    uniquePnCount: Number(summary.unique_pn_count || 0),
    mappedAssignmentCount: Number(summary.mapped_assignment_count || 0),
    unresolvedAssignmentCount: Number(summary.unresolved_assignment_count || 0),
    unresolvedByOfficeCode: (unresolvedRows || []).map((row) => ({
      officeCode: row.office_code ?? null,
      count: Number(row.assignment_count || 0),
    })),
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function createShadowRequestHandler(dependencies = {}) {
  const adminHandler = createAdminUploadHandler(dependencies);
  const fundingHandler = createFundingPositionHandler(dependencies);
  const referenceHandler = createFundingReferenceHandler(dependencies);
  const deps = {
    getConfig: dependencies.getConfig || getDatabaseConfig,
    getPool: dependencies.getPool || getDatabasePool,
    env: dependencies.env || process.env,
  };
  return async function handleShadowRequest(request, response) {
    const adminHandled = await adminHandler(request, response);
    if (adminHandled !== false) return;
    const fundingHandled = await fundingHandler(request, response);
    if (fundingHandled !== false) return;
    const referenceHandled = await referenceHandler(request, response);
    if (referenceHandled !== false) return;
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed', message: 'Endpoint hanya menerima GET.' });
      return;
    }
    const officePath = '/api/shadow/master-offices/summary';
    const rmftPath = '/api/shadow/master-rmft/summary';
    if (url.pathname !== officePath && url.pathname !== rmftPath) {
      sendJson(response, 404, { error: 'not_found', message: 'Endpoint tidak ditemukan.' });
      return;
    }
    try {
      const result = await withReadConnection(deps, url.pathname === officePath ? readOfficeSummary : readRmftSummary);
      sendJson(response, 200, { status: 'ok', source: 'mysql-shadow', ...result });
    } catch (error) {
      if (error instanceof ShadowTargetError) {
        sendJson(response, 403, { status: 'unavailable', error: 'shadow_target_not_allowed', message: error.message });
        return;
      }
      if (error?.name === 'ShadowSchemaError' || error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR') {
        sendJson(response, 503, { status: 'unavailable', error: 'shadow_schema_mismatch', message: 'Skema database pengujian belum sesuai untuk ringkasan shadow.' });
        return;
      }
      sendJson(response, 503, { status: 'unavailable', error: 'shadow_read_failed', message: 'Ringkasan shadow tidak dapat dibaca.' });
    }
  };
}

export function createShadowServer(dependencies = {}) {
  const handler = createShadowRequestHandler(dependencies);
  return http.createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { status: 'error', error: 'internal_error', message: 'Permintaan tidak dapat diproses.' });
      else response.destroy();
    });
  });
}
