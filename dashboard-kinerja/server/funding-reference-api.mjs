import { getDatabaseConfig, getDatabasePool } from './db.js';
import { assertFundingApiTarget, FundingApiTargetError } from './funding-position-api.mjs';
import { assertActualRuntimeTarget, RuntimeTargetError } from './runtime-target.mjs';

const REQUIRED = Object.freeze({
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
});

const OFFICE_SNAPSHOT_SQL = `
  SELECT b.batch_id,o.object_id,o.source_row_count,o.source_checksum
  FROM dashboard_domain_publication p
  JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
  JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='uker_list.json'
  JOIN dashboard_import_object o ON o.object_id=oi.object_id
  WHERE p.domain_key='office_master' AND p.scope_key='default' LIMIT 1`;
const RMFT_SNAPSHOT_SQL = `
  SELECT b.batch_id,o.object_id,o.source_row_count,o.source_checksum
  FROM dashboard_domain_publication p
  JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
  JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='rmft_list.json'
  JOIN dashboard_import_object o ON o.object_id=oi.object_id
  WHERE p.domain_key='rmft_master' AND p.scope_key='default' LIMIT 1`;

async function verifyActualTarget(connection, config, env) {
  try { await assertActualRuntimeTarget(connection, config, env); }
  catch (error) { if (error instanceof RuntimeTargetError) throw new FundingApiTargetError(); throw error; }
}

async function verifySchema(connection) {
  const tables = Object.keys(REQUIRED);
  const [rows] = await connection.execute(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
  const found = new Map();
  for (const row of rows) { if (!found.has(row.TABLE_NAME)) found.set(row.TABLE_NAME, new Set()); found.get(row.TABLE_NAME).add(row.COLUMN_NAME); }
  const missing = Object.entries(REQUIRED).flatMap(([table, columns]) => columns.filter((column) => !found.get(table)?.has(column)));
  if (missing.length) { const error = new Error('Skema sumber API Funding belum sesuai.'); error.name = 'FundingReferenceSchemaError'; throw error; }
}

async function getPublishedSnapshot(connection, query) {
  const [rows] = await connection.execute(query);
  if (rows.length !== 1) { const error = new Error('Snapshot sumber belum dipublikasikan.'); error.name = 'FundingReferenceDataError'; throw error; }
  return rows[0];
}

function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { const error = new Error(`Data raw ${label} tidak dapat dibaca.`); error.name = 'FundingReferenceDataError'; throw error; }
}

async function readPublishedRawRows(connection, { snapshotSql, table, countColumn = 'parse_status', validValue = 'valid' }) {
  const snapshot = await getPublishedSnapshot(connection, snapshotSql);
  const [counts] = await connection.execute(`SELECT COUNT(*) AS total,SUM(${countColumn}<>?) AS invalid_rows FROM ${table} WHERE object_id=?`, [validValue, snapshot.object_id]);
  if (Number(counts[0]?.total) !== Number(snapshot.source_row_count) || Number(counts[0]?.invalid_rows ?? 0) !== 0) {
    const error = new Error('Snapshot sumber belum lolos validasi jumlah/baris.'); error.name = 'FundingReferenceDataError'; throw error;
  }
  const [rows] = await connection.execute(`SELECT source_row_number,raw_record FROM ${table} WHERE object_id=? ORDER BY source_row_number`, [snapshot.object_id]);
  if (rows.length !== Number(snapshot.source_row_count)) { const error = new Error('Jumlah baris sumber berubah saat dibaca.'); error.name = 'FundingReferenceDataError'; throw error; }
  return { snapshot, records: rows.map((row) => parseJson(row.raw_record, table)) };
}

async function readLatestCompletedObject(connection, sourceKey, objectKey) {
  const [rows] = await connection.execute(
    `SELECT b.batch_id,o.object_id,o.source_row_count,o.source_checksum
     FROM dashboard_source_registry s JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
     JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key=?
     JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE s.source_key=? ORDER BY b.finished_at DESC,o.object_id DESC LIMIT 1`, [objectKey, sourceKey],
  );
  if (rows.length !== 1) { const error = new Error('Snapshot sumber lengkap tidak tersedia.'); error.name = 'FundingReferenceDataError'; throw error; }
  return rows[0];
}

