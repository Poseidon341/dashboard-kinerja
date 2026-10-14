import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { importPositionFile, POSITION_PARSER_VERSION, scanPositionFile } from '../server/imports/position-importer.mjs';
import { assertPositionTestTarget, MysqlPositionRepository } from '../server/imports/mysql-position-repository.mjs';
import { materializePositionWorkbook } from '../server/imports/position-xlsx-adapter.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = resolve(projectRoot, 'data/import/dashboard_funding.xlsx');

function parseArguments(args) {
  if (args.includes('--help')) return { help: true, apply: false, confirmation: undefined, limit: 1000, fullValidation: false };
  const apply = args.includes('--apply'); const dryRun = args.includes('--dry-run');
  const targetIndex = args.indexOf('--confirm-target'); const confirmation = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
  const limitIndex = args.indexOf('--limit'); const limitText = limitIndex >= 0 ? args[limitIndex + 1] : undefined;
  if (targetIndex >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  if (limitIndex >= 0 && limitText === undefined) throw new Error('--limit memerlukan jumlah baris.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation, '--limit', limitText, '--full-validation']);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1 || args.filter((arg) => arg === '--limit').length > 1) {
    throw new Error('Argumen tidak dikenal. Gunakan --help untuk petunjuk.');
  }
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('Importer Posisi Dana hanya mengizinkan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  if (apply && (limitIndex >= 0 || args.includes('--full-validation'))) throw new Error('Mode apply selalu memvalidasi seluruh workbook; --limit/--full-validation hanya untuk dry-run.');
  if (args.includes('--full-validation') && limitIndex >= 0) throw new Error('Pilih --full-validation atau --limit.');
  if (limitText !== undefined && (!/^\d+$/.test(limitText) || Number(limitText) < 1 || !Number.isSafeInteger(Number(limitText)))) throw new Error('--limit harus bilangan bulat positif.');
  return { help: false, apply, confirmation, limit: args.includes('--full-validation') ? 0 : Number(limitText ?? 1000), fullValidation: args.includes('--full-validation') };
}

function memoryMonitor() {
  let maxRssBytes = process.memoryUsage().rss; let maxHeapUsedBytes = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const usage = process.memoryUsage(); maxRssBytes = Math.max(maxRssBytes, usage.rss); maxHeapUsedBytes = Math.max(maxHeapUsedBytes, usage.heapUsed);
  }, 50);
  return { stop() { clearInterval(timer); const usage = process.memoryUsage(); return {
    maxRssBytes: Math.max(maxRssBytes, usage.rss), maxHeapUsedBytes: Math.max(maxHeapUsedBytes, usage.heapUsed),
  }; } };
}

function usage() {
  console.log('Pemakaian: npm.cmd run db:import:position -- --dry-run [--limit 1000 | --full-validation]');
  console.log('Sumber: data/import/dashboard_funding.xlsx, sheet segmen_data. Dry-run default membaca 1.000 baris pertama tanpa koneksi database.');
  console.log('Validasi workbook penuh satu kali: npm.cmd run db:import:position -- --dry-run --full-validation');
  console.log('Apply (tidak dijalankan dalam tahap ini): hanya dashboard_funding_test dengan konfirmasi eksplisit.');
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) usage();
  else {
    const startedAt = performance.now(); const monitor = memoryMonitor(); let workbook; let outcome;
    try {
      workbook = await materializePositionWorkbook(sourcePath, { limit: options.apply ? 0 : options.limit });
      if (options.apply) {
        const config = getDatabaseConfig(); assertPositionTestTarget(config);
        if (config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
        const repository = new MysqlPositionRepository(getDatabasePool(), config);
        try {
          outcome = await importPositionFile(workbook.path, repository, {
            sourceChecksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes,
            verifySourceUnchanged: workbook.verifyUnchanged,
          });
        } finally { await closeDatabasePool(); }
      } else {
        const summary = await scanPositionFile(workbook.path, {
          expectedRows: workbook.rowCount, strictSnapshot: options.fullValidation,
          sourceChecksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes,
        });
        outcome = { status: 'dry-run', summary };
      }
    } finally {
      const memory = monitor.stop();
      if (workbook) await workbook.cleanup();
      const summary = outcome?.summary;
      console.log(JSON.stringify({
        source: 'data/import/dashboard_funding.xlsx', sheet: 'segmen_data', parserVersion: POSITION_PARSER_VERSION,
        sourceBytes: workbook?.sourceSizeBytes ?? null, elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
        memory, result: outcome ? { status: outcome.status, batchId: outcome.batchId ?? null, rows: outcome.rows ?? summary?.total ?? null, sha256: outcome.checksum ?? summary?.checksum ?? null } : null,
        summary: summary ? {
          total: summary.total, validRows: summary.validRows, invalidRows: summary.invalidRows,
          dateCount: summary.dateCount, dateMin: summary.dateMin, dateMax: summary.dateMax,
          segments: summary.segments, products: summary.products,
          distinctOfficeLabels: summary.distinctOfficeLabels, distinctBranchLabels: summary.distinctBranchLabels,
          sourceTypes: summary.sourceTypes, numericValues: summary.numericValues, numericFormats: summary.numericFormats,
          numericStringShapes: summary.numericStringShapes,
          fieldBlanks: summary.fieldBlanks, fieldNulls: summary.fieldNulls, validationErrors: summary.validationErrors,
          streamingBufferMaxChars: summary.maxPendingChars, rawRecordsRetainedInMemory: false,
          amountUnitCode: null, officeMapping: 'unresolved; no name-based office mapping', publication: 'none',
          scope: options.fullValidation ? 'full workbook' : `first ${workbook?.rowCount ?? 0} data rows`,
        } : undefined,
      }, null, 2));
      if (!options.apply && summary && Object.keys(summary.validationErrors).length) process.exitCode = 1;
      if (options.apply && outcome?.status === 'validation_failed') process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error?.name === 'ImportTargetMismatchError'
    ? error.message
    : error?.code ? 'Proses Posisi Dana gagal; periksa status batch dan catatan isu tanpa menampilkan detail koneksi.'
      : error?.message || 'Proses Posisi Dana gagal.';
  console.error(JSON.stringify({ error: error?.name || 'PositionImportError', message, code: typeof error?.code === 'string' ? error.code : undefined }, null, 2));
  process.exitCode = 1;
}
