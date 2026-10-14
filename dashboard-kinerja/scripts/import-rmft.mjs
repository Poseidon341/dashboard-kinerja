import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { executeRmftImport, prepareRmftSnapshot, RMFT_PARSER_VERSION } from '../server/imports/rmft-importer.mjs';
import { MysqlRmftRepository } from '../server/imports/mysql-rmft-repository.mjs';
import { assertExpectedImportTarget } from '../server/imports/mysql-uker-repository.mjs';
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
  const allowedArgs = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowedArgs.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) {
    throw new Error('Argumen tidak dikenal. Gunakan --help untuk petunjuk.');
  }
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('--confirm-target harus dashboard_funding_test untuk importer XLSX ini.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

function officeCodesFromSource(bytes) {
  const records = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(records)) throw new Error('Sheet master unit kerja tidak valid.');
  return new Set(records
    .map((record) => record?.['BRANCH CODE'])
    .filter((code) => typeof code === 'string' || (typeof code === 'number' && Number.isSafeInteger(code)))
    .map(String));
}

function usage() {
  console.log('Pemakaian: npm.cmd run db:import:rmft -- --dry-run');
  console.log('Mode apply importer XLSX ini dibatasi ke dashboard_funding_test pada 127.0.0.1:3308.');
  console.log('Apply (harus sama dengan MYSQL_DATABASE aktif): npm.cmd run db:import:rmft -- --apply --confirm-target dashboard_funding_test');
  console.log('Sumber: data/import/dashboard_funding.xlsx, sheet rmft_list; source_row_number dimulai dari 1 untuk data pertama setelah header.');
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    const [rmftWorkbook, officeWorkbook] = await Promise.all([
      readDashboardWorkbookSheet(workbookPath, 'rmft_list', { expectedHeaders: ['PN', 'Nama', 'JG', 'Jabatan', 'Kode Uker'] }),
      readDashboardWorkbookSheet(workbookPath, 'uker_list', { expectedHeaders: ['BRANCH CODE'] }),
    ]);
    const knownOfficeCodes = officeCodesFromSource(officeWorkbook.recordsJson);
    const snapshot = prepareRmftSnapshot(rmftWorkbook.recordsJson, {
      knownOfficeCodes, checksum: rmftWorkbook.checksum, sourceSizeBytes: rmftWorkbook.sourceSizeBytes,
      expectedSnapshot: { records: 190, uniqueUnitCodes: 59, unresolved854: 0 },
    });
    console.log(JSON.stringify({
      source: 'data/import/dashboard_funding.xlsx', sheet: 'rmft_list', headers: rmftWorkbook.headers,
      parserVersion: RMFT_PARSER_VERSION,
      sourceBytes: rmftWorkbook.sourceSizeBytes,
      sha256: snapshot.checksum,
      counts: snapshot.counts,
      stagingRows: snapshot.rows.length,
      validationErrorCount: snapshot.errors.length,
      validationErrors: snapshot.errors.slice(0, 30),
      mode: options.apply ? 'apply' : 'dry-run',
    }, null, 2));
    if (snapshot.errors.length) process.exitCode = 1;
    else if (options.apply) {
      const config = getDatabaseConfig();
      assertExpectedImportTarget(config);
      if (config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
      const pool = getDatabasePool();
      const repository = new MysqlRmftRepository(pool, config);
      try {
        const result = await executeRmftImport(snapshot, repository);
        console.log(JSON.stringify({ result }, null, 2));
      } finally {
        await closeDatabasePool();
      }
    }
  }
} catch (error) {
  const safeMessage = error?.name === 'RmftSourceValidationError' || error?.name === 'ImportTargetMismatchError'
    ? error.message
    : error?.code
      ? 'Proses impor RMFT gagal; periksa status batch dan catatan isu tanpa menampilkan detail koneksi.'
      : error?.message || 'Impor RMFT gagal.';
  console.error(JSON.stringify({
    error: error?.name || 'RmftImportError',
    message: safeMessage,
    code: typeof error?.code === 'string' ? error.code : undefined,
    validationErrors: Array.isArray(error?.validationErrors) ? error.validationErrors.slice(0, 30) : undefined,
  }, null, 2));
  process.exitCode = 1;
}
