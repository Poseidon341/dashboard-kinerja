import { APPRAISAL_EXPECTED_HEADERS } from '../server/imports/appraisal-importer.mjs';

const legacyBase = process.argv[2] || 'http://127.0.0.1:8787';
const mysqlBase = process.argv[3] || 'http://127.0.0.1:8788';
async function get(base, path) {
  const response = await fetch(new URL(path, base));
  const payload = await response.json();
  if (!response.ok) throw new Error(`Endpoint Appraisal tidak tersedia (HTTP ${response.status}).`);
  return payload;
}
const legacySources = await get(legacyBase, '/api/appraisal/sources');
const mysqlSources = await get(mysqlBase, '/api/appraisal/sources');
const key = (source) => `${source.period}|${source.type}`;
const legacyByKey = new Map((legacySources.sources ?? []).map((source) => [key(source), source]));
const mysqlByKey = new Map((mysqlSources.sources ?? []).map((source) => [key(source), source]));
const sourceKeys = [...new Set([...legacyByKey.keys(), ...mysqlByKey.keys()])].sort();
const summary = [];
for (const sourceKey of sourceKeys) {
  const oldSource = legacyByKey.get(sourceKey); const newSource = mysqlByKey.get(sourceKey);
  if (!oldSource || !newSource) { summary.push({ source: sourceKey, missingSource: true }); continue; }
  const [period, type] = sourceKey.split('|');
  const query = new URLSearchParams({ period, type, limit: '500', offset: '0' });
  const [oldPayload, newPayload] = await Promise.all([get(legacyBase, `/api/appraisal/data?${query}`), get(mysqlBase, `/api/appraisal/data?${query}`)]);
  const oldRows = new Map((oldPayload.records ?? []).map((record) => [Number(record.sourceRow), record]));
  const newRows = new Map((newPayload.records ?? []).map((record) => [Number(record.sourceRow), record]));
  let missingRows = 0; let extraRows = 0; let mismatchedCells = 0;
  for (const [rowNumber, oldRecord] of oldRows) {
    const newRecord = newRows.get(rowNumber);
    if (!newRecord) { missingRows += 1; continue; }
    for (const field of APPRAISAL_EXPECTED_HEADERS) if (JSON.stringify(oldRecord[field] ?? null) !== JSON.stringify(newRecord[field] ?? null)) mismatchedCells += 1;
  }
  for (const rowNumber of newRows.keys()) if (!oldRows.has(rowNumber)) extraRows += 1;
  summary.push({ source: sourceKey, legacyRows: oldPayload.recordCount, mysqlRows: newPayload.recordCount, missingRows, extraRows, mismatchedCells });
}
console.log(JSON.stringify({ mode: 'read-only', sourcePairs: summary.length, allMatched: summary.every((item) => !item.missingSource && item.missingRows === 0 && item.extraRows === 0 && item.mismatchedCells === 0), summary }, null, 2));
if (!summary.every((item) => !item.missingSource && item.missingRows === 0 && item.extraRows === 0 && item.mismatchedCells === 0)) process.exitCode = 1;
