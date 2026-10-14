import { getDatabaseConfig, getDatabasePool } from './db.js';

export const FUNDING_API_TARGET = Object.freeze({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' });
export const POSITION_FACT_EXPECTED_ROWS = 1_039_742;

// Completed source snapshots are immutable. Keep only the active snapshot's grouped
// rows in process memory so menu changes do not rescan and regroup one million facts.
let positionRowsCache = null;
let positionRowsLoad = null;

export function clearPositionRowsCacheForTests() {
  positionRowsCache = null;
  positionRowsLoad = null;
}

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'finished_at'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_object: ['object_id', 'source_checksum', 'source_row_count'],
  dashboard_fact_position_daily: ['object_id', 'source_row_number', 'position_date', 'office_id', 'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label', 'account_count', 'balance', 'parse_status', 'mapping_status'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
  dashboard_dim_office_version: ['office_id', 'office_type', 'office_name', 'area_name', 'source_object_id'],
});

export class FundingApiTargetError extends Error {
  constructor() {
    super('API Posisi Dana hanya tersedia untuk database pengujian lokal yang diizinkan.');
    this.name = 'FundingApiTargetError';
    this.code = 'FUNDING_TARGET_NOT_ALLOWED';
  }
}

export function assertFundingApiTarget(config) {
  if (!['127.0.0.1', 'localhost'].includes(String(config?.host ?? '').trim().toLowerCase())
    || Number(config?.port) !== FUNDING_API_TARGET.port
    || config?.database !== FUNDING_API_TARGET.database) throw new FundingApiTargetError();
}

async function assertActualTarget(connection) {
  const [rows] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (rows?.[0]?.database_name !== FUNDING_API_TARGET.database || Number(rows?.[0]?.server_port) !== FUNDING_API_TARGET.port) {
    throw new FundingApiTargetError();
  }
}

async function verifySchema(connection) {
  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tableNames.map(() => '?').join(',')})`, tableNames,
  );
  const columns = new Map();
  for (const row of rows) {
    if (!columns.has(row.TABLE_NAME)) columns.set(row.TABLE_NAME, new Set());
    columns.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }
  const missing = Object.entries(REQUIRED_COLUMNS).flatMap(([table, required]) => required
    .filter((column) => !columns.get(table)?.has(column)).map((column) => `${table}.${column}`));
  if (missing.length) {
    const error = new Error('Skema API Posisi Dana belum sesuai.');
    error.name = 'FundingApiSchemaError';
    error.missing = missing;
    throw error;
  }
}

const SNAPSHOT_SQL = `
  SELECT o.object_id,o.source_checksum,o.source_row_count,b.batch_id
  FROM dashboard_source_registry s
  JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
  JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='segmen_data.json'
  JOIN dashboard_import_object o ON o.object_id=oi.object_id
  WHERE s.source_key='segmen_data_json'
  ORDER BY b.finished_at DESC,o.object_id DESC LIMIT 1`;

const OFFICE_VERSION_SQL = `
  SELECT oi.object_id
  FROM dashboard_domain_publication p
  JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
  JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='uker_list.json'
  WHERE p.domain_key='office_master' AND p.scope_key='default' LIMIT 1`;

export async function readPositionSummary(connection) {
  const [snapshots] = await connection.execute(SNAPSHOT_SQL);
  if (snapshots.length !== 1 || Number(snapshots[0].source_row_count) !== POSITION_FACT_EXPECTED_ROWS) {
    const error = new Error('Snapshot fakta Posisi Dana belum lengkap.');
    error.name = 'FundingApiDataError';
    throw error;
  }
  const snapshot = snapshots[0];
  return {
    sourceObjectId: String(snapshot.object_id), batchId: String(snapshot.batch_id), checksum: snapshot.source_checksum,
    sourceRows: Number(snapshot.source_row_count),
  };
}

function validatePositionRows(snapshot, rows) {
  const totals = rows.reduce((result, row) => {
    result.factRows += row.sourceRows;
    result.resolvedRows += row.resolvedRows;
    result.unresolvedRows += row.unresolvedRows;
    result.inconsistentRows += row.inconsistentRows;
    result.invalidRows += row.invalidRows;
    return result;
  }, { factRows: 0, resolvedRows: 0, unresolvedRows: 0, inconsistentRows: 0, invalidRows: 0 });
  // uq_position_source_row (object_id, source_row_number) guarantees one fact per source row.
  // The grouped source-row total therefore validates completeness without a second full scan.
  if (totals.factRows !== POSITION_FACT_EXPECTED_ROWS || totals.factRows !== snapshot.sourceRows
    || totals.resolvedRows !== 1_038_051 || totals.unresolvedRows !== 1_691
    || totals.inconsistentRows !== 0 || totals.invalidRows !== 0) {
    const error = new Error('Jumlah atau status fakta Posisi Dana tidak sesuai validasi snapshot.');
    error.name = 'FundingApiDataError';
    throw error;
  }
  return totals;
}

export async function readPositionRows(connection, snapshot) {
  const [officeObjects] = await connection.execute(OFFICE_VERSION_SQL);
  if (officeObjects.length !== 1) {
    const error = new Error('Snapshot master kantor aktif tidak dapat ditentukan.');
    error.name = 'FundingApiDataError';
    throw error;
  }
  const cacheKey = `${snapshot.sourceObjectId}:${snapshot.checksum}:${officeObjects[0].object_id}`;
  if (positionRowsCache?.key === cacheKey) return { rows: positionRowsCache.rows, cacheHit: true, ...positionRowsCache.totals };
  if (positionRowsLoad?.key === cacheKey) return { ...(await positionRowsLoad.promise), cacheHit: true };
  const promise = (async () => {
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(f.position_date,'%Y-%m-%d') AS Posisi,
            f.source_segment_label AS \`Segmentasi BPR\`,
            f.source_product_label AS Produk,
            f.source_branch_label AS \`Nama Cabang\`,
            f.source_office_label AS \`Nama Uker\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.account_count ELSE 0 END),0) AS \`Jumlah Rekening\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.balance ELSE 0 END),0) AS Saldo,
            f.office_id AS officeId,
            CASE WHEN f.office_id IS NULL THEN 'unresolved' ELSE 'resolved' END AS mappingStatus,
            MAX(v.office_type) AS officeType,
            MAX(v.office_name) AS officeName,
            MAX(v.area_name) AS areaName,
            COUNT(*) AS sourceRows,
            SUM(f.mapping_status='resolved' AND f.office_id IS NOT NULL) AS resolvedRows,
            SUM(f.mapping_status='unresolved' AND f.office_id IS NULL) AS unresolvedRows,
            SUM(NOT ((f.mapping_status='resolved' AND f.office_id IS NOT NULL)
                     OR (f.mapping_status='unresolved' AND f.office_id IS NULL))) AS inconsistentRows,
            SUM(f.parse_status<>'valid') AS invalidRows
     FROM dashboard_fact_position_daily f
     LEFT JOIN dashboard_dim_office_version v ON v.office_id=f.office_id AND v.source_object_id=?
     WHERE f.object_id=?
     GROUP BY f.position_date,f.office_id,f.source_segment_label,f.source_product_label,
              f.source_branch_label,f.source_office_label
     ORDER BY f.position_date,f.source_branch_label,f.source_office_label,f.source_segment_label,f.source_product_label`,
    [officeObjects[0].object_id, snapshot.sourceObjectId],
  );
  const records = rows.map((row) => ({
    ...row,
    Posisi: row.Posisi instanceof Date ? row.Posisi.toISOString().slice(0, 10) : String(row.Posisi).slice(0, 10),
    'Jumlah Rekening': Number(row['Jumlah Rekening']),
    Saldo: Number(row.Saldo),
    officeId: row.officeId == null ? null : String(row.officeId),
    sourceRows: Number(row.sourceRows),
    resolvedRows: Number(row.resolvedRows),
    unresolvedRows: Number(row.unresolvedRows),
    inconsistentRows: Number(row.inconsistentRows),
    invalidRows: Number(row.invalidRows),
  }));
  const totals = validatePositionRows(snapshot, records);
  // Internal validation columns are not part of the established client payload.
  const publicRows = records.map(({ resolvedRows, unresolvedRows, inconsistentRows, invalidRows, ...row }) => row);
  positionRowsCache = { key: cacheKey, rows: publicRows, totals };
  return { rows: publicRows, ...totals };
  })();
  positionRowsLoad = { key: cacheKey, promise };
  try {
    return { ...(await promise), cacheHit: false };
  } finally {
    if (positionRowsLoad?.promise === promise) positionRowsLoad = null;
  }
}

