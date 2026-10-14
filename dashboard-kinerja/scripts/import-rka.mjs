import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { executeRkaStage, prepareRkaSnapshot, RKA_MONTHS, RKA_PARSER_VERSION } from '../server/imports/rka-importer.mjs';
import { MysqlRkaRepository } from '../server/imports/mysql-rka-repository.mjs';
import { assertRkaTestTarget } from '../server/imports/mysql-rka-repository.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workbookPath = resolve(projectRoot, 'data/import/dashboard_funding.xlsx');

function parseArguments(args) {
  if (args.includes('--help')) return { help: true, apply: false };
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const confirmationIndex = args.indexOf('--confirm-target');
  const confirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : undefined;
  if (confirmationIndex >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal. Gunakan --help untuk petunjuk.');
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('Importer RKA tahap ini hanya mengizinkan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

function officeCodesFromSource(bytes) {
  const rows = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('Sheet master unit kerja tidak valid.');
  return new Set(rows.map((row) => row?.['BRANCH CODE'])
    .filter((code) => typeof code === 'string' || (typeof code === 'number' && Number.isSafeInteger(code)))
    .map(String));
}

function usage() {
  console.log('Pemakaian: npm.cmd run db:import:rka -- --dry-run');
  console.log('Dry-run membaca sheet tabel_rka dan uker_list dari data/import/dashboard_funding.xlsx secara lokal, tanpa koneksi database.');
  console.log('Apply hanya ke database uji (tidak dijalankan dalam tahap ini): npm.cmd run db:import:rka -- --apply --confirm-target dashboard_funding_test');
  console.log('source_row_number adalah posisi record dalam array JSON, dimulai dari 1.');
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) usage();
  else {
    const [rkaWorkbook, officeWorkbook] = await Promise.all([
      readDashboardWorkbookSheet(workbookPath, 'tabel_rka', { expectedHeaders: ['NO URUT', 'RKA KEY', 'MATA ANGGARAN', 'KODE UKER', ...RKA_MONTHS] }),
      readDashboardWorkbookSheet(workbookPath, 'uker_list', { expectedHeaders: ['BRANCH CODE'] }),
    ]);
    const snapshot = prepareRkaSnapshot(rkaWorkbook.recordsJson, {
      knownOfficeCodes: officeCodesFromSource(officeWorkbook.recordsJson),
      checksum: rkaWorkbook.checksum, sourceSizeBytes: rkaWorkbook.sourceSizeBytes,
    });
    const report = {
      source: 'data/import/dashboard_funding.xlsx', sheet: 'tabel_rka', headers: rkaWorkbook.headers,
      parserVersion: RKA_PARSER_VERSION,
      sourceBytes: rkaWorkbook.sourceSizeBytes, sha256: snapshot.checksum,
      counts: snapshot.summary, categories: snapshot.categories,
      sourceRowNumber: 'array-index + 1', rawRecordPreserved: true,
      categoryMetricMapping: 'unresolved; not published to dashboard_rka_metric_mapping',
      monthlyFactPublication: 'none; dashboard_fact_rka_target is not written',
      validationErrorCount: snapshot.errors.length,
      validationErrors: snapshot.errors.slice(0, 30),
      mode: options.apply ? 'apply' : 'dry-run',
    };
    console.log(JSON.stringify(report, null, 2));
    if (snapshot.errors.length && !options.apply) process.exitCode = 1;
    else if (options.apply) {
      const config = getDatabaseConfig();
      assertRkaTestTarget(config);
      if (config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
      const pool = getDatabasePool();
      const repository = new MysqlRkaRepository(pool, config);
      try {
        const result = await executeRkaStage(snapshot, repository);
        console.log(JSON.stringify({ result }, null, 2));
        if (result.status === 'validation_failed') process.exitCode = 1;
      } finally { await closeDatabasePool(); }
    }
  }
} catch (error) {
  const safeMessage = error?.name === 'ImportTargetMismatchError' || error?.name === 'RkaSourceValidationError'
    ? error.message
    : error?.code
      ? 'Proses staging RKA gagal; periksa status batch dan catatan isu tanpa menampilkan detail koneksi.'
      : error?.message || 'Staging RKA gagal.';
  console.error(JSON.stringify({
    error: error?.name || 'RkaImportError', message: safeMessage,
    code: typeof error?.code === 'string' ? error.code : undefined,
    validationErrors: Array.isArray(error?.validationErrors) ? error.validationErrors.slice(0, 30) : undefined,
  }, null, 2));
  process.exitCode = 1;
}