async function readRka(connection) {
  const snapshot = await readLatestCompletedObject(connection, 'tabel_rka_json', 'tabel_rka.json');
  const [counts] = await connection.execute("SELECT COUNT(*) AS total,SUM(parse_status<>'valid') AS invalid_rows FROM dashboard_stg_rka_row WHERE object_id=?", [snapshot.object_id]);
  if (Number(counts[0]?.total) !== Number(snapshot.source_row_count) || Number(counts[0]?.invalid_rows ?? 0) !== 0) throw Object.assign(new Error('Snapshot RKA belum lolos validasi.'), { name: 'FundingReferenceDataError' });
  const [rows] = await connection.execute('SELECT raw_record FROM dashboard_stg_rka_row WHERE object_id=? ORDER BY source_row_number', [snapshot.object_id]);
  return rows.map((row) => parseJson(row.raw_record, 'RKA'));
}

async function readPrognosis(connection) {
  const snapshot = await readLatestCompletedObject(connection, 'prognosa_data_json', 'prognosa_data.json::KOMITMEN BO');
  const [batchObjects] = await connection.execute(
    `SELECT oi.object_key,o.object_id,o.source_row_count
     FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE oi.batch_id=? AND oi.object_key IN ('prognosa_data.json::KOMITMEN SBO','prognosa_data.json::KOMITMEN BO','prognosa_data.json::Per AH','prognosa_data.json::PER RMFT')`, [snapshot.batch_id],
  );
  if (batchObjects.length !== 4) throw Object.assign(new Error('Snapshot Prognosa tidak memuat empat sheet yang disetujui.'), { name: 'FundingReferenceDataError' });
  const sheets = {};
  for (const object of batchObjects) {
    const [counts] = await connection.execute("SELECT COUNT(*) AS total,SUM(row_status<>'valid') AS invalid_rows FROM dashboard_stg_prognosis_row WHERE object_id=?", [object.object_id]);
    if (Number(counts[0]?.total) !== Number(object.source_row_count) || Number(counts[0]?.invalid_rows ?? 0) !== 0) throw Object.assign(new Error('Snapshot Prognosa belum lolos validasi.'), { name: 'FundingReferenceDataError' });
    const [rows] = await connection.execute('SELECT raw_row FROM dashboard_stg_prognosis_row WHERE object_id=? ORDER BY source_row_number', [object.object_id]);
    const sheetName = object.object_key.slice('prognosa_data.json::'.length);
    sheets[sheetName] = { rows: rows.map((row) => parseJson(row.raw_row, 'Prognosa')) };
  }
  return { sheets };
}

async function readAppraisalSources(connection) {
  const [rows] = await connection.execute(
    `SELECT b.batch_id,o.object_id,o.source_row_count,s.source_key
     FROM dashboard_source_registry s JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
     JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id
     JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE s.source_key IN ('appraisal_xlsx','appraisal_google_sheets')
       AND o.source_row_count>0 ORDER BY b.finished_at DESC,o.object_id DESC`,
  );
  const batchByPeriodType = new Map();
  for (const object of rows) {
    const [periods] = await connection.execute(
      `SELECT DATE_FORMAT(source_period,'%Y-%m-%d') AS source_period,source_type,source_sheet,COUNT(*) AS record_count,SUM(schema_status<>'valid') AS invalid_count
       FROM dashboard_stg_appraisal_row WHERE object_id=? GROUP BY source_period,source_type,source_sheet`, [object.object_id],
    );
    for (const period of periods) {
      if (Number(period.record_count) !== Number(object.source_row_count) || Number(period.invalid_count ?? 0) !== 0) {
        const error = new Error('Snapshot Appraisal belum lolos validasi jumlah/baris.'); error.name = 'FundingReferenceDataError'; throw error;
      }
      const key = `${String(period.source_period).slice(0, 7)}|${period.source_type}`;
      if (!batchByPeriodType.has(key)) batchByPeriodType.set(key, { ...object, ...period });
    }
  }
  return [...batchByPeriodType.values()].map((row) => ({
    period: String(row.source_period).slice(0, 7), year: Number(String(row.source_period).slice(0, 4)), month: String(row.source_period).slice(5, 7),
    type: row.source_type, sheetName: row.source_sheet, sheetId: 0, rowCount: Number(row.record_count),
    objectId: row.object_id, batchId: row.batch_id, invalidCount: Number(row.invalid_count ?? 0),
  })).sort((a, b) => b.period.localeCompare(a.period) || a.type.localeCompare(b.type));
}

