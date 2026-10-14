import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeAppraisalStage } from '../server/imports/appraisal-importer.mjs';
import { APPRAISAL_XLSX_PARSER_VERSION, APPRAISAL_XLSX_SOURCE_KEY, APPRAISAL_XLSX_SOURCE_SYSTEM, readAppraisalXlsxSnapshot } from '../server/imports/appraisal-xlsx-adapter.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = path.join(root, 'data', 'import', 'appraisal.xlsx');
const officeWorkbookPath = path.join(root, 'data', 'import', 'dashboard_funding.xlsx');

export function parseArguments(args) {
  if (args.includes('--help')) return { help: true, apply: false };
  const apply = args.includes('--apply'); const dryRun = args.includes('--dry-run');
  const index = args.indexOf('--confirm-target'); const confirmation = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal.');
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('Apply XLSX Appraisal hanya mengizinkan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

function officeTypes(recordsJson) {
  const offices = JSON.parse(recordsJson);
  if (!Array.isArray(offices)) throw new Error('Master kantor lokal tidak valid.');
  return new Map(offices.map((row) => [String(row?.['BRANCH CODE'] ?? '').trim(), String(row?.['BRANCH TYPE'] ?? '').trim().toUpperCase()]));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Pemakaian: npm.cmd run db:import:appraisal-xlsx -- [--dry-run]');
    console.log('Apply staging saja: npm.cmd run db:import:appraisal-xlsx -- --apply --confirm-target dashboard_funding_test');
    return;
  }
  const officeSheet = await readDashboardWorkbookSheet(officeWorkbookPath, 'uker_list', {
    expectedHeaders: ['BRANCH CODE', 'BRANCH TYPE'],
  });
  const knownOfficeTypes = officeTypes(officeSheet.recordsJson);
  const snapshot = await readAppraisalXlsxSnapshot(sourcePath, { knownOfficeTypes });
  const report = {
    source: 'data/import/appraisal.xlsx', parserVersion: APPRAISAL_XLSX_PARSER_VERSION,
    sourceBytes: snapshot.sourceSizeBytes, sha256: snapshot.checksum, mode: options.apply ? 'apply' : 'dry-run',
    sheets: snapshot.sheets.map((sheet) => ({
      name: sheet.sheetName, period: sheet.period, type: sheet.type,
      physicalDataRows: sheet.physicalDataRows, selectedRecords: sheet.sourceRowCount,
      schema: '62/62 expected headers valid',
      cachedFormulaFields: sheet.rows.reduce((sum, row) => sum + (row.rawValues.sourceCellMetadata?.cachedFormulaFields?.length ?? 0), 0),
    })),
    totalSelectedRecords: snapshot.totalRows, officeCodeMapping: snapshot.officeMapping,
    valueTypes: snapshot.valueTypes, checksumScope: 'whole workbook bytes; per-sheet checksums retained in objects',
    facts: 'not created', publication: 'none',
  };
  if (options.apply) {
    const { closeDatabasePool, getDatabaseConfig, getDatabasePool } = await import('../server/db.js');
    const { assertAppraisalTestTarget, MysqlAppraisalRepository } = await import('../server/imports/mysql-appraisal-repository.mjs');
    const config = getDatabaseConfig(); assertAppraisalTestTarget(config);
    if (config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
    const repository = new MysqlAppraisalRepository(getDatabasePool(), config);
    try {
      report.stageResult = await executeAppraisalStage(snapshot, repository, {
        parserVersion: APPRAISAL_XLSX_PARSER_VERSION,
        sourceKey: APPRAISAL_XLSX_SOURCE_KEY, sourceSystem: APPRAISAL_XLSX_SOURCE_SYSTEM,
        registryType: 'xlsx_file', displayName: 'Appraisal XLSX (staging)', sourceLocation: 'data/import/appraisal.xlsx',
      });
    } finally { await closeDatabasePool(); }
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(JSON.stringify({ error: error?.name ?? 'AppraisalXlsxImportError', message: error?.name === 'ImportTargetMismatchError' ? error.message : (error?.message ?? 'Dry-run XLSX Appraisal gagal.') }));
    process.exitCode = 1;
  }
}
