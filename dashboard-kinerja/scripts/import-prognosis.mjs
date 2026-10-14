import { createReadStream } from 'node:fs';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROGNOSIS_PARSER_VERSION, preparePrognosisSnapshot } from '../server/imports/prognosis-importer.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = resolve(projectRoot, 'data/import/prognosa.xlsx');

async function checksumFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseArguments(args) {
  if (args.includes('--help')) return { help: true, apply: false };
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const confirmIndex = args.indexOf('--confirm-target');
  const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
  if (confirmIndex >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal. Gunakan --help untuk petunjuk.');
  if (apply && dryRun) throw new Error('Pilih salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('Importer Prognosa tahap ini hanya mengizinkan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

function usage() {
  console.log('Pemakaian: npm.cmd run db:import:prognosis -- --dry-run');
  console.log('Dry-run membaca data/import/prognosa.xlsx melalui converter sementara, tanpa koneksi database.');
  console.log('Apply staging (tidak dijalankan pada tahap ini): npm.cmd run db:import:prognosis -- --apply --confirm-target dashboard_funding_test');
  console.log('Apply hanya menyimpan staging; tidak membuat fakta atau memublikasikan domain.');
}

async function main() {
try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) usage();
  else {
    const started = performance.now();
    const tempDirectory = await mkdtemp(join(tmpdir(), 'dashboard-prognosis-xlsx-'));
    const convertedPath = join(tempDirectory, 'prognosis-snapshot.json');
    let snapshot;
    let sourceInfo;
    try {
      sourceInfo = await stat(sourcePath);
      const checksum = await checksumFile(sourcePath);
      const converterPath = resolve(projectRoot, 'scripts/convert-prognosa.mjs');
      const converted = spawnSync(process.execPath, [converterPath, sourcePath, convertedPath], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
      if (converted.error) throw converted.error;
      if (converted.status !== 0) throw new Error((converted.stderr || converted.stdout || 'Konversi workbook Prognosa gagal.').trim());
      snapshot = preparePrognosisSnapshot(await readFile(convertedPath), {
        sourceChecksum: checksum, sourceSizeBytes: sourceInfo.size,
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
    const perSheet = Object.fromEntries(snapshot.sheets.map((sheet) => [sheet.sheetName, {
      rows: sheet.sourceRowCount, sourceRange: sheet.sourceRange, headerRows: sheet.headerRows,
      formulaCellCount: sheet.formulaCellCount, cachedFormulaCellCount: sheet.cachedFormulaCellCount,
    }]));
    const report = {
      source: 'data/import/prognosa.xlsx', sheetNames: snapshot.sheets.map((sheet) => sheet.sheetName), parserVersion: PROGNOSIS_PARSER_VERSION,
      mode: options.apply ? 'apply' : 'dry-run', sourceBytes: sourceInfo.size, sha256: snapshot.checksum,
      elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      totalRows: snapshot.totalRows, perSheet, valueTypes: snapshot.valueTypes, valueCounts: snapshot.valueCounts,
      metadata: {
        includedSheets: snapshot.metadata?.includedSheets ?? null,
        currencyUnit: snapshot.metadata?.currencyUnit ?? null,
        pipelineWeekDateRanges: snapshot.metadata?.pipelineWeekDateRanges ?? null,
        sourceModifiedAt: snapshot.metadata?.sourceModifiedAt ?? null,
        convertedAt: snapshot.metadata?.convertedAt ?? null,
        formulaPolicy: snapshot.metadata?.formulaPolicy ?? null,
      },
      sourceRowNumber: 'Excel sheet physical row number; retained per sheet',
      rawRowPreserved: true, businessClassification: 'unresolved; no aggregation',
      factCreation: 'none', publication: 'none', validationErrorCount: snapshot.errors.length,
      validationErrors: snapshot.errors.slice(0, 30),
    };
    if (options.apply) {
      const { closeDatabasePool, getDatabaseConfig, getDatabasePool } = await import('../server/db.js');
      const { executePrognosisStage } = await import('../server/imports/prognosis-importer.mjs');
      const { assertPrognosisTestTarget, MysqlPrognosisRepository } = await import('../server/imports/mysql-prognosis-repository.mjs');
      const config = getDatabaseConfig();
      assertPrognosisTestTarget(config);
      if (config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
      const repository = new MysqlPrognosisRepository(getDatabasePool(), config);
      try { report.stageResult = await executePrognosisStage(snapshot, repository); }
      finally { await closeDatabasePool(); }
    }
    console.log(JSON.stringify(report, null, 2));
    if (snapshot.errors.length || report.stageResult?.status === 'validation_failed') process.exitCode = 1;
  }
} catch (error) {
  const safeMessage = error?.name === 'ImportTargetMismatchError' || error?.name === 'PrognosisSourceValidationError'
    ? error.message
    : error?.code ? 'Proses staging Prognosa gagal; periksa status batch dan catatan isu tanpa menampilkan detail koneksi.'
      : error?.message || 'Staging Prognosa gagal.';
  console.error(JSON.stringify({ error: error?.name || 'PrognosisImportError', message: safeMessage, code: typeof error?.code === 'string' ? error.code : undefined }, null, 2));
  process.exitCode = 1;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
