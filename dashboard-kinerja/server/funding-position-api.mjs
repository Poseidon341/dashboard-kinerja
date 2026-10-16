import { getDatabaseConfig, getDatabasePool } from './db.js';
import { resolveRuntimeTarget, assertActualRuntimeTarget, RuntimeTargetError } from './runtime-target.mjs';

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
export const invalidatePositionRowsCache = clearPositionRowsCacheForTests;

export function classifySourceOfficeType(label) {
  const value = String(label ?? '').trim().toUpperCase();
  const match = /^(KCP|KK|KC|UNIT)(?:\s|$)/.exec(value);
  return match?.[1] ?? null;
}

export function buildSourceOfficeInventory(rows) {
  const offices = new Map();
  for (const row of rows) {
    const officeLabel = String(row['Nama Uker'] ?? '').trim();
    if (!officeLabel) continue;
    const officeId = row.officeId == null ? null : String(row.officeId);
    const key = `${officeId ?? 'unmapped'}\u0000${officeLabel}`;
    const office = offices.get(key) ?? {
      officeLabel,
      sourceBranchLabel: String(row['Nama Cabang'] ?? '').trim() || null,
      sourceType: classifySourceOfficeType(officeLabel),
      officeId,
      officeCode: row.officeCode == null ? null : String(row.officeCode),
      masterType: row.officeType == null ? null : String(row.officeType),
      masterName: row.officeName == null ? null : String(row.officeName),
      areaName: row.areaName == null ? null : String(row.areaName),
      sourceRows: 0,
      detailMetricGroups: 0,
      detailMetricSourceRows: 0,
    };
    office.sourceRows += Number(row.sourceRows) || 0;
    if (String(row['Segmentasi BPR'] ?? '').trim().toUpperCase() === 'MIKRO'
      && String(row.Produk ?? '').trim().toUpperCase() === 'TABUNGAN') {
      office.detailMetricGroups += 1;
      office.detailMetricSourceRows += Number(row.sourceRows) || 0;
    }
    offices.set(key, office);
  }
  return [...offices.values()].sort((a, b) => a.officeLabel.localeCompare(b.officeLabel, 'id-ID'));
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
    super('API Posisi Dana hanya tersedia untuk target database runtime yang diizinkan.');
    this.name = 'FundingApiTargetError';
    this.code = 'FUNDING_TARGET_NOT_ALLOWED';
  }
}

export function assertFundingApiTarget(config, env = process.env) {
  try { return resolveRuntimeTarget(config, env); }
  catch { throw new FundingApiTargetError(); }
}

async function assertActualTarget(connection, config, env) {
  try { await assertActualRuntimeTarget(connection, config, env); }
  catch (error) { if (error instanceof RuntimeTargetError) throw new FundingApiTargetError(); throw error; }
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
  WHERE s.source_key='segmen_data_json' AND o.source_row_count=1039742
  ORDER BY b.finished_at ASC,o.object_id ASC LIMIT 1`;

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

async function readPublishedPositionScopes(connection) {
  const [rows] = await connection.execute(
    `SELECT p.scope_key AS period,p.batch_id,p.publication_version,i.object_id,o.source_checksum
     FROM dashboard_domain_publication p
     JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
     JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key='segmen_data.json'
     JOIN dashboard_import_object o ON o.object_id=i.object_id
     WHERE p.domain_key='position_daily' AND p.batch_id IS NOT NULL ORDER BY p.scope_key`,
  );
  if (rows.some(row => !/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(row.period))) {
    const error = new Error('Publikasi periode Posisi Dana tidak valid.');
    error.name = 'FundingApiDataError';
    throw error;
  }
  return rows;
}

async function queryPositionGroups(connection, officeObjectId, objectId, period = null) {
  const periodClause = period ? 'AND f.position_date>=? AND f.position_date<?' : '';
  const params = [officeObjectId, objectId];
  if (period) {
    if (period.length === 10) {
      const next = new Date(`${period}T00:00:00.000Z`);
      if (Number.isNaN(next.valueOf()) || next.toISOString().slice(0, 10) !== period) throw new Error('Tanggal publikasi tidak valid.');
      next.setUTCDate(next.getUTCDate() + 1);
      params.push(period, next.toISOString().slice(0, 10));
    } else {
      const [year, month] = period.split('-').map(Number);
      params.push(`${period}-01`, `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`);
    }
  }
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(f.position_date,'%Y-%m-%d') AS Posisi,
            f.source_segment_label AS \`Segmentasi BPR\`,
            f.source_product_label AS Produk,
            f.source_branch_label AS \`Nama Cabang\`,
            f.source_office_label AS \`Nama Uker\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.account_count ELSE 0 END),0) AS \`Jumlah Rekening\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.balance ELSE 0 END),0) AS Saldo,
            f.office_id AS officeId,
            MAX(d.source_code) AS officeCode,
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
     LEFT JOIN dashboard_dim_office d ON d.office_id=f.office_id AND d.source_system='uker_list_json'
     WHERE f.object_id=? ${periodClause}
     GROUP BY f.position_date,f.office_id,f.source_segment_label,f.source_product_label,
              f.source_branch_label,f.source_office_label
     ORDER BY f.position_date,f.source_branch_label,f.source_office_label,f.source_segment_label,f.source_product_label`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    Posisi: row.Posisi instanceof Date ? row.Posisi.toISOString().slice(0, 10) : String(row.Posisi).slice(0, 10),
    'Jumlah Rekening': Number(row['Jumlah Rekening']), Saldo: Number(row.Saldo),
    officeId: row.officeId == null ? null : String(row.officeId),
    officeCode: row.officeCode == null ? null : String(row.officeCode),
    sourceRows: Number(row.sourceRows), resolvedRows: Number(row.resolvedRows),
    unresolvedRows: Number(row.unresolvedRows), inconsistentRows: Number(row.inconsistentRows),
    invalidRows: Number(row.invalidRows),
  }));
}

