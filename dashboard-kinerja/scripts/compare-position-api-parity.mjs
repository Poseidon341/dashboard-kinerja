import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';

const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308 || config.database !== 'dashboard_funding_test') {
  throw new Error('Pemeriksaan Posisi Dana hanya diizinkan pada dashboard_funding_test lokal port 3308.');
}
const apiBase = process.argv[2] || 'http://127.0.0.1:8788';

async function loadApi(path) {
  const response = await fetch(new URL(path, apiBase)); const payload = await response.json();
  if (!response.ok || payload?.status !== 'ok' || !Array.isArray(payload.records)) throw new Error(`Endpoint ${path} belum siap (HTTP ${response.status}).`);
  return payload;
}
function key(row) {
  return JSON.stringify([row.Posisi,row['Segmentasi BPR'],row.Produk,row['Nama Cabang'],row['Nama Uker'],row.officeId]);
}
function comparable(row) {
  return [key(row), Number(row['Jumlah Rekening']), Number(row.Saldo), row.mappingStatus,
    Number(row.sourceRows), Number(row.resolvedRows), Number(row.unresolvedRows), Number(row.inconsistentRows), Number(row.invalidRows)];
}
function compare(left, right) {
  if (left.length !== right.length) return { databaseGroups: left.length, apiGroups: right.length, mismatchedGroups: Math.abs(left.length-right.length) };
  const rightByKey = new Map(right.map((row) => [key(row), comparable(row)])); let mismatchedGroups=0;
  for (const row of left) {
    const expected = comparable(row); const actual = rightByKey.get(key(row));
    if (!actual || expected.some((value,index) => value !== actual[index])) mismatchedGroups++;
  }
  return { databaseGroups: left.length, apiGroups: right.length, mismatchedGroups };
}

const pool = getDatabasePool(); let connection;
try {
  connection = await pool.getConnection();
  const [identity] = await connection.execute('SELECT DATABASE() AS database_name,@@port AS server_port');
  if (identity[0]?.database_name !== 'dashboard_funding_test' || Number(identity[0]?.server_port)!==3308) throw new Error('Koneksi aktual bukan database pengujian yang diizinkan.');
  const [snapshotRows] = await connection.execute(
    `SELECT o.object_id,o.source_row_count,o.source_checksum FROM dashboard_source_registry s
     JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
     JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='segmen_data.json'
     JOIN dashboard_import_object o ON o.object_id=oi.object_id
     WHERE s.source_key='segmen_data_json' ORDER BY b.finished_at DESC,o.object_id DESC LIMIT 1`,
  );
  if (snapshotRows.length!==1) throw new Error('Snapshot fakta Posisi Dana tidak ditemukan.');
  const [officeRows] = await connection.execute(
    `SELECT oi.object_id FROM dashboard_domain_publication p
     JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
     JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='uker_list.json'
     WHERE p.domain_key='office_master' AND p.scope_key='default' LIMIT 1`,
  );
  if (officeRows.length!==1) throw new Error('Snapshot master kantor aktif tidak ditemukan.');
  const snapshot=snapshotRows[0];
  const [directRows] = await connection.execute(
    `SELECT DATE_FORMAT(f.position_date,'%Y-%m-%d') AS Posisi,
            f.source_segment_label AS \`Segmentasi BPR\`, f.source_product_label AS Produk,
            f.source_branch_label AS \`Nama Cabang\`, f.source_office_label AS \`Nama Uker\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.account_count ELSE 0 END),0) AS \`Jumlah Rekening\`,
            COALESCE(SUM(CASE WHEN f.parse_status='valid' THEN f.balance ELSE 0 END),0) AS Saldo,
            f.office_id AS officeId,CASE WHEN f.office_id IS NULL THEN 'unresolved' ELSE 'resolved' END AS mappingStatus,
            MAX(v.office_type) AS officeType,MAX(v.office_name) AS officeName,MAX(v.area_name) AS areaName,
            COUNT(*) AS sourceRows,SUM(f.mapping_status='resolved' AND f.office_id IS NOT NULL) AS resolvedRows,
            SUM(f.mapping_status='unresolved' AND f.office_id IS NULL) AS unresolvedRows,
            SUM(NOT ((f.mapping_status='resolved' AND f.office_id IS NOT NULL) OR (f.mapping_status='unresolved' AND f.office_id IS NULL))) AS inconsistentRows,
            SUM(f.parse_status<>'valid') AS invalidRows
     FROM dashboard_fact_position_daily f
     LEFT JOIN dashboard_dim_office_version v ON v.office_id=f.office_id AND v.source_object_id=?
     WHERE f.object_id=?
     GROUP BY f.position_date,f.office_id,f.source_segment_label,f.source_product_label,f.source_branch_label,f.source_office_label
     ORDER BY f.position_date,f.source_branch_label,f.source_office_label,f.source_segment_label,f.source_product_label`,
    [officeRows[0].object_id,snapshot.object_id],
  );
  const direct=directRows.map((row)=>({...row,
    Posisi: row.Posisi instanceof Date ? row.Posisi.toISOString().slice(0,10) : String(row.Posisi).slice(0,10),
    'Jumlah Rekening':Number(row['Jumlah Rekening']),Saldo:Number(row.Saldo),officeId:row.officeId==null?null:String(row.officeId),
    sourceRows:Number(row.sourceRows),resolvedRows:Number(row.resolvedRows),unresolvedRows:Number(row.unresolvedRows),
    inconsistentRows:Number(row.inconsistentRows),invalidRows:Number(row.invalidRows),
  }));
  const [allPayload,detailPayload]=await Promise.all([loadApi('/api/funding/positions'),loadApi('/api/funding/detail-unit/positions')]);
  const detailDirect=direct.filter((row)=>row['Segmentasi BPR']==='MIKRO'&&row.Produk==='TABUNGAN');
  const checks=[{scope:'all',...compare(direct,allPayload.records)},{scope:'detail-unit',...compare(detailDirect,detailPayload.records)}];
  const allMatched=checks.every((item)=>item.mismatchedGroups===0)
    && allPayload.recordCount===Number(snapshot.source_row_count)
    && allPayload.snapshot?.sourceChecksum===snapshot.source_checksum;
  console.log(JSON.stringify({mode:'read-only API-vs-MySQL parity',database:'dashboard_funding_test',sourceRows:Number(snapshot.source_row_count),apiRows:allPayload.recordCount,
    unresolvedRows:allPayload.snapshot?.unresolvedRows,checks,allMatched,comparisonBasis:'API response against direct SELECT aggregation from the same published MySQL facts; no JSON source comparison'},null,2));
  if(!allMatched) process.exitCode=1;
} finally { connection?.release(); await closeDatabasePool(); }
