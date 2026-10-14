import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { executeOfficeImport, prepareOfficeSnapshot, UKER_PARSER_VERSION } from '../server/imports/uker-importer.mjs';
import { assertExpectedImportTarget, MysqlUkerRepository } from '../server/imports/mysql-uker-repository.mjs';
import { readDashboardWorkbookSheet } from '../server/imports/dashboard-workbook-adapter.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = resolve(projectRoot, 'data/import/dashboard_funding.xlsx');
const sheetName = 'uker_list';
const args = process.argv.slice(2);

function printUsage() {
  console.log('Pemakaian: npm run db:import:uker [-- --dry-run]');
  console.log('Mode apply importer Excel ini dibatasi ke dashboard_funding_test (host 127.0.0.1, port 3308).');
  console.log('Untuk penerapan eksplisit: npm run db:import:uker -- --apply --confirm-target dashboard_funding_test');
  console.log('Sumber: data/import/dashboard_funding.xlsx, sheet uker_list; source_row_number dimulai dari 1 untuk data pertama setelah header.');
}

function parseArguments(values) {
  if (values.includes('--help')) return { help: true, apply: false };
  const apply = values.includes('--apply');
  const dryRun = values.includes('--dry-run');
  const confirmationIndex = values.indexOf('--confirm-target');
  const confirmation = confirmationIndex >= 0 ? values[confirmationIndex + 1] : undefined;
  if (confirmationIndex >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (values.some((value) => !allowed.has(value)) || values.filter((value) => value === '--confirm-target').length > 1) {
    throw new Error('Argumen tidak dikenal. Gunakan --help untuk petunjuk.');
  }
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') {
    throw new Error('Importer XLSX hanya menerima --confirm-target dashboard_funding_test.');
  }
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

try {
  const options = parseArguments(args);
  if (options.help) {
    printUsage();
  } else {
    const workbook = await readDashboardWorkbookSheet(sourcePath, sheetName, {
      expectedHeaders: ['BRANCH CODE', 'BRANCH', 'BRANCH TYPE', 'MAIN BRANCH CODE', 'AREA', 'MAIN BRANCH CLASS', 'Rural Urban'],
    });
    const snapshot = prepareOfficeSnapshot(workbook.recordsJson, {
      checksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes,
    });
    const report = {
      source: 'data/import/dashboard_funding.xlsx', sheet: sheetName, headers: workbook.headers,
      parserVersion: UKER_PARSER_VERSION,
      sourceBytes: workbook.sourceSizeBytes,
      sha256: snapshot.checksum,
      counts: snapshot.counts,
      stagingRows: snapshot.rows.length,
      relationshipRows: snapshot.relationships.length,
      selfReferencesSkipped: snapshot.rows.filter((row) => row.code === row.mainCode).length,
      validationErrorCount: snapshot.errors.length,
      validationErrors: snapshot.errors.slice(0, 30),
      mode: options.apply ? 'apply' : 'dry-run',
    };
    console.log(JSON.stringify(report, null, 2));
    if (snapshot.errors.length) process.exitCode = 1;
    else if (options.apply) {
      const config = getDatabaseConfig();
      assertExpectedImportTarget(config);
      if (config.database !== options.confirmation) {
        throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
      }
      const pool = getDatabasePool();
      const repository = new MysqlUkerRepository(pool, config);
      try {
        const result = await executeOfficeImport(snapshot, repository);
        console.log(JSON.stringify({ result }, null, 2));
      } finally {
        await closeDatabasePool();
      }
    }
  }
} catch (error) {
  const safeMessage = error?.name === 'OfficeSourceValidationError' || error?.name === 'ImportTargetMismatchError'
    ? error.message
    : error?.code
      ? 'Proses impor gagal; periksa status batch dan catatan isu tanpa menampilkan detail koneksi.'
      : error?.message || 'Impor gagal.';
  const safeError = {
    error: error?.name || 'ImportError',
    message: safeMessage,
    code: typeof error?.code === 'string' ? error.code : undefined,
    validationErrors: Array.isArray(error?.validationErrors) ? error.validationErrors.slice(0, 30) : undefined,
  };
  console.error(JSON.stringify(safeError, null, 2));
  process.exitCode = 1;
}