function sendJson(response, status, body, timing = {}) {
  const serializationStarted = performance.now();
  const serialized = JSON.stringify(body);
  const serializeMs = performance.now() - serializationStarted;
  const timingHeader = [
    timing.snapshotMs != null && `snapshot;dur=${timing.snapshotMs.toFixed(1)}`,
    timing.aggregateMs != null && `aggregate;dur=${timing.aggregateMs.toFixed(1)}`,
    `serialize;dur=${serializeMs.toFixed(1)}`,
    timing.cacheHit != null && `cache;desc="${timing.cacheHit ? 'hit' : 'miss'}"`,
  ].filter(Boolean).join(', ');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(timingHeader ? { 'Server-Timing': timingHeader } : {}) });
  response.end(serialized);
}

export function createFundingPositionHandler(dependencies = {}) {
  const getConfig = dependencies.getConfig || getDatabaseConfig;
  const getPool = dependencies.getPool || getDatabasePool;
  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const paths = ['/api/funding/positions', '/api/funding/detail-unit/positions'];
    if (!paths.includes(url.pathname)) return false;
    if (request.method !== 'GET') return sendJson(response, 405, { status: 'error', error: 'method_not_allowed' });
    let connection;
    try {
      const snapshotStarted = performance.now();
      assertFundingApiTarget(getConfig());
      connection = await getPool().getConnection();
      await assertActualTarget(connection);
      await verifySchema(connection);
      const snapshot = await readPositionSummary(connection);
      const snapshotMs = performance.now() - snapshotStarted;
      const detailOnly = url.pathname === '/api/funding/detail-unit/positions';
      const aggregateStarted = performance.now();
      const dataset = await readPositionRows(connection, snapshot);
      const aggregateMs = performance.now() - aggregateStarted;
      const records = detailOnly ? dataset.rows.filter(row => row['Segmentasi BPR'] === 'MIKRO' && row.Produk === 'TABUNGAN') : dataset.rows;
      const recordCount = records.reduce((total, row) => total + row.sourceRows, 0);
      if (!detailOnly && recordCount !== POSITION_FACT_EXPECTED_ROWS) throw new Error('Agregasi API kehilangan sebagian baris sumber.');
      return sendJson(response, 200, { status: 'ok', source: 'mysql-test-facts', snapshot: {
        sourceRows: snapshot.sourceRows, factRows: dataset.factRows, sourceChecksum: snapshot.checksum,
        resolvedRows: dataset.resolvedRows, unresolvedRows: dataset.unresolvedRows,
      }, aggregateRows: records.length, recordCount, records }, { snapshotMs, aggregateMs, cacheHit: dataset.cacheHit });
    } catch (error) {
      if (error instanceof FundingApiTargetError) return sendJson(response, 403, { status: 'unavailable', error: 'funding_target_not_allowed', message: error.message });
      if (error?.name === 'FundingApiSchemaError' || ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.code)) {
        return sendJson(response, 503, { status: 'unavailable', error: 'funding_schema_mismatch', message: 'Skema API Posisi Dana belum sesuai.' });
      }
      if (error?.name === 'FundingApiDataError') return sendJson(response, 503, { status: 'unavailable', error: 'funding_data_not_ready', message: error.message });
      return sendJson(response, 503, { status: 'unavailable', error: 'funding_read_failed', message: 'Data Posisi Dana dari MySQL tidak dapat dibaca.' });
    } finally {
      connection?.release();
    }
  };
}
