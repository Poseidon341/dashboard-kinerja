import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDateDimensionTarget, dateDimensionRow, planDateDimensionRows } from '../server/imports/date-dimension.mjs';

test('tanggal yang ada dipertahankan dan hanya tanggal yang hilang direncanakan', () => {
  const existing = dateDimensionRow('2026-10-04');
  const plan = planDateDimensionRows(['2026-10-04', '2026-10-05'], [existing]);
  assert.deepEqual(plan.present, ['2026-10-04']);
  assert.deepEqual(plan.missing.map((row) => row.calendar_date), ['2026-10-05']);
  assert.deepEqual(plan.conflicts, []);
});

test('retry setelah tanggal ditambahkan menghasilkan nol tanggal baru', () => {
  const required = ['2026-10-04', '2026-10-05'];
  const firstPlan = planDateDimensionRows(required, []);
  const retryPlan = planDateDimensionRows(required, firstPlan.missing);
  assert.equal(retryPlan.missing.length, 0);
  assert.deepEqual(retryPlan.present, required);
});

test('target hanya mengizinkan database uji lokal port 3308', () => {
  assert.doesNotThrow(() => assertDateDimensionTarget({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertDateDimensionTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }), /hanya diizinkan/);
  assert.throws(() => assertDateDimensionTarget({ host: 'remote', port: 3308, database: 'dashboard_funding_test' }), /hanya diizinkan/);
  assert.throws(() => assertDateDimensionTarget({ host: '127.0.0.1', port: 3306, database: 'dashboard_funding_test' }), /hanya diizinkan/);
});

test('tanggal sumber invalid ditolak dan tanggal dihitung tanpa pergeseran zona waktu', () => {
  assert.throws(() => dateDimensionRow('2026-02-30'), /tidak valid/);
  assert.throws(() => dateDimensionRow('04/10/2026'), /YYYY-MM-DD/);
  assert.deepEqual(dateDimensionRow('2026-10-04'), {
    calendar_date: '2026-10-04', calendar_year: 2026, calendar_month: 10, calendar_day: 4,
    month_start: '2026-10-01', month_end: '2026-10-31',
  });
});

test('metadata tanggal existing yang berbeda dilaporkan konflik, bukan ditimpa', () => {
  const row = dateDimensionRow('2026-10-04');
  const plan = planDateDimensionRows(['2026-10-04'], [{ ...row, month_end: '2026-10-30' }]);
  assert.deepEqual(plan.conflicts, ['2026-10-04']);
  assert.equal(plan.missing.length, 0);
});
