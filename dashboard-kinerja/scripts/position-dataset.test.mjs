import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activatePositionDataset, positionRowsForScope } from '../src/positionDataset.ts';

test('dataset Detail tidak pernah dipakai sebagai Posisi Dana saat menu berganti', () => {
  const detailRows = [{ product: 'TABUNGAN', segment: 'MIKRO' }];
  const fullRows = [detailRows[0], { product: 'DEPOSITO', segment: 'RITEL' }];
  const derivedCache = new Map([['same-filter-and-date', { dpk: 'stale-detail-result' }]]);
  const detail = activatePositionDataset('mysql-detail', detailRows, derivedCache);

  assert.deepEqual(positionRowsForScope(detail, 'mysql-position'), []);
  assert.equal(derivedCache.size, 0);

  derivedCache.set('same-filter-and-date', { dpk: 'stale-detail-result' });
  const position = activatePositionDataset('mysql-position', fullRows, derivedCache);
  assert.equal(positionRowsForScope(position, 'mysql-position'), fullRows);
  assert.deepEqual(positionRowsForScope(position, 'mysql-detail'), []);
  assert.equal(derivedCache.size, 0);
});
