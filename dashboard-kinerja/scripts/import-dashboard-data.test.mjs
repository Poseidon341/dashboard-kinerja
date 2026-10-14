import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDashboardTestTarget, parseArguments } from './import-dashboard-data.mjs';

test('koordinator default dry-run dan apply memerlukan konfirmasi test eksplisit', () => {
  assert.deepEqual(parseArguments([]), { help: false, apply: false, confirmation: undefined });
  assert.deepEqual(parseArguments(['--dry-run']), { help: false, apply: false, confirmation: undefined });
  assert.deepEqual(parseArguments(['--apply', '--confirm-target', 'dashboard_funding_test']), {
    help: false, apply: true, confirmation: 'dashboard_funding_test',
  });
  assert.throws(() => parseArguments(['--apply']), /memerlukan --confirm-target/);
  assert.throws(() => parseArguments(['--apply', '--confirm-target', 'dashboard_funding']), /dashboard_funding_test/);
  assert.throws(() => parseArguments(['--apply', '--dry-run', '--confirm-target', 'dashboard_funding_test']), /Pilih hanya/);
});

test('target hanya database test lokal port 3308', () => {
  assert.doesNotThrow(() => assertDashboardTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.doesNotThrow(() => assertDashboardTestTarget({ host: 'localhost', port: '3308', database: 'dashboard_funding_test' }));
  for (const config of [
    { host: '127.0.0.1', port: 3308, database: 'dashboard_funding' },
    { host: 'remote', port: 3308, database: 'dashboard_funding_test' },
    { host: 'localhost', port: 3306, database: 'dashboard_funding_test' },
  ]) assert.throws(() => assertDashboardTestTarget(config), /hanya diizinkan/);
});
