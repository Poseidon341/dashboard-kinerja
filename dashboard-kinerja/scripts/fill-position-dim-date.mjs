import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { assertDateDimensionTarget } from '../server/imports/date-dimension.mjs';
import { MysqlDateDimensionRepository } from '../server/imports/mysql-date-dimension-repository.mjs';

function parseArgs(args) {
  if (args.includes('--help')) return { help: true, apply: false, confirmation: undefined };
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const index = args.indexOf('--confirm-target');
  const confirmation = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal.');
  if (apply && dryRun) throw new Error('Pilih hanya --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('--apply memerlukan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Pemakaian: npm.cmd run db:fill:position-dim-date [-- --dry-run]');
    console.log('Apply (belum dijalankan): npm.cmd run db:fill:position-dim-date -- --apply --confirm-target dashboard_funding_test');
    process.exit(0);
  }
  const config = getDatabaseConfig();
  assertDateDimensionTarget(config);
  if (options.apply && config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama dengan MYSQL_DATABASE aktif.');
  const repository = new MysqlDateDimensionRepository(getDatabasePool(), config);
  try {
    const result = await repository.run({ apply: options.apply });
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', target: { host: config.host, port: config.port, database: config.database }, ...result }, null, 2));
  } finally {
    await closeDatabasePool();
  }
} catch (error) {
  const message = error?.name === 'ImportTargetMismatchError' || !error?.code
    ? error.message
    : 'Pengisian dimensi tanggal gagal; detail koneksi dan kredensial tidak ditampilkan.';
  console.error(JSON.stringify({ error: error?.name || 'DateDimensionError', message }, null, 2));
  process.exitCode = 1;
}