export async function readPositionRows(connection, snapshot) {
  const [officeObjects] = await connection.execute(OFFICE_VERSION_SQL);
  if (officeObjects.length !== 1) {
    const error = new Error('Snapshot master kantor aktif tidak dapat ditentukan.');
    error.name = 'FundingApiDataError';
    throw error;
  }
  const published = await readPublishedPositionScopes(connection);
  const cacheKey = `${snapshot.sourceObjectId}:${snapshot.checksum}:${officeObjects[0].object_id}:${published.map(row => `${row.period}:${row.object_id}:${row.publication_version}`).join('|')}`;
  if (positionRowsCache?.key === cacheKey) return { rows: positionRowsCache.rows, cacheHit: true, ...positionRowsCache.totals };
  if (positionRowsLoad?.key === cacheKey) return { ...(await positionRowsLoad.promise), cacheHit: true };
  const promise = (async () => {
  const baseRows = await queryPositionGroups(connection, officeObjects[0].object_id, snapshot.sourceObjectId);
  validatePositionRows(snapshot, baseRows);
  const scopedRows = [];
  for (const publication of published) {
    const override = await queryPositionGroups(connection, officeObjects[0].object_id, publication.object_id, publication.period);
    const sourceCount = override.reduce((sum, row) => sum + row.sourceRows, 0);
    if (!sourceCount || override.some(row => row.invalidRows || row.inconsistentRows)) {
      const error = new Error(`Fakta periode ${publication.period} tidak valid.`);
      error.name = 'FundingApiDataError';
      throw error;
    }
    const scopeStart = publication.period.length === 10 ? publication.period : `${publication.period}-01`;
    const scopeEnd = publication.period.length === 10
      ? (() => { const next = new Date(`${publication.period}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); return next.toISOString().slice(0, 10); })()
      : (() => { const [y,m]=publication.period.split('-').map(Number); return `${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}-01`; })();
    const [staging] = await connection.execute(
      `SELECT COUNT(*) AS total FROM dashboard_stg_position_row WHERE object_id=?
       AND parsed_position_date>=? AND parsed_position_date<?`,
      [publication.object_id, scopeStart, scopeEnd],
    );
    if (sourceCount !== Number(staging[0]?.total)) {
      const error = new Error(`Fakta periode ${publication.period} tidak lengkap.`);
      error.name = 'FundingApiDataError';
      throw error;
    }
    scopedRows.push({ scopeKey: publication.period, rows: override });
  }
  const records = overlayPositionScopes(baseRows, scopedRows);
  const totals = records.reduce((out, row) => {
    out.factRows += row.sourceRows; out.resolvedRows += row.resolvedRows; out.unresolvedRows += row.unresolvedRows;
    return out;
  }, { factRows: 0, resolvedRows: 0, unresolvedRows: 0 });
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

export function overlayPositionScopes(baseRows, scopedRows) {
  const months = new Set(scopedRows.filter(item => item.scopeKey.length === 7).map(item => item.scopeKey));
  const dates = new Set(scopedRows.filter(item => item.scopeKey.length === 10).map(item => item.scopeKey));
  const records = baseRows.filter(row => !months.has(row.Posisi.slice(0, 7)) && !dates.has(row.Posisi));
  for (const item of scopedRows) {
    records.push(...(item.scopeKey.length === 7 ? item.rows.filter(row => !dates.has(row.Posisi)) : item.rows));
  }
  return records.sort((a, b) => a.Posisi.localeCompare(b.Posisi));
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
  const env = dependencies.env || process.env;
  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const paths = ['/api/funding/positions', '/api/funding/detail-unit/positions'];
    if (!paths.includes(url.pathname)) return false;
    if (request.method !== 'GET') return sendJson(response, 405, { status: 'error', error: 'method_not_allowed' });
    let connection;
    try {
      const snapshotStarted = performance.now();
      const config = getConfig();
      assertFundingApiTarget(config, env);
      connection = await getPool().getConnection();
      await assertActualTarget(connection, config, env);
      await verifySchema(connection);
      const snapshot = await readPositionSummary(connection);
      const snapshotMs = performance.now() - snapshotStarted;
      const detailOnly = url.pathname === '/api/funding/detail-unit/positions';
      const aggregateStarted = performance.now();
      const dataset = await readPositionRows(connection, snapshot);
      const aggregateMs = performance.now() - aggregateStarted;
      const records = detailOnly ? dataset.rows.filter(row => row['Segmentasi BPR'] === 'MIKRO' && row.Produk === 'TABUNGAN') : dataset.rows;
      const sourceOfficeInventory = detailOnly ? buildSourceOfficeInventory(dataset.rows) : undefined;
      const recordCount = records.reduce((total, row) => total + row.sourceRows, 0);
      if (!detailOnly && recordCount !== dataset.factRows) throw new Error('Agregasi API kehilangan sebagian baris sumber.');
      return sendJson(response, 200, { status: 'ok', source: 'mysql-test-facts', snapshot: {
        sourceRows: snapshot.sourceRows, factRows: dataset.factRows, sourceChecksum: snapshot.checksum,
        resolvedRows: dataset.resolvedRows, unresolvedRows: dataset.unresolvedRows,
      }, aggregateRows: records.length, recordCount, records, ...(detailOnly ? { sourceOfficeInventory } : {}) }, { snapshotMs, aggregateMs, cacheHit: dataset.cacheHit });
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
