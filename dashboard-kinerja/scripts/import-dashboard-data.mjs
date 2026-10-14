import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [
  { key: 'offices', source: 'data/import/dashboard_funding.xlsx#uker_list', target: ['dashboard_stg_office_row', 'dashboard_dim_office', 'dashboard_dim_office_version', 'dashboard_office_relationship'], script: 'import-uker.mjs' },
  { key: 'rmft', source: 'data/import/dashboard_funding.xlsx#rmft_list', target: ['dashboard_stg_rmft_row', 'dashboard_dim_rmft', 'dashboard_rmft_assignment'], script: 'import-rmft.mjs' },
  { key: 'rka', source: 'data/import/dashboard_funding.xlsx#tabel_rka', target: ['dashboard_stg_rka_row', 'dashboard_dim_rka_category'], script: 'import-rka.mjs' },
  { key: 'position', source: 'data/import/dashboard_funding.xlsx#segmen_data', target: ['dashboard_stg_position_row'], script: 'import-position.mjs' },
  { key: 'prognosis', source: 'data/import/prognosa.xlsx', target: ['dashboard_stg_prognosis_row'], script: 'import-prognosis.mjs' },
  { key: 'appraisal', source: 'data/import/appraisal.xlsx', target: ['dashboard_stg_appraisal_row'], script: 'import-appraisal.mjs' },
];

