import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPRAISAL_EXPECTED_HEADERS } from '../server/imports/appraisal-importer.mjs';
import { readAppraisalXlsxSnapshot } from '../server/imports/appraisal-xlsx-adapter.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = process.argv[2] || 'http://127.0.0.1:8788';
const officeWorkbook = await readDashboardWorkbookSheet(path.join(root, 'data', 'import', 'dashboard_funding.xlsx'), 'uker_list', {
  expectedHeaders: ['BRANCH CODE', 'BRANCH TYPE'],
});
const offices = JSON.parse(officeWorkbook.recordsJson);
const knownOfficeTypes = new Map(offices.map((row) => [String(row['BRANCH CODE'] ?? '').trim(), String(row['BRANCH TYPE'] ?? '').trim().toUpperCase()]));
const snapshot = await readAppraisalXlsxSnapshot(path.join(root, 'data', 'import', 'appraisal.xlsx'), { knownOfficeTypes });
const summary = [];
const profileHeaders = new Set(['Nama RM', 'PN', 'Kode KC', 'Kantor Cabang', 'Kode Uker', 'Unit Kerja', 'Jabatan', 'JG']);
const actualMetricHeaders = new Set(APPRAISAL_EXPECTED_HEADERS.filter((field) => !profileHeaders.has(field)
  && !field.startsWith('Target ') && !field.startsWith('% Realisasi ') && !field.startsWith('Score ')
  && field !== 'Score' && field !== 'Tier'));

function isDateLike(field, value, xlsxType) {
  return /tanggal|date|periode|period/i.test(field) || xlsxType === 'd'
    || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value));
}

function classifyDifference(field, xlsxValue, mysqlValue, metadata) {
  const xlsxType = metadata?.types?.[field];
  if (isDateLike(field, xlsxValue, xlsxType) || isDateLike(field, mysqlValue, null)) return 'date';
  if (xlsxValue !== null && mysqlValue !== null
    && Number.isFinite(Number(xlsxValue)) && Number.isFinite(Number(mysqlValue))
    && Number(xlsxValue) === Number(mysqlValue)) return 'numeric_type';
  if (metadata?.cachedFormulaFields?.includes(field)) return 'formula_cached';
  if (actualMetricHeaders.has(field)) return 'actual_value';
  if (profileHeaders.has(field)) return 'identity_or_profile';
  return 'other';
}

for (const sheet of snapshot.sheets) {
  const period = sheet.rows[0]?.sourcePeriod?.slice(0, 7);
  const type = sheet.rows[0]?.sourceType;
  if (!period || !type) throw new Error('Metadata periode/tipe XLSX tidak tersedia.');
  const stagedByRow = new Map();
  let offset = 0;
  let recordCount = null;
  do {
    const query = new URLSearchParams({ period, type, limit: '500', offset: String(offset) });
    const response = await fetch(new URL(`/api/appraisal/data?${query}`, base));
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload?.records) || !Number.isSafeInteger(payload.recordCount)) {
      throw new Error(`Sumber Appraisal MySQL tidak tersedia (HTTP ${response.status}).`);
    }
    if (recordCount !== null && payload.recordCount !== recordCount) throw new Error('Jumlah sumber Appraisal berubah saat pemeriksaan.');
    recordCount = payload.recordCount;
    for (const row of payload.records) stagedByRow.set(Number(row.sourceRow), row);
    if (payload.records.length === 0 && offset < recordCount) throw new Error('Pagination Appraisal berhenti sebelum semua baris terbaca.');
    offset += payload.records.length;
  } while (offset < (recordCount ?? 0));
  const sourceRows = new Map(sheet.rows.map((row) => [Number(row.sourceRowNumber), row.rawValues]));
  let missingRows = 0; let extraRows = 0; let mismatchedCells = 0;
  const fieldsWithDifferences = new Set();
  const byCategory = Object.create(null);
  const byColumn = Object.create(null);
  for (const [rowNumber, local] of sourceRows) {
    const staged = stagedByRow.get(rowNumber);
    if (!staged) { missingRows += 1; continue; }
    for (const field of APPRAISAL_EXPECTED_HEADERS) {
      const xlsxValue = local[field] ?? null;
      const mysqlValue = staged[field] ?? null;
      if (JSON.stringify(xlsxValue) !== JSON.stringify(mysqlValue)) {
        mismatchedCells += 1;
        fieldsWithDifferences.add(field);
        const category = classifyDifference(field, xlsxValue, mysqlValue, local.sourceCellMetadata);
        byCategory[category] = (byCategory[category] ?? 0) + 1;
        // Personal identifiers and names are grouped without emitting their field names.
        const column = profileHeaders.has(field) ? 'identity_or_profile_fields' : field;
        byColumn[column] = (byColumn[column] ?? 0) + 1;
      }
    }
  }
  for (const rowNumber of stagedByRow.keys()) if (!sourceRows.has(rowNumber)) extraRows += 1;
  summary.push({ period, type, xlsxRows: sourceRows.size, mysqlStagedRows: recordCount, missingRows, extraRows, mismatchedCells,
    differingFieldCount: fieldsWithDifferences.size, differencesByCategory: byCategory,
    differencesByColumn: Object.entries(byColumn).sort(([a], [b]) => a.localeCompare(b)).map(([column, count]) => ({ column, count })) });
}
const totalsByCategory = Object.create(null);
for (const source of summary) for (const [category, count] of Object.entries(source.differencesByCategory)) totalsByCategory[category] = (totalsByCategory[category] ?? 0) + count;
console.log(JSON.stringify({ mode: 'read-only', comparedSources: summary.length, totalXlsxRows: summary.reduce((n, row) => n + row.xlsxRows, 0), totalMysqlRows: summary.reduce((n, row) => n + row.mysqlStagedRows, 0), totalMismatchedCells: summary.reduce((n, row) => n + row.mismatchedCells, 0), differencesByCategory: totalsByCategory, allMatched: summary.every((row) => row.missingRows === 0 && row.extraRows === 0 && row.mismatchedCells === 0), summary }, null, 2));
