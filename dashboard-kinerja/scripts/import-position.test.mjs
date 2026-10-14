import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { importPositionFile, scanPositionFile } from '../server/imports/position-importer.mjs';
import { assertPositionTestTarget } from '../server/imports/mysql-position-repository.mjs';
import { materializePositionWorkbook } from '../server/imports/position-xlsx-adapter.mjs';

const fixtureRecord = (overrides = {}) => ({
  Posisi: '31/12/2025', 'Segmentasi BPR': 'MIKRO', Produk: 'TABUNGAN', 'Nama Cabang': 'KC Contoh',
  'Nama Uker': 'UNIT Contoh', 'Jumlah Rekening': 0, Saldo: '0', ...overrides,
});
async function tempSource(t, text) {
  const directory = await mkdtemp(join(tmpdir(), 'position-import-test-'));
  const path = join(directory, 'source.json');
  await writeFile(path, text, 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path;
}

async function tempPositionWorkbook(t) {
  const directory = await mkdtemp(join(tmpdir(), 'position-xlsx-fixture-'));
  const workbookPath = join(directory, 'fixture.xlsx');
  const script = String.raw`
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($env:FIXTURE_XLSX_PATH,[IO.Compression.ZipArchiveMode]::Create)
function Add-Text([string]$name,[string]$text) { $entry=$zip.CreateEntry($name); $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false)); try {$writer.Write($text)} finally {$writer.Dispose()} }
try {
Add-Text 'xl/workbook.xml' '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="segmen_data" sheetId="1" r:id="rId1"/></sheets></workbook>'
Add-Text 'xl/_rels/workbook.xml.rels' '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
Add-Text 'xl/sharedStrings.xml' '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="17" uniqueCount="17"><si><t>Posisi</t></si><si><t>Segmentasi BPR</t></si><si><t>Produk</t></si><si><t>Nama Cabang</t></si><si><t>Nama Uker</t></si><si><t>Jumlah Rekening</t></si><si><t>Saldo</t></si><si><t>MIKRO</t></si><si><t>TABUNGAN</t></si><si><t>KC Contoh</t></si><si><t>UNIT Contoh</t></si><si><t>31/12/2025</t></si><si><t>RITEL</t></si><si><t>GIRO</t></si><si><t>1,234</t></si><si><t></t></si><si><t>02/01/2026</t></si></sst>'
Add-Text 'xl/styles.xml' '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
Add-Text 'xl/worksheets/sheet1.xml' '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c></row><row r="2"><c r="A2" s="1"><v>46022</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>8</v></c><c r="D2" t="s"><v>9</v></c><c r="E2" t="s"><v>10</v></c><c r="F2"><v>3</v></c><c r="G2"><v>1234567890123.123456789012345</v></c></row><row r="3"><c r="A3" t="s"><v>11</v></c><c r="B3" t="s"><v>12</v></c><c r="C3" t="s"><v>13</v></c><c r="D3" t="s"><v>9</v></c><c r="E3" t="s"><v>10</v></c><c r="F3"><v>0</v></c><c r="G3" t="s"><v>14</v></c></row><row r="4"><c r="A4" s="1"><v>46024</v></c><c r="B4" t="s"><v>7</v></c><c r="C4" t="s"><v>8</v></c><c r="D4" t="s"><v>9</v></c><c r="E4" t="s"><v>10</v></c><c r="F4"/><c r="G4"/></row></sheetData></worksheet>'
} finally {$zip.Dispose()}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FIXTURE_XLSX_PATH: workbookPath },
  });
  assert.equal(result.status, 0, `PowerShell fixture workbook generation must succeed: ${result.stderr}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return workbookPath;
}

test('stream adapter reads a small XLSX fixture and keeps raw cell types, precision, date serials, blanks, and row identity', async (t) => {
  const workbookPath = await tempPositionWorkbook(t);
  const workbook = await materializePositionWorkbook(workbookPath);
  t.after(() => workbook.cleanup());
  assert.equal(workbook.rowCount, 3);
  assert.deepEqual(workbook.headers, ['Posisi', 'Segmentasi BPR', 'Produk', 'Nama Cabang', 'Nama Uker', 'Jumlah Rekening', 'Saldo']);
  const parsed = [];
  const summary = await scanPositionFile(workbook.path, { expectedRows: 3, strictSnapshot: false, highWaterMark: 9, onRecord: async (row) => parsed.push(row) });
  assert.equal(summary.total, 3);
  assert.equal(summary.invalidRows, 0);
  assert.deepEqual(parsed.map((row) => row.rowNumber), [2, 3, 4]);
  assert.equal(parsed[0].parsedPositionDate, '2025-12-31');
  assert.equal(parsed[0].rawRecord, '{"Posisi":46022,"Segmentasi BPR":"MIKRO","Produk":"TABUNGAN","Nama Cabang":"KC Contoh","Nama Uker":"UNIT Contoh","Jumlah Rekening":3,"Saldo":1234567890123.123456789012345}');
  assert.equal(parsed[0].parsedBalance, '1234567890123.123456789012345');
  assert.equal(parsed[1].sourceBalanceText, '1,234');
  assert.equal(parsed[1].parsedBalance, '1234');
  assert.equal(parsed[2].parsedAccountCount, null);
  assert.equal(parsed[2].parsedBalance, null);
  assert.equal(summary.numericValues.accountCount.zero, 1);
  assert.equal(summary.numericValues.accountCount.null, 1);
  assert.equal(summary.numericValues.balance.null, 1);
  assert.equal(summary.sourceTypes['Saldo:number'], 1);
  assert.equal(summary.sourceTypes['Saldo:string'], 1);
  assert.equal(summary.sourceTypes['Saldo:null'], 1);
  assert.equal(parsed.every((row) => row.mappingStatus === 'unresolved'), true);
  assert.ok(!parsed[0].rawRecord.includes('__source_row_number'));
});

test('XLSX adapter limit membatasi record tanpa mengubah sumber workbook', async (t) => {
  const workbookPath = await tempPositionWorkbook(t);
  const workbook = await materializePositionWorkbook(workbookPath, { limit: 2 });
  t.after(() => workbook.cleanup());
  const summary = await scanPositionFile(workbook.path, { expectedRows: 2, strictSnapshot: false });
  assert.equal(workbook.limited, true);
  assert.equal(summary.total, 2);
});

test('stream JSON menjaga raw record, urutan sumber, dan nilai numerik asli lintas batas chunk UTF-8', async (t) => {
  const raw1 = '{"Posisi":"31/12/2025","Segmentasi BPR":"MIKRO","Produk":"TABUNGAN","Nama Cabang":"KC Contoh","Nama Uker":"UNIT Cianjur 🌾","Jumlah Rekening":0,"Saldo":1234567890123.123456789012345}';
  const raw2 = JSON.stringify(fixtureRecord({ 'Jumlah Rekening': '', Saldo: null }));
  const raw3 = JSON.stringify(fixtureRecord({ 'Jumlah Rekening': null, Saldo: '0' }));
  const source = `[${raw1},\n${raw2},${raw3}]`;
  const path = await tempSource(t, source);
  const parsed = [];
  const summary = await scanPositionFile(path, { expectedRows: 2, strictSnapshot: false, highWaterMark: 7, onRecord: async (row) => parsed.push(row) });
  assert.equal(summary.total, 3);
  assert.equal(summary.invalidRows, 0);
  assert.equal(parsed[0].rowNumber, 1);
  assert.equal(parsed[0].rawRecord, raw1);
  assert.equal(parsed[0].sourceBalanceText, '1234567890123.123456789012345');
  assert.equal(parsed[0].parsedBalance, '1234567890123.123456789012345');
  assert.equal(parsed[0].mappingStatus, 'unresolved');
  assert.equal(parsed[1].sourceAccountCountText, '');
  assert.equal(parsed[1].parsedAccountCount, null);
  assert.equal(parsed[1].sourceBalanceText, null);
  assert.equal(parsed[2].parsedBalance, '0');
  assert.equal(summary.numericValues.accountCount.zero, 1);
  assert.equal(summary.numericValues.accountCount.blank, 1);
  assert.equal(summary.numericValues.balance.zero, 1);
  assert.equal(summary.numericValues.balance.null, 1);
});

test('string angka hanya dinormalisasi pada format yang tegas; pemisah ambigu dan overflow ditandai invalid', async (t) => {
  const rows = [
    fixtureRecord({ Saldo: '1,234,567', 'Jumlah Rekening': '123' }),
    fixtureRecord({ Saldo: '1234567', 'Jumlah Rekening': '1,234' }),
    fixtureRecord({ Saldo: '1.234', 'Jumlah Rekening': '9223372036854775808' }),
    fixtureRecord({ Saldo: '999,999,999,999,999,999,999,999,999' }),
  ];
  const path = await tempSource(t, JSON.stringify(rows));
  const parsed = [];
  const summary = await scanPositionFile(path, { expectedRows: rows.length, strictSnapshot: false, onRecord: async (row) => parsed.push(row) });
  assert.equal(parsed[0].parsedBalance, '1234567');
  assert.equal(parsed[1].parsedBalance, '1234567');
  assert.equal(parsed[1].parsedAccountCount, '1234');
  assert.ok(parsed[2].errors.some((error) => error.code === 'invalid_numeric_format'));
  assert.ok(parsed[2].errors.some((error) => error.code === 'account_count_out_of_range'));
  assert.ok(parsed[3].errors.some((error) => error.code === 'decimal_out_of_range'));
  assert.equal(summary.invalidRows, 2);
});

test('validasi dimensi tanggal, segmen, produk, panjang kolom, dan raw value', async (t) => {
  const record = fixtureRecord({
    Posisi: '31/02/2026', 'Segmentasi BPR': 'SEGMENT BARU', Produk: 'KARTU',
    'Nama Uker': 'U'.repeat(256), Saldo: '1.234',
  });
  const source = JSON.stringify([record]);
  const path = await tempSource(t, source);
  const parsed = [];
  const summary = await scanPositionFile(path, { expectedRows: 1, strictSnapshot: false, onRecord: async (row) => parsed.push(row) });
  assert.equal(parsed[0].rawRecord, source.slice(1, -1));
  assert.equal(parsed[0].sourceOfficeLabel, null);
  assert.equal(parsed[0].parsedPositionDate, null);
  assert.ok(parsed[0].errors.some((error) => error.code === 'invalid_date'));
  assert.ok(parsed[0].errors.some((error) => error.code === 'unknown_segment'));
  assert.ok(parsed[0].errors.some((error) => error.code === 'unknown_product'));
  assert.ok(parsed[0].errors.some((error) => error.code === 'column_length_exceeded'));
  assert.equal(summary.invalidRows, 1);
});

class FakePositionRepository {
  batches = new Map();
  staged = new Map();
  failAfterChunks = null;
  async withSourceLock(_key, callback) { return callback(this); }
  async reserveBatch(input) {
    const key = `${input.checksum}:${input.parserVersion}`;
    let batch = this.batches.get(key);
    if (batch?.status === 'completed') return { batchId: batch.id, objectId: batch.objectId, alreadyStaged: true };
    if (!batch) {
      batch = { id: `batch-${this.batches.size + 1}`, objectId: `obj-${this.batches.size + 1}`, status: 'loading', rows: new Map(), chunks: 0, summary: input.validationSummary };
      this.batches.set(key, batch);
    }
    batch.status = 'loading';
    return { batchId: batch.id, objectId: batch.objectId, alreadyStaged: false };
  }
  async stageChunk(batch, rows) {
    const current = [...this.batches.values()].find((item) => item.id === batch.batchId);
    current.chunks += 1;
    if (this.failAfterChunks !== null && current.chunks > this.failAfterChunks) throw new Error('simulated chunk failure');
    for (const row of rows) current.rows.set(row.rowNumber, row);
  }
  async finalizeBatch(batch, summary) {
    const current = [...this.batches.values()].find((item) => item.id === batch.batchId);
    if (current.rows.size !== summary.total || Object.keys(summary.validationErrors).length) { current.status = 'failed'; return 'validation_failed'; }
    current.status = 'completed';
    current.publications = 0;
    return 'staged';
  }
  async markFailed(batchId) {
    const current = [...this.batches.values()].find((item) => item.id === batchId);
    if (current && current.status !== 'completed') current.status = 'failed';
  }
}

test('retry snapshot identik memakai batch dan source row identity yang sama; checksum baru membuat histori terpisah', async (t) => {
  const path = await tempSource(t, JSON.stringify([fixtureRecord(), fixtureRecord({ Posisi: '01/01/2026' })]));
  const repository = new FakePositionRepository();
  const first = await importPositionFile(path, repository, { batchSize: 1, expectedRows: 2, strictSnapshot: false });
  const retry = await importPositionFile(path, repository, { batchSize: 1, expectedRows: 2, strictSnapshot: false });
  assert.equal(first.status, 'staged');
  assert.equal(retry.status, 'already_staged');
  assert.equal(repository.batches.size, 1);
  assert.equal([...repository.batches.values()][0].rows.size, 2);
  assert.equal([...repository.batches.values()][0].publications, 0);
  await writeFile(path, JSON.stringify([fixtureRecord({ Saldo: '1' })]));
  await importPositionFile(path, repository, { batchSize: 1, expectedRows: 1, strictSnapshot: false });
  assert.equal(repository.batches.size, 2);
});

test('kegagalan di tengah chunk meninggalkan batch gagal dan dapat diputar ulang tanpa row ganda', async (t) => {
  const path = await tempSource(t, JSON.stringify([fixtureRecord(), fixtureRecord({ Posisi: '01/01/2026' }), fixtureRecord({ Posisi: '02/01/2026' })]));
  const repository = new FakePositionRepository();
  repository.failAfterChunks = 1;
  await assert.rejects(importPositionFile(path, repository, { batchSize: 1, expectedRows: 3, strictSnapshot: false }), /simulated chunk failure/);
  const partial = [...repository.batches.values()][0];
  assert.equal(partial.status, 'failed');
  assert.equal(partial.rows.size, 1);
  repository.failAfterChunks = null;
  const retry = await importPositionFile(path, repository, { batchSize: 1, expectedRows: 3, strictSnapshot: false });
  assert.equal(retry.status, 'staged');
  assert.equal(partial.status, 'completed');
  assert.equal(partial.rows.size, 3);
  assert.equal(partial.publications, 0);
});

test('database target importer dibatasi ke dashboard_funding_test', () => {
  assert.doesNotThrow(() => assertPositionTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding_test' }));
  assert.throws(() => assertPositionTestTarget({ host: '127.0.0.1', port: 3308, database: 'dashboard_funding' }), /hanya diizinkan ke dashboard_funding_test/);
});
