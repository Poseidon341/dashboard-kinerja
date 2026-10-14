import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { parseArguments } from './import-appraisal-xlsx.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const xlsxImporter = resolve(projectRoot, 'scripts/import-appraisal-xlsx.mjs');

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const child = spawn(process.execPath, [xlsxImporter, ...process.argv.slice(2)], {
    cwd: projectRoot, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', (error) => { console.error(`Importer XLSX Appraisal tidak dapat dijalankan: ${error.message}`); process.exitCode = 1; });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
}
