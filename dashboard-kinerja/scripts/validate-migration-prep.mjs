import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const jobs = [
  { key: 'uker', script: 'import-uker.mjs', args: ['--dry-run'] },
  { key: 'rmft', script: 'import-rmft.mjs', args: ['--dry-run'] },
  { key: 'rka', script: 'import-rka.mjs', args: ['--dry-run'] },
  { key: 'position', script: 'import-position.mjs', args: ['--dry-run', '--limit', '1000'] },
  { key: 'prognosis', script: 'import-prognosis.mjs', args: ['--dry-run'] },
  { key: 'appraisal', script: 'import-appraisal.mjs', args: ['--dry-run'] },
];

function run(job) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts', job.script), ...job.args], {
      cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(stdout.trim()); } catch { /* output is summarized without echoing untrusted records */ }
      resolvePromise({ code: code ?? 1, report, safeError: code === 0 ? null : (report?.error?.message ?? 'Validasi workbook gagal; lihat laporan importer tanpa mencetak payload sumber.') });
      if (code !== 0 && !report && stderr) reject(new Error('Validasi workbook gagal tanpa laporan terstruktur.'));
    });
  });
}

const summaries = [];
for (const job of jobs) {
  const { code, report, safeError } = await run(job);
  const validationErrorCount = report?.summary?.invalidRows
    ?? report?.validationErrorCount
    ?? report?.counts?.invalidRows
    ?? (Array.isArray(report?.sheets) && report.sheets.every((sheet) => sheet.schema === '62/62 expected headers valid') ? 0 : null);
  summaries.push({
    source: job.key,
    workbook: report?.source ?? null,
    sheet: report?.sheet ?? report?.sheetNames ?? report?.sheets?.map((item) => item.name) ?? null,
    rows: report?.result?.rows ?? report?.stagingRows ?? report?.counts?.total ?? report?.totalRows ?? report?.totalSelectedRecords ?? null,
    validRows: report?.summary?.validRows ?? report?.counts?.validRows ?? null,
    validationErrorCount,
    mode: report?.mode ?? report?.result?.status ?? null,
    exitCode: code,
    safeError,
  });
}

console.log(JSON.stringify({
  reportType: 'offline-workbook-import-validation',
  execution: { databaseConnection: false, sqlExecuted: false, sourceFilesModified: false },
  sources: summaries,
  allPassed: summaries.every((summary) => summary.exitCode === 0 && summary.validationErrorCount === 0),
  positionScope: 'first 1000 rows only; full workbook validation is a separate bounded operation',
}, null, 2));
if (summaries.some((summary) => summary.exitCode !== 0 || summary.validationErrorCount !== 0)) process.exitCode = 1;
