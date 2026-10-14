import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { APPRAISAL_EXPECTED_HEADERS } from './appraisal-importer.mjs';

export const APPRAISAL_XLSX_SOURCE_KEY = 'appraisal_xlsx';
export const APPRAISAL_XLSX_SOURCE_SYSTEM = 'appraisal_xlsx';
export const APPRAISAL_XLSX_PARSER_VERSION = 'appraisal-xlsx-stage-v1';

const MONTHS = Object.freeze({ Januari: '01', Februari: '02', Maret: '03', April: '04', Mei: '05', Juni: '06', Juli: '07', Agustus: '08', September: '09', Oktober: '10', November: '11', Desember: '12' });

// PowerShell reads only the five Master Data sheets. Formula expressions are never evaluated;
// the stored cached <v> value is used and the cell/formula metadata is retained in raw_record.
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:APPRAISAL_XLSX_PATH)
function Read-Entry([string]$name) {
  $entry = $zip.GetEntry($name)
  if (-not $entry) { throw 'Komponen workbook tidak ditemukan.' }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Column-Number([string]$reference) {
  $letters = [regex]::Match($reference, '^[A-Z]+').Value
  $n = 0
  foreach ($letter in $letters.ToCharArray()) { $n = $n * 26 + ([int]$letter - [int][char]'A' + 1) }
  return $n
}
function Cell-Value($cell, $strings, [string]$sheet) {
  $type = $cell.GetAttribute('t')
  $formula = $cell.SelectSingleNode('./*[local-name()="f"]')
  $value = $cell.SelectSingleNode('./*[local-name()="v"]')
  if ($type -eq 'e') { throw "Workbook berisi error sel tersimpan ($sheet/$($cell.r))." }
  if ($formula -and (-not $value -or [string]::IsNullOrWhiteSpace($value.InnerText))) { throw "Cached formula tidak tersedia ($sheet/$($cell.r))." }
  if ($type -eq 's' -and $value) {
    $i = [int]$value.InnerText
    if ($i -lt 0 -or $i -ge $strings.Count) { throw 'Indeks shared string workbook tidak valid.' }
    return @{ value = [string]$strings[$i]; type = 'string'; formula = [bool]$formula; raw = [string]$value.InnerText }
  }
  if ($type -eq 'inlineStr') { return @{ value = (($cell.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join ''); type = 'string'; formula = [bool]$formula; raw = $null } }
  if (-not $value) { return @{ value = $null; type = 'blank'; formula = [bool]$formula; raw = $null } }
  if ($type -eq 'b') { return @{ value = ($value.InnerText -eq '1'); type = 'boolean'; formula = [bool]$formula; raw = [string]$value.InnerText } }
  if ($type -eq 'str' -or $type -eq 'd') { return @{ value = [string]$value.InnerText; type = $type; formula = [bool]$formula; raw = [string]$value.InnerText } }
  $number = 0.0
  if (-not [double]::TryParse($value.InnerText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) { throw "Nilai numerik workbook tidak valid ($sheet/$($cell.r))." }
  return @{ value = $number; type = 'number'; formula = [bool]$formula; raw = [string]$value.InnerText }
}
try {
  [xml]$workbook = Read-Entry 'xl/workbook.xml'
  [xml]$relationships = Read-Entry 'xl/_rels/workbook.xml.rels'
  $wNs = [Xml.XmlNamespaceManager]::new($workbook.NameTable); $wNs.AddNamespace('m','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $rNs = [Xml.XmlNamespaceManager]::new($relationships.NameTable); $rNs.AddNamespace('r','http://schemas.openxmlformats.org/package/2006/relationships')
  $strings = [System.Collections.Generic.List[string]]::new()
  if ($zip.GetEntry('xl/sharedStrings.xml')) {
    [xml]$shared = Read-Entry 'xl/sharedStrings.xml'; $sNs = [Xml.XmlNamespaceManager]::new($shared.NameTable); $sNs.AddNamespace('m','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    foreach ($item in $shared.SelectNodes('//m:si',$sNs)) { $strings.Add((($item.SelectNodes('.//m:t',$sNs) | ForEach-Object { $_.InnerText }) -join '')) }
  }
  $targets = @{}; foreach ($rel in $relationships.SelectNodes('//r:Relationship',$rNs)) { $targets[$rel.Id] = $rel.Target }
  $expectedHeaders = @($env:APPRAISAL_EXPECTED_HEADERS -split [char]31)
  $wanted = @{}
  foreach ($node in $workbook.SelectNodes('//m:sheets/m:sheet',$wNs)) {
    if ($node.name -match '^Master Data (Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember) (\d{4}) \((RO|KP)\)$') {
      $id = $node.GetAttribute('id','http://schemas.openxmlformats.org/officeDocument/2006/relationships'); $target = $targets[$id]
      if (-not $target) { throw 'Relasi sheet workbook tidak valid.' }
      $entry = if ($target.StartsWith('/')) { $target.TrimStart('/') } elseif ($target.StartsWith('xl/')) { $target } else { "xl/$target" }
      $wanted[$node.name] = $entry
    }
  }
  $result = [System.Collections.Generic.List[object]]::new()
  foreach ($sheetName in ($wanted.Keys | Sort-Object)) {
    [xml]$sheet = Read-Entry $wanted[$sheetName]
    $sNs = [Xml.XmlNamespaceManager]::new($sheet.NameTable); $sNs.AddNamespace('m','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $rows = $sheet.SelectNodes('//m:sheetData/m:row',$sNs)
    $headerNode = $sheet.SelectSingleNode('//m:sheetData/m:row[@r="4"]',$sNs)
    if (-not $headerNode) { throw "Header baris 4 tidak ditemukan ($sheetName)." }
    $headers = @{}
    foreach ($cell in $headerNode.SelectNodes('./m:c',$sNs)) {
      $parsed = Cell-Value $cell $strings $sheetName
      if ($parsed.value -is [string] -and -not [string]::IsNullOrWhiteSpace($parsed.value)) { $headers[$parsed.value] = $cell.r }
    }
    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($expectedHeader in $expectedHeaders) { if (-not $headers.ContainsKey([string]$expectedHeader)) { $missing.Add([string]$expectedHeader) } }
    if ($missing.Count) { $missingText = [string]::Join(' | ', $missing.ToArray()); throw ("Kontrak header tidak lengkap ($sheetName), count=$($missing.Count): " + $missingText) }
    $records = [System.Collections.Generic.List[object]]::new()
    $headerParts = foreach ($expectedHeader in $expectedHeaders) { ([string]$expectedHeader) + '=' + [string]$headers[[string]$expectedHeader] }
    $sha = [Security.Cryptography.SHA256]::Create(); $headerFingerprint = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]::Join([char]10, $headerParts))); $sha.Dispose()
    foreach ($row in $rows) {
      $rowNumber = [int]$row.r
      if ($rowNumber -lt 5) { continue }
      $byColumn = @{}
      foreach ($cell in $row.SelectNodes('./m:c',$sNs)) { $byColumn[(Column-Number $cell.r)] = @{ cell=$cell; parsed=(Cell-Value $cell $strings $sheetName) } }
      $record = [ordered]@{ sourceRow = $rowNumber }; $types = [ordered]@{}; $rawCells = [ordered]@{}; $formulaFields = [System.Collections.Generic.List[string]]::new()
      foreach ($header in $expectedHeaders) {
        $cellRef = $headers[[string]$header]; $column = Column-Number $cellRef; $found = $byColumn[$column]
        $parsed = if ($found) { $found.parsed } else { @{value=$null;type='blank';formula=$false;raw=$null} }
        $value = $parsed.value
        if ($value -is [string] -and [string]::IsNullOrEmpty($value)) { $value = $null }
        if ($header -eq 'PN' -and $null -ne $value) { $value = [string]$value }
        $record[[string]$header] = $value
        $types[[string]$header] = $parsed.type
        if ($found) { $rawCells[[string]$header] = @{ cell=$cellRef; raw=$parsed.raw; type=$parsed.type; formulaCached=[bool]$parsed.formula } }
        if ($parsed.formula) { $formulaFields.Add([string]$header) }
      }
      if ($null -eq $record['PN'] -and $null -eq $record['Nama RM']) { continue }
      $targetAvailability = [ordered]@{}
      foreach ($header in $expectedHeaders) { if ([string]$header -like 'Target *') { $metric = ([string]$header).Substring(7); $targetAvailability[$metric] = if ($null -eq $record[[string]$header]) {'not_available'} else {'available'} } }
      $record['targetAvailability'] = $targetAvailability
      $record['sourceCellMetadata'] = @{ types=$types; cells=$rawCells; cachedFormulaFields=$formulaFields.ToArray() }
      $records.Add($record)
    }
    $fingerprintText = [BitConverter]::ToString($headerFingerprint).Replace('-','').ToLowerInvariant()
    $result.Add(@{sheetName=$sheetName;rows=$records.ToArray();physicalDataRows=($rows | Where-Object { [int]$_.r -ge 5 }).Count;headerRow=4;headerFingerprint=$fingerprintText})
  }
  if ($result.Count -ne 5) { throw "Ditemukan $($result.Count) sheet Master Data, diharapkan lima." }
  ConvertTo-Json -InputObject $result.ToArray() -Depth 100 -Compress
} finally { $zip.Dispose() }
`;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function parsePeriodType(sheetName) {
  const match = /^Master Data (Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember) (\d{4}) \((RO|KP)\)$/.exec(sheetName);
  if (!match || !MONTHS[match[1]]) throw new Error('Nama sheet Appraisal XLSX tidak sesuai format periode/tipe yang didukung.');
  return { period: `${match[2]}-${MONTHS[match[1]]}`, type: match[3] };
}

export function createAppraisalXlsxSnapshot(parsedSheets, { checksum, sourceSizeBytes, knownOfficeTypes = new Map() } = {}) {
  if (!Array.isArray(parsedSheets) || parsedSheets.length !== 5 || !/^[a-f0-9]{64}$/.test(checksum || '')) throw new Error('Snapshot Appraisal XLSX tidak lengkap.');
  const errors = []; const valueTypes = { null: 0, string: 0, number: 0, boolean: 0, other: 0 }; const sheets = []; const objects = [];
  const names = new Set(); let totalRows = 0; let matched = 0; let unresolved = 0;
  for (const item of parsedSheets) {
    const { period, type } = parsePeriodType(item.sheetName);
    const pair = `${period}|${type}`; if (names.has(pair)) throw new Error('Workbook Appraisal memiliki pasangan periode/tipe duplikat.'); names.add(pair);
    const seenRows = new Set(); const rows = [];
    for (const record of item.rows) {
      if (!record || !Number.isSafeInteger(Number(record.sourceRow)) || Number(record.sourceRow) < 5 || seenRows.has(Number(record.sourceRow))) throw new Error(`Nomor baris sumber tidak valid atau ganda pada ${item.sheetName}.`);
      const missing = APPRAISAL_EXPECTED_HEADERS.filter((field) => !Object.hasOwn(record, field));
      if (missing.length) { errors.push({ period, type, sourceRowNumber: Number(record.sourceRow), codes: ['record_contract_mismatch'], missingHeaders: missing }); continue; }
      seenRows.add(Number(record.sourceRow));
      for (const value of APPRAISAL_EXPECTED_HEADERS.map((field) => record[field])) {
        const key = value === null ? 'null' : typeof value; valueTypes[valueTypes[key] === undefined ? 'other' : key] += 1;
      }
      const rawValues = { ...record };
      const officeCode = record['Kode KC'] === null || record['Kode KC'] === undefined ? null : String(record['Kode KC']).trim();
      const officeMapping = officeCode && knownOfficeTypes.get(officeCode) === 'KC' ? 'matched' : 'unresolved';
      if (officeMapping === 'matched') matched += 1; else unresolved += 1;
      rows.push({
        sourceType: type, sourceSheet: item.sheetName, sourcePeriod: `${period}-01`, sourceRowNumber: Number(record.sourceRow),
        headerFingerprint: item.headerFingerprint, schemaStatus: 'valid', rawRecord: JSON.stringify(rawValues),
        pnText: record.PN === null || record.PN === undefined ? null : String(record.PN), officeMapping, rawValues,
      });
    }
    if (errors.some((error) => error.period === period && error.type === type)) continue;
    const sourceChecksum = hash(JSON.stringify(item.rows));
    const sourceRange = `header-row-4; data-rows-5-through-${item.physicalDataRows + 4}`;
    const sheet = { ...item, ...parsePeriodType(item.sheetName), sourcePeriod: `${period}-01`, sourceRange, sourceRowCount: rows.length, recordCount: rows.length, rows };
    sheets.push(sheet); totalRows += rows.length;
    objects.push({
      objectKey: `appraisal/${period}/${type}`, objectName: item.sheetName, objectType: 'xlsx_sheet_snapshot', sourceChecksum,
      sourceRowCount: rows.length, sourcePeriod: period, sourceType: type, sourceSheet: item.sheetName, sourceRange, rows,
      metadata: { sourceFormat: 'xlsx', sheetName: item.sheetName, period, type, headerRow: 4, physicalDataRows: item.physicalDataRows, selectedRows: rows.length, headerFingerprint: item.headerFingerprint, cachedFormulaPolicy: 'use stored cached value; never recalculate' },
    });
  }
  if (errors.length || sheets.length !== 5) throw Object.assign(new Error('Struktur Appraisal XLSX gagal divalidasi.'), { name: 'AppraisalSourceValidationError', validationErrors: errors });
  return {
    checksum, sourceSizeBytes, totalRows, sheets, objects,
    metadata: { sourceCount: sheets.length, sources: sheets.map(({ period, type, sourceRowCount }) => ({ period, type, rowCount: sourceRowCount })), headerFingerprint: null, headerValidation: 'Lima sheet Master Data; seluruh 62 header sesuai kontrak backend pada baris 4.' },
    valueTypes, officeMapping: { matched, unresolved }, errors,
  };
}

export async function readAppraisalXlsxSnapshot(filePath, { knownOfficeTypes = new Map(), powershell = 'powershell.exe' } = {}) {
  const sourcePath = path.resolve(filePath); const bytes = await readFile(sourcePath); const info = await stat(sourcePath);
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, APPRAISAL_XLSX_PATH: sourcePath, APPRAISAL_EXPECTED_HEADERS_JSON: JSON.stringify(APPRAISAL_EXPECTED_HEADERS), APPRAISAL_EXPECTED_HEADERS: APPRAISAL_EXPECTED_HEADERS.join('\u001f') },
  });
  if (result.error || result.status !== 0) {
    const stderr = String(result.error?.message ?? result.stderr ?? '');
    const lines = stderr.split(/\r?\n/);
    const diagnostic = ([...lines].reverse().find((line) => /Method invocation failed|Cannot find an overload|You cannot call a method|Exception calling/i.test(line))
      ?? lines.find((line) => line.includes('FullyQualifiedErrorId')) ?? lines.filter(Boolean).at(-1) ?? '')
      .replace(/[^\p{L}\p{N} .,:;_()\-/|]/gu, '').trim().slice(0, 500);
    throw new Error(`Pembacaan struktur workbook Appraisal gagal; tidak ada data yang diimpor.${diagnostic ? ` Parser: ${diagnostic}` : ''}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new Error('Parser workbook Appraisal tidak menghasilkan ringkasan JSON yang valid.'); }
  const parsedSheets = Array.isArray(parsed) ? parsed : [parsed];
  return createAppraisalXlsxSnapshot(parsedSheets, { checksum: hash(bytes), sourceSizeBytes: info.size, knownOfficeTypes });
}
