import test from 'node:test';
import assert from 'node:assert/strict';
import { APPRAISAL_EXPECTED_HEADERS, executeAppraisalStage } from '../server/imports/appraisal-importer.mjs';
import { APPRAISAL_XLSX_PARSER_VERSION, createAppraisalXlsxSnapshot } from '../server/imports/appraisal-xlsx-adapter.mjs';
import { assertAppraisalDatabaseIdentity } from '../server/imports/mysql-appraisal-repository.mjs';
import { parseArguments } from './import-appraisal-xlsx.mjs';

function fakeSheet(name, rowNumber = 5, overrides = {}) {
  const record = Object.fromEntries(APPRAISAL_EXPECTED_HEADERS.map((field) => [field, null]));
  Object.assign(record, { sourceRow: rowNumber, 'Nama RM': 'masked-fixture', PN: '00071', 'Kode KC': 10, Tier: 'Tier 1', Score: 0, 'Target Daily Average Tabungan': null, 'Daily Average Tabungan': 0, sourceCellMetadata: { cachedFormulaFields: ['Score'] }, ...overrides });
  return { sheetName: name, rows: [record], physicalDataRows: 385, headerFingerprint: 'a'.repeat(64) };
}

test('XLSX snapshot keeps five approved source periods, field contract, typed zeros/nulls, and cached-formula metadata', () => {
  const sheets = [
    fakeSheet('Master Data April 2026 (KP)'), fakeSheet('Master Data Mei 2026 (KP)'),
    fakeSheet('Master Data Juni 2026 (KP)'), fakeSheet('Master Data Juli 2026 (KP)'),
    fakeSheet('Master Data Mei 2026 (RO)'),
  ];
  const snapshot = createAppraisalXlsxSnapshot(sheets, { checksum: 'b'.repeat(64), sourceSizeBytes: 123, knownOfficeTypes: new Map([['10', 'KC']]) });
  assert.equal(snapshot.totalRows, 5);
  assert.equal(snapshot.objects.length, 5);
  assert.equal(snapshot.officeMapping.matched, 5);
  assert.equal(snapshot.sheets[0].rows[0].rawValues.Score, 0);
  assert.equal(snapshot.sheets[0].rows[0].rawValues['Target Daily Average Tabungan'], null);
  assert.deepEqual(snapshot.sheets[0].rows[0].rawValues.sourceCellMetadata.cachedFormulaFields, ['Score']);
  assert.equal(snapshot.sheets[0].rows[0].sourcePeriod, '2026-04-01');
  assert.equal(snapshot.objects[0].objectType, 'xlsx_sheet_snapshot');
});

test('duplicate period/type and missing field contract fail closed', () => {
  const duplicate = [fakeSheet('Master Data April 2026 (KP)'), fakeSheet('Master Data April 2026 (KP)'), fakeSheet('Master Data Juni 2026 (KP)'), fakeSheet('Master Data Juli 2026 (KP)'), fakeSheet('Master Data Mei 2026 (RO)')];
  assert.throws(() => createAppraisalXlsxSnapshot(duplicate, { checksum: 'c'.repeat(64) }), /duplikat/);
  const incomplete = fakeSheet('Master Data April 2026 (KP)'); delete incomplete.rows[0].Tier;
  const sources = [incomplete, fakeSheet('Master Data Mei 2026 (KP)'), fakeSheet('Master Data Juni 2026 (KP)'), fakeSheet('Master Data Juli 2026 (KP)'), fakeSheet('Master Data Mei 2026 (RO)')];
  assert.throws(() => createAppraisalXlsxSnapshot(sources, { checksum: 'c'.repeat(64) }), /gagal divalidasi/);
});

test('unresolved office stays unresolved and source raw identity is preserved', () => {
  const sheets = [fakeSheet('Master Data April 2026 (KP)', 17, { 'Kode KC': 'unknown' }), fakeSheet('Master Data Mei 2026 (KP)'), fakeSheet('Master Data Juni 2026 (KP)'), fakeSheet('Master Data Juli 2026 (KP)'), fakeSheet('Master Data Mei 2026 (RO)')];
  const snapshot = createAppraisalXlsxSnapshot(sheets, { checksum: 'd'.repeat(64), knownOfficeTypes: new Map([['10', 'KC']]) });
  const row = snapshot.sheets[0].rows[0];
  assert.equal(row.officeMapping, 'unresolved');
  assert.equal(row.sourceRowNumber, 17);
  assert.equal(JSON.parse(row.rawRecord).PN, '00071');
});

test('target flags only permit explicit test database apply and XLSX stage uses separate source identity', async () => {
  assert.deepEqual(parseArguments([]), { help: false, apply: false, confirmation: undefined });
  assert.throws(() => parseArguments(['--apply', '--confirm-target', 'dashboard_funding']), /hanya mengizinkan/);
  assert.deepEqual(parseArguments(['--apply', '--confirm-target', 'dashboard_funding_test']), { help: false, apply: true, confirmation: 'dashboard_funding_test' });
  const sheets = [fakeSheet('Master Data April 2026 (KP)'), fakeSheet('Master Data Mei 2026 (KP)'), fakeSheet('Master Data Juni 2026 (KP)'), fakeSheet('Master Data Juli 2026 (KP)'), fakeSheet('Master Data Mei 2026 (RO)')];
  const snapshot = createAppraisalXlsxSnapshot(sheets, { checksum: 'e'.repeat(64) });
  const repo = { args: null, async withSourceLock(_key, fn) { return fn(this); }, async reserveBatch(args) { this.args = args; return { batchId: 'x', alreadyStaged: true }; } };
  await executeAppraisalStage(snapshot, repo, { parserVersion: APPRAISAL_XLSX_PARSER_VERSION, sourceKey: 'appraisal_xlsx', sourceSystem: 'appraisal_xlsx', registryType: 'xlsx_file', displayName: 'Appraisal XLSX', sourceLocation: 'data/import/appraisal.xlsx' });
  assert.equal(repo.args.sourceKey, 'appraisal_xlsx');
  assert.equal(repo.args.registryType, 'xlsx_file');
  assert.doesNotThrow(() => assertAppraisalDatabaseIdentity({ database_name: 'dashboard_funding_test', mysql_port: 3308 }));
  assert.throws(() => assertAppraisalDatabaseIdentity({ database_name: 'dashboard_funding_test', mysql_port: 3306 }), /bukan database uji/);
  assert.throws(() => assertAppraisalDatabaseIdentity({ database_name: 'dashboard_funding', mysql_port: 3308 }), /bukan database uji/);
});
