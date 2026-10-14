import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertPositionFactTarget,
  assertProgressWithinTotal,
  compareFactRows,
  factFromStaging,
  inFactChunkTransaction,
  keysetPages,
  planFactChunk,
} from '../server/imports/position-fact-builder.mjs';

const row = (overrides = {}) => ({
  batch_id: 'batch-a', object_id: '21', source_row_number: '1', parsed_position_date: '2026-10-04',
  office_id: '8', office_version_id: '19', office_version_office_id: '8', segment_id: '2', product_id: '3',
  source_segment: 'MIKRO', source_product: 'TABUNGAN', source_branch_label: 'KC', source_office_label: 'UNIT',
  source_account_count_text: '0', parsed_account_count: '0', source_balance_text: '0', parsed_balance: '0',
  parse_status: 'valid', mapping_status: 'resolved', ...overrides,
});

test('target hanya mengizinkan database test lokal pada port 3308', () => {
  assert.doesNotThrow(() => assertPositionFactTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  for (const config of [
    { host: '127.0.0.1', port: 3308, database: 'dashboard_funding' },
    { host: 'remote', port: 3308, database: 'dashboard_funding_test' },
    { host: 'localhost', port: 3306, database: 'dashboard_funding_test' },
  ]) assert.throws(() => assertPositionFactTarget(config), /hanya diizinkan/);
});

test('mapping unresolved dipertahankan null dan nilai nol tidak menjadi null', () => {
  const unresolved = factFromStaging(row({ office_id: null, office_version_id: null, office_version_office_id: null, segment_id: null, product_id: null, mapping_status: 'unresolved' }));
  assert.equal(unresolved.office_id, null);
  assert.equal(unresolved.mapping_status, 'unresolved');
  assert.equal(unresolved.account_count, '0');
  assert.equal(unresolved.balance, '0');
  assert.equal(unresolved.amount_unit_code, null);
});

test('snapshot office-version mismatch dihentikan', () => {
  assert.throws(() => factFromStaging(row({ office_version_office_id: '999' })), /tidak dimiliki/);
  assert.throws(() => factFromStaging(row({ office_id: null, office_version_id: '19', mapping_status: 'unresolved' })), /Mapping kantor/);
});

test('partial resume hanya merencanakan baris yang belum ada; retry identik tidak menggandakan', () => {
  const first = factFromStaging(row());
  const second = factFromStaging(row({ source_row_number: '2' }));
  const existingFirst = { ...first };
  assert.deepEqual(planFactChunk([first, second], [existingFirst]), { missing: [second], validatedExisting: 1 });
  assert.deepEqual(planFactChunk([first], [existingFirst]), { missing: [], validatedExisting: 1 });
  assert.equal(compareFactRows(existingFirst, first), true);
  assert.throws(() => planFactChunk([first], [{ ...existingFirst, balance: '1' }]), /tidak identik/);
});

test('nilai NULL dan nol tetap berbeda', () => {
  const nullValue = factFromStaging(row({ parsed_balance: null, parsed_account_count: null, source_balance_text: null, source_account_count_text: null }));
  const zeroValue = factFromStaging(row());
  assert.equal(nullValue.balance, null);
  assert.equal(nullValue.account_count, null);
  assert.equal(zeroValue.balance, '0');
  assert.equal(zeroValue.account_count, '0');
});

test('keyset cursor selalu maju dan setiap identitas diproses tepat sekali per iterasi', async () => {
  const sourceIds = ['1', '2', '3', '4', '5'];
  const seen = [];
  const cursors = [];
  const pages = keysetPages(async (cursor, limit) => {
    cursors.push(cursor);
    return sourceIds.filter((id) => BigInt(id) > BigInt(cursor)).slice(0, limit).map((id) => ({ stg_position_id: id }));
  }, { chunkSize: 2 });
  for await (const page of pages) seen.push(...page.map((row) => row.stg_position_id));
  assert.deepEqual(cursors, ['0', '2', '4', '5']);
  assert.deepEqual(seen, sourceIds);
  assert.equal(new Set(seen).size, seen.length);
});

test('halaman yang mengulang cursor dihentikan sebelum progress dihitung', async () => {
  let calls = 0;
  const pages = keysetPages(async () => {
    calls += 1;
    return [{ stg_position_id: calls === 1 ? '2' : '1' }];
  }, { chunkSize: 1 });
  await assert.rejects(async () => { for await (const _page of pages) { /* regression case */ } }, /tidak maju atau identitas staging berulang/);
});

test('query keyset mengambil primary key yang dipakai sebagai cursor', async () => {
  const source = await readFile(new URL('../server/imports/mysql-position-fact-builder-repository.mjs', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('async *stagingChunks'), source.indexOf('async writeFacts'));
  assert.match(section, /SELECT[\s\S]*?p\.stg_position_id/);
  assert.match(section, /yield\* keysetPages/);
});

test('progres dibatasi oleh jumlah staging terverifikasi', () => {
  assert.equal(assertProgressWithinTotal(1039742, 1039742), 1039742);
  assert.throws(() => assertProgressWithinTotal(1039743, 1039742), /melampaui/);
});

test('repository tidak mengubah pointer publikasi dan transaksi chunk gagal di-rollback', async () => {
  const source = await readFile(new URL('../server/imports/mysql-position-fact-builder-repository.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+dashboard_domain_publication|INSERT\s+INTO\s+dashboard_domain_publication/i);
  const events = [];
  const fakeConnection = {
    beginTransaction: async () => events.push('begin'),
    commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'),
  };
  await assert.rejects(inFactChunkTransaction(fakeConnection, async () => { throw new Error('injected failure'); }), /injected failure/);
  assert.deepEqual(events, ['begin', 'rollback']);
});
