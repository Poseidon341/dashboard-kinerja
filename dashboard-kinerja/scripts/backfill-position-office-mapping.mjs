import { closeDatabasePool, getDatabaseConfig, getDatabasePool } from '../server/db.js';
import { assertPositionMappingTarget } from '../server/imports/position-office-mapping.mjs';
import { MysqlPositionOfficeMappingRepository } from '../server/imports/mysql-position-office-mapping-repository.mjs';

function parseArgs(args) {
  if (args.includes('--help')) return { help: true, apply: false, confirmation: undefined };
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const index = args.indexOf('--confirm-target');
  const confirmation = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && confirmation === undefined) throw new Error('--confirm-target memerlukan nama database.');
  const allowed = new Set(['--apply', '--dry-run', '--confirm-target', confirmation]);
  if (args.some((arg) => !allowed.has(arg)) || args.filter((arg) => arg === '--confirm-target').length > 1) throw new Error('Argumen tidak dikenal.');
  if (apply && dryRun) throw new Error('Pilih hanya salah satu: --dry-run atau --apply.');
  if (apply && confirmation !== 'dashboard_funding_test') throw new Error('--apply memerlukan --confirm-target dashboard_funding_test.');
  if (!apply && confirmation !== undefined) throw new Error('--confirm-target hanya berlaku bersama --apply.');
  return { help: false, apply, confirmation };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Pemakaian: npm.cmd run db:backfill:position-office [-- --dry-run]');
    console.log('Mode default/dry-run melakukan SELECT saja pada dashboard_funding_test lokal port 3308.');
    console.log('Backfill (tidak dijalankan): npm.cmd run db:backfill:position-office -- --apply --confirm-target dashboard_funding_test');
  } else {
    const config = getDatabaseConfig();
    assertPositionMappingTarget(config);
    if (options.apply && config.database !== options.confirmation) throw new Error('Konfirmasi target harus sama persis dengan MYSQL_DATABASE aktif.');
      const repository = new MysqlPositionOfficeMappingRepository(getDatabasePool(), config, {
        onProgress: (progress) => {
          const count = progress.processedRows ?? progress.insertedRows ?? 0;
          const interval = progress.phase === 'backfill-missing' ? 25000 : 100000;
          if (count % interval === 0) console.log(JSON.stringify({ progress }));
        },
      });
    try {
      const result = await repository.run({ apply: options.apply });
      const { snapshot, audit, currentMapping, applyResult } = result;
      console.log(JSON.stringify({
        mode: options.apply ? 'apply' : 'dry-run',
        target: { host: config.host, port: config.port, database: config.database },
        masterSnapshot: {
          batchId: snapshot.officeMaster.batchId,
          publicationVersion: snapshot.officeMaster.publicationVersion,
          sourceObjectId: snapshot.officeMaster.sourceObjectId,
          checksum: snapshot.officeMaster.checksum,
        },
        positionSnapshot: {
          batchId: snapshot.position.batchId,
          sourceObjectId: snapshot.position.sourceObjectId,
          checksum: snapshot.position.checksum,
          rows: snapshot.position.rowCount,
        },
        audit,
        currentMapping,
        applyResult,
        stagingRowsModified: false,
        factPublication: 'none',
      }, null, 2));
    } finally {
      await closeDatabasePool();
    }
  }
} catch (error) {
  const message = error?.name === 'ImportTargetMismatchError'
    ? error.message
    : error?.code ? 'Backfill gagal; detail koneksi dan kredensial tidak ditampilkan.' : error?.message || 'Backfill gagal.';
  console.error(JSON.stringify({ error: error?.name || 'PositionOfficeMappingError', message }, null, 2));
  process.exitCode = 1;
}