function parseLimit(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : null;
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

export function createFundingReferenceHandler(dependencies = {}) {
  const getConfig = dependencies.getConfig || getDatabaseConfig;
  const getPool = dependencies.getPool || getDatabasePool;
  const env = dependencies.env || process.env;
  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const paths = ['/api/funding/master/offices', '/api/funding/master/rmft', '/api/funding/rka', '/api/funding/prognosis', '/api/appraisal/sources', '/api/appraisal/data'];
    if (!paths.includes(url.pathname)) return false;
    if (request.method !== 'GET') { json(response, 405, { status: 'error', error: 'method_not_allowed' }); return true; }
    let connection;
    try {
      const config = getConfig();
      assertFundingApiTarget(config, env);
      connection = await getPool().getConnection();
      await verifyActualTarget(connection, config, env);
      await verifySchema(connection);
      let payload;
      if (url.pathname === '/api/funding/master/offices') {
        const result = await readPublishedRawRows(connection, { snapshotSql: OFFICE_SNAPSHOT_SQL, table: 'dashboard_stg_office_row' });
        payload = { status: 'ok', source: 'mysql-test-master', recordCount: result.records.length, records: result.records };
      } else if (url.pathname === '/api/funding/master/rmft') {
        const result = await readPublishedRawRows(connection, { snapshotSql: RMFT_SNAPSHOT_SQL, table: 'dashboard_stg_rmft_row' });
        payload = { status: 'ok', source: 'mysql-test-master', recordCount: result.records.length, records: result.records };
      } else if (url.pathname === '/api/funding/rka') {
        const records = await readRka(connection); payload = { status: 'ok', source: 'mysql-test-staging', recordCount: records.length, records };
      } else if (url.pathname === '/api/funding/prognosis') {
        payload = { status: 'ok', source: 'mysql-test-staging', ...(await readPrognosis(connection)) };
      } else {
        const sources = await readAppraisalSources(connection);
        if (url.pathname.endsWith('/sources')) payload = { status: 'ok', sources: sources.map(({ objectId, batchId, invalidCount, ...source }) => source) };
        else {
          const period = url.searchParams.get('period'); const type = url.searchParams.get('type');
          const limit = parseLimit(url.searchParams.get('limit'), 200, 500); const offset = parseLimit(url.searchParams.get('offset'), 0, 1000000);
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '') || !['RO', 'KP'].includes(type || '')) { json(response, 400, { error: 'invalid_source', message: 'Gunakan period=YYYY-MM dan type=RO atau KP.' }); return true; }
          if (limit === null || offset === null) { json(response, 400, { error: 'invalid_pagination', message: 'Parameter limit/offset tidak valid.' }); return true; }
          const source = sources.find((item) => item.period === period && item.type === type);
          if (!source) { json(response, 404, { error: 'source_not_found', message: 'Periode dan tipe tidak tersedia pada staging MySQL.' }); return true; }
          if (source.invalidCount) throw Object.assign(new Error('Snapshot Appraisal mengandung baris yang belum lolos schema.'), { name: 'FundingReferenceDataError' });
          const [rows] = await connection.execute('SELECT raw_record FROM dashboard_stg_appraisal_row WHERE object_id=? AND schema_status=\'valid\' ORDER BY source_row_number LIMIT ? OFFSET ?', [source.objectId, limit, offset]);
          payload = { source: { period, type, sheetName: source.sheetName }, recordCount: source.rowCount,
            pagination: { limit, offset, returned: rows.length }, records: rows.map((row) => parseJson(row.raw_record, 'Appraisal')) };
        }
      }
      json(response, 200, payload); return true;
    } catch (error) {
      if (error instanceof FundingApiTargetError) json(response, 403, { status: 'unavailable', error: 'funding_target_not_allowed', message: error.message });
      else if (error?.name === 'FundingReferenceSchemaError' || ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.code)) json(response, 503, { status: 'unavailable', error: 'funding_schema_mismatch', message: 'Skema sumber API Funding belum sesuai.' });
      else json(response, 503, { status: 'unavailable', error: 'funding_data_not_ready', message: error?.name === 'FundingReferenceDataError' ? error.message : 'Sumber Funding dari MySQL tidak dapat dibaca.' });
      return true;
    } finally { connection?.release(); }
  };
}

// Exported for local unit tests; query dependencies remain SELECT-only.
export const fundingReferenceInternals = Object.freeze({ REQUIRED, readPublishedRawRows, readLatestCompletedObject, readRka, readPrognosis, readAppraisalSources });