export function parseArguments(args) {
  if (args.includes('--help')) return { help: true, apply: false };
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const index = args.indexOf('--confirm-target');
  const confirmation = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((value) => !allowed.has(value)) || args.filter((value) => value === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal.');
  if (apply && dryRun) throw new Error('Pilih hanya --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('--apply memerlukan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

export function assertDashboardTestTarget(config) {
  if (!['127.0.0.1', 'localhost'].includes(String(config?.host).toLowerCase())
    || Number(config?.port) !== 3308 || config?.database !== 'dashboard_funding_test') {
    throw new Error('Impor terkoordinasi hanya diizinkan pada MySQL lokal dashboard_funding_test port 3308.');
  }
}

async function verifyActualTarget(config) {
  assertDashboardTestTarget(config);
  const pool = getDatabasePool();
  const [rows] = await pool.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (rows[0]?.database_name !== 'dashboard_funding_test' || Number(rows[0]?.server_port) !== 3308) {
    throw new Error('Koneksi aktual bukan dashboard_funding_test pada port MySQL 3308.');
  }
  return { database: rows[0].database_name, port: Number(rows[0].server_port) };
}

async function sourceInventory() {
  const csvFiles = (await readdir(path.join(projectRoot, 'public'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => `public/${entry.name}`);
  const files = ['dashboard_funding.xlsx', 'prognosa.xlsx', 'appraisal.xlsx'];
  const workbooks = {};
  for (const file of files) {
    const source = path.join(projectRoot, 'data', 'import', file);
    try { const info = await stat(source); workbooks[file] = { available: true, sizeBytes: info.size }; }
    catch { workbooks[file] = { available: false }; }
  }
  return {
    csvFiles,
    workbooks,
    approvedSheets: {
      dashboard_funding: ['uker_list', 'rmft_list', 'tabel_rka', 'segmen_data'],
      prognosis: ['KOMITMEN SBO', 'KOMITMEN BO', 'Per AH', 'PER RMFT'],
      appraisal: 'five Master Data period/type sheets',
    },
    sourceColumns: 'Diperiksa dan divalidasi oleh importer workbook khusus; tidak dibaca dari JSON arsip.',
  };
}

function runJob(job, apply) {
  return new Promise((resolve, reject) => {
    const args = [path.join(projectRoot, 'scripts', job.script), apply ? '--apply' : '--dry-run'];
    if (apply) args.push('--confirm-target', 'dashboard_funding_test');
    const child = spawn(process.execPath, args, { cwd: projectRoot, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(stdout.trim()); } catch { /* do not echo unknown child output */ }
      resolve({ code: code ?? 1, report, outputParsed: report !== null, safeError: code === 0 ? null : (report?.error?.message ?? report?.message ?? 'Importer gagal; lihat log aman importer terkait.') });
    });
  });
}

function summarizeJob(job, outcome) {
  const report = outcome.report;
  let validation;
  let counts;
  if (job.key === 'position') {
    validation = { errors: report?.summary?.invalidRows ?? null, validRows: report?.summary?.validRows ?? null };
    counts = {
      rows: report?.result?.rows ?? null,
      dates: report?.summary?.dateCount ?? null,
      dateRange: [report?.summary?.dateMin ?? null, report?.summary?.dateMax ?? null],
      segments: report?.summary?.segments ?? null,
      products: report?.summary?.products ?? null,
      elapsedSeconds: report?.elapsedSeconds ?? null,
      maxRssBytes: report?.memory?.maxRssBytes ?? null,
    };
  } else if (job.key === 'prognosis') {
    validation = { errors: report?.validationErrorCount ?? null };
    counts = { rows: report?.totalRows ?? null, sheets: report?.perSheet ?? null, formulaPolicy: report?.metadata?.formulaPolicy ?? null };
  } else if (job.key === 'appraisal') {
    validation = { errors: report?.validationErrorCount ?? null };
    counts = { rows: report?.totalSelectedRecords ?? null, sources: report?.sheets ?? null, schema: report?.sheets?.every((sheet) => sheet.schema === '62/62 expected headers valid') ?? null };
  } else if (job.key === 'rka') {
    validation = { errors: report?.validationErrorCount ?? null, invalidRows: report?.counts?.invalidRows ?? null };
    counts = { rows: report?.counts?.total ?? report?.stagingRows ?? null, categories: report?.counts?.categories ?? null, officeCodesMatched: report?.counts?.officeCodesMatched ?? null };
  } else {
    validation = { errors: report?.validationErrorCount ?? null };
    counts = { rows: report?.stagingRows ?? report?.counts?.total ?? null, distribution: report?.counts ?? null };
  }
  return {
    key: job.key,
    source: job.source,
    targetTables: job.target,
    mode: report?.mode ?? (report?.result?.status === 'dry-run' ? 'dry-run' : null),
    counts,
    validation,
    outputParsed: outcome.outputParsed,
    exitCode: outcome.code,
    safeError: outcome.safeError,
  };
}

export async function runDashboardImport({ apply = false, config = getDatabaseConfig(), execute = runJob } = {}) {
  assertDashboardTestTarget(config);
  const actualTarget = await verifyActualTarget(config);
  const inventory = await sourceInventory();
  const pool = getDatabasePool();
  let databaseStatus;
  await verifyActualTarget(config);
  const [tableRows] = await pool.execute('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  const tables = new Set(tableRows.map((row) => row.table_name));
  const stageNames = [...new Set(jobs.flatMap((job) => job.target).filter((table) => table.startsWith('dashboard_stg_')))];
  const existingStageRows = {};
  for (const table of stageNames) {
    if (tables.has(table)) {
      const [rows] = await pool.execute(`SELECT COUNT(*) AS row_count FROM \`${table}\``);
      existingStageRows[table] = Number(rows[0]?.row_count ?? 0);
    } else existingStageRows[table] = null;
  }
  let completedBatches = [];
  if (tables.has('dashboard_import_batch') && tables.has('dashboard_source_registry')) {
    const [rows] = await pool.execute(`SELECT s.source_key AS source_key,b.status AS status,SUM(b.rows_staged) AS rows_staged
      FROM dashboard_import_batch b JOIN dashboard_source_registry s ON s.source_id=b.source_id
      GROUP BY s.source_key,b.status ORDER BY s.source_key,b.status`);
    completedBatches = rows.map((row) => ({ source: row.source_key, status: row.status, rowsStaged: Number(row.rows_staged) }));
  }
  databaseStatus = { tableCount: tables.size, existingStageRows, batches: completedBatches };
  const results = [];
  let failed = false;
  for (const job of jobs) {
    if (apply) {
      const checked = await verifyActualTarget(config);
      if (checked.database !== actualTarget.database || checked.port !== actualTarget.port) throw new Error('Target database berubah selama proses impor.');
    }
    const outcome = await execute(job, apply);
    results.push(summarizeJob(job, outcome));
    if (outcome.code !== 0) {
      failed = true;
      if (apply) break;
    }
  }
  const blockers = inventory.csvFiles.map((source) => `CSV belum memiliki mapping domain/kolom yang disetujui: ${source}`);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    target: actualTarget,
    databaseStatus,
    sources: results,
    columnMappings: jobs.map((job) => ({
      source: job.source,
      columns: job.columnsFrom ? inventory.sourceColumns[job.columnsFrom] ?? null : job.columns,
    })),
    prognosisSheets: inventory.prognosisSheets,
    workbook: inventory.workbook,
    csvFiles: inventory.csvFiles,
    blockers,
    writes: apply ? 'staging/importer behavior per domain; no facts or dashboard cutover' : 'none',
  };
  return { summary, exitCode: failed || blockers.length ? 1 : 0 };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Pemakaian: npm.cmd run db:import:dashboard -- [--dry-run]');
      console.log('Default adalah dry-run. Apply hanya dengan --apply --confirm-target dashboard_funding_test.');
      console.log('Menggunakan importer per-domain yang sudah ada; staging/fakta dan publikasi mengikuti perilaku masing-masing importer.');
      return;
    }
    const { summary, exitCode } = await runDashboardImport({ apply: options.apply });
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(JSON.stringify({ error: error?.name || 'DashboardImportError', message: error?.message || 'Impor dashboard gagal.' }));
    process.exitCode = 1;
  } finally {
    await closeDatabasePool().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
