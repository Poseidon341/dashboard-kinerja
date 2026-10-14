import { createHash } from 'node:crypto';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';

const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308 || config.database !== 'dashboard_funding_test') {
  throw new Error('Pemeriksaan API hanya diizinkan pada dashboard_funding_test lokal port 3308.');
}
const base = process.argv[2] || 'http://127.0.0.1:8788';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(rows) { return createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex'); }
async function api(path) {
  const response = await fetch(new URL(path, base)); const payload = await response.json();
  if (!response.ok || payload?.status !== 'ok') throw new Error(`Endpoint ${path} belum siap (HTTP ${response.status}).`);
  return payload;
}
async function latestObject(connection, sourceKey, objectKey, publishedDomain = null) {
  const publicationJoin = publishedDomain
    ? `JOIN dashboard_domain_publication p ON p.batch_id=b.batch_id AND p.domain_key=? AND p.scope_key='default'`
    : '';
  const params = publishedDomain ? [publishedDomain, objectKey, sourceKey] : [objectKey, sourceKey];
  const [rows] = await connection.execute(
    `SELECT o.object_id,o.source_row_count FROM dashboard_source_registry s
     JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed' ${publicationJoin}
     JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key=?
     JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE s.source_key=? ORDER BY b.finished_at DESC,o.object_id DESC LIMIT 1`, params,
  );
  if (rows.length !== 1) throw new Error('Snapshot MySQL tidak tersedia untuk pembanding API.');
  return rows[0];
}
async function rawRows(connection, table, column, objectId) {
  const [rows] = await connection.execute(`SELECT ${column} AS raw_value FROM ${table} WHERE object_id=? ORDER BY source_row_number`, [objectId]);
  return rows.map((row) => JSON.parse(row.raw_value));
}
function compare(source, remote) {
  return { sourceRows: source.length, apiRows: remote.length, match: source.length === remote.length && digest(source) === digest(remote) };
}

const pool = getDatabasePool();
let connection;
try {
  connection = await pool.getConnection();
  const [identity] = await connection.execute('SELECT DATABASE() AS database_name,@@port AS server_port');
  if (identity[0]?.database_name !== 'dashboard_funding_test' || Number(identity[0]?.server_port) !== 3308) throw new Error('Koneksi aktual bukan database pengujian yang diizinkan.');
  const checks = [];
  for (const source of [
    { key: 'offices', sourceKey: 'uker_list_json', objectKey: 'uker_list.json', table: 'dashboard_stg_office_row', column: 'raw_record', domain: 'office_master', endpoint: '/api/funding/master/offices' },
    { key: 'rmft', sourceKey: 'rmft_list_json', objectKey: 'rmft_list.json', table: 'dashboard_stg_rmft_row', column: 'raw_record', domain: 'rmft_master', endpoint: '/api/funding/master/rmft' },
    { key: 'rka', sourceKey: 'tabel_rka_json', objectKey: 'tabel_rka.json', table: 'dashboard_stg_rka_row', column: 'raw_record', endpoint: '/api/funding/rka' },
  ]) {
    const snapshot = await latestObject(connection, source.sourceKey, source.objectKey, source.domain ?? null);
    const dbRows = await rawRows(connection, source.table, source.column, snapshot.object_id);
    const payload = await api(source.endpoint);
    checks.push({ source: source.key, ...compare(dbRows, payload.records ?? []) });
  }
  const prognosisSnapshot = await latestObject(connection, 'prognosa_data_json', 'prognosa_data.json::KOMITMEN BO');
  const [objects] = await connection.execute(
    `SELECT o.object_id,oi.object_key FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE oi.batch_id=(SELECT batch_id FROM dashboard_import_object_identity WHERE object_id=? LIMIT 1)
       AND oi.object_key IN ('prognosa_data.json::KOMITMEN SBO','prognosa_data.json::KOMITMEN BO','prognosa_data.json::Per AH','prognosa_data.json::PER RMFT')
     ORDER BY oi.object_key`, [prognosisSnapshot.object_id],
  );
  const prognosisApi = await api('/api/funding/prognosis');
  const sheets = [
    ['KOMITMEN SBO', 'prognosa_data.json::KOMITMEN SBO'], ['KOMITMEN BO', 'prognosa_data.json::KOMITMEN BO'],
    ['Per AH', 'prognosa_data.json::Per AH'], ['PER RMFT', 'prognosa_data.json::PER RMFT'],
  ];
  if (objects.length !== 4) throw new Error('Snapshot Prognosa MySQL tidak memuat empat sheet yang diperlukan.');
  for (const [name, key] of sheets) {
    const object = objects.find((row) => row.object_key === key);
    const dbRows = await rawRows(connection, 'dashboard_stg_prognosis_row', 'raw_row', object.object_id);
    checks.push({ source: `prognosis:${name}`, ...compare(dbRows, prognosisApi.sheets?.[name]?.rows ?? []) });
  }
  console.log(JSON.stringify({ mode: 'read-only API-vs-MySQL parity', database: 'dashboard_funding_test', checks, allMatched: checks.every((check) => check.match) }, null, 2));
  if (!checks.every((check) => check.match)) process.exitCode = 1;
} finally {
  connection?.release();
  await closeDatabasePool();
}
