import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuditMatches,
  assertExistingMappingsMatch,
  assertPositionMappingTarget,
  inTransaction,
  mappingRowsForInsert,
  POSITION_MAPPING_EXPECTED,
  resolveExactOfficeLabel,
} from '../server/imports/position-office-mapping.mjs';

test('audit exact-match accepts the audited distribution only', () => {
  assert.equal(assertAuditMatches(POSITION_MAPPING_EXPECTED), true);
  assert.throws(() => assertAuditMatches({ ...POSITION_MAPPING_EXPECTED, ambiguousLabels: 1 }), /audit mapping kantor berubah/);
});

test('two unresolved labels remain null and are represented only by aggregate expectations', () => {
  const rows = mappingRowsForInsert([
    { stg_position_id: 1, master_source_object_id: 20, office_id: 30, office_version_id: 40, mapping_status: 'resolved' },
    { stg_position_id: 2, master_source_object_id: 20, office_id: null, office_version_id: null, mapping_status: 'unresolved' },
  ]);
  assert.equal(rows[0].mapping_status, 'resolved');
  assert.equal(rows[1].office_id, null);
  assert.equal(rows[1].office_version_id, null);
  assert.equal(POSITION_MAPPING_EXPECTED.unresolvedLabels, 2);
  assert.equal(POSITION_MAPPING_EXPECTED.unresolvedRows, 1691);
});

test('target guard rejects main database, remote host, and wrong port', () => {
  assert.doesNotThrow(() => assertPositionMappingTarget({ host: 'localhost', port: 3308, database: 'dashboard_funding_test' }));
  for (const target of [
    { host: '127.0.0.1', port: 3308, database: 'dashboard_funding' },
    { host: 'example.invalid', port: 3308, database: 'dashboard_funding_test' },
    { host: '127.0.0.1', port: 3306, database: 'dashboard_funding_test' },
  ]) assert.throws(() => assertPositionMappingTarget(target), /hanya diizinkan/);
});

test('office and version IDs must both resolve and remain in matching status', () => {
  assert.throws(() => mappingRowsForInsert([{ stg_position_id: 1, master_source_object_id: 2, office_id: 3, office_version_id: null, mapping_status: 'resolved' }]), /sama-sama/);
  assert.throws(() => mappingRowsForInsert([{ stg_position_id: 1, master_source_object_id: 2, office_id: null, office_version_id: null, mapping_status: 'resolved' }]), /unresolved/);
});

test('retry reuses a matching mapping; conflicting values stop instead of overwrite', () => {
  const expected = mappingRowsForInsert([{ stg_position_id: 1, master_source_object_id: 20, office_id: 30, office_version_id: 40, mapping_status: 'resolved' }]);
  assert.deepEqual(assertExistingMappingsMatch(expected, []), expected);
  assert.deepEqual(assertExistingMappingsMatch(expected, [{ ...expected[0] }]), []);
  assert.throws(() => assertExistingMappingsMatch(expected, [{ ...expected[0], office_id: '31' }]), /sudah ada berbeda/);
  const otherSnapshot = mappingRowsForInsert([{ ...expected[0], master_source_object_id: 21 }]);
  assert.deepEqual(assertExistingMappingsMatch(otherSnapshot, []), otherSnapshot);
});

test('partial resume inserts only missing staging identities and keeps snapshot identity', () => {
  const expected = mappingRowsForInsert([
    { stg_position_id: 10, master_source_object_id: 20, office_id: 30, office_version_id: 40, mapping_status: 'resolved' },
    { stg_position_id: 11, master_source_object_id: 20, office_id: null, office_version_id: null, mapping_status: 'unresolved' },
  ]);
  const pending = assertExistingMappingsMatch(expected, [{ ...expected[0] }]);
  assert.deepEqual(pending, [expected[1]]);
  const changedSnapshot = mappingRowsForInsert([{ ...expected[1], master_source_object_id: 21 }]);
  // Repository lookup is scoped to the new master_source_object_id, so old snapshot rows are not considered duplicates.
  assert.deepEqual(assertExistingMappingsMatch(changedSnapshot, []), changedSnapshot);
});

test('labels with no exact master key stay unresolved; no fuzzy alias is attempted', () => {
  const lookup = new Map([['BRANCH CANTIK', [{ officeId: '1', versionId: '2', code: '001' }]]]);
  assert.deepEqual(resolveExactOfficeLabel('BRANCH CANTIK', lookup), { officeId: '1', versionId: '2', code: '001' });
  assert.equal(resolveExactOfficeLabel('BRANCH CANTIK KOTA', lookup), null);
  assert.equal(resolveExactOfficeLabel('KANWIL MALANG', lookup), null);
  assert.equal(resolveExactOfficeLabel('UNIT A. YANI MAGETAN', lookup), null);
  assert.throws(() => resolveExactOfficeLabel('DUPLIKAT', new Map([['DUPLIKAT', [{ officeId: '1' }, { officeId: '2' }]]])), /lebih dari satu/);
});

test('keyset resume SQL uses source row index and anti-join for this master snapshot', async () => {
  const { readFile } = await import('node:fs/promises');
  const repository = await readFile(new URL('../server/imports/mysql-position-office-mapping-repository.mjs', import.meta.url), 'utf8');
  assert.match(repository, /p\.source_row_number>\?/);
  assert.match(repository, /m\.stg_position_id IS NULL/);
  assert.match(repository, /m\.master_source_object_id=\?/);
  assert.doesNotMatch(repository, /COUNT\(\*\).*cursor/i);
});

test('chunk write helper rolls back when insert operation fails', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
  };
  await assert.rejects(inTransaction(connection, async () => { calls.push('insert'); throw new Error('forced'); }), /forced/);
  assert.deepEqual(calls, ['begin', 'insert', 'rollback']);
});

test('migration/backfill code does not update raw staging or create fact publication', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./backfill-position-office-mapping.mjs', import.meta.url), 'utf8');
  const repository = await readFile(new URL('../server/imports/mysql-position-office-mapping-repository.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source + repository, /\b(?:UPDATE|DELETE|TRUNCATE|CREATE|ALTER)\s+(?:dashboard_stg_position_row|dashboard_fact_position_daily)/i);
  assert.doesNotMatch(repository, /dashboard_fact_position_daily|dashboard_domain_publication\s*\(/i);
});
