import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read only the selected worksheet from the approved dashboard workbook. Numeric
// cell tokens are emitted without passing through PowerShell/.NET floating point,
// so downstream raw_record and RKA decimal parsing retain the workbook lexeme.
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:DASHBOARD_XLSX_PATH)
function Read-Entry([string]$name) {
  $entry = $zip.GetEntry($name)
  if (-not $entry) { throw 'Workbook component missing.' }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Column-Number([string]$reference) {
  $letters = [regex]::Match($reference, '^[A-Z]+').Value
  $n = 0
  foreach ($letter in $letters.ToCharArray()) { $n = $n * 26 + ([int]$letter - [int][char]'A' + 1) }
  return $n
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
  $sheetNode = $null
  foreach ($node in $workbook.SelectNodes('//m:sheets/m:sheet',$wNs)) { if ($node.name -ceq $env:DASHBOARD_XLSX_SHEET) { $sheetNode = $node; break } }
  if (-not $sheetNode) { throw 'Requested worksheet missing.' }
  $id = $sheetNode.GetAttribute('id','http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $target = $targets[$id]
  if (-not $target) { throw 'Worksheet relationship invalid.' }
  $entry = if ($target.StartsWith('/')) { $target.TrimStart('/') } elseif ($target.StartsWith('xl/')) { $target } else { "xl/$target" }
  [xml]$sheet = Read-Entry $entry
  $sNs = [Xml.XmlNamespaceManager]::new($sheet.NameTable); $sNs.AddNamespace('m','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $sheetRows = $sheet.SelectNodes('//m:sheetData/m:row',$sNs)
  $headerRow = $null
  foreach ($row in $sheetRows) { if ([int]$row.r -eq 1) { $headerRow = $row; break } }
  if (-not $headerRow) { throw 'Header row 1 missing.' }
  $headerCells = @{}
  foreach ($cell in $headerRow.SelectNodes('./m:c',$sNs)) {
    $value = $cell.SelectSingleNode('./m:v',$sNs)
    if (-not $value) { continue }
    $text = if ($cell.GetAttribute('t') -eq 's') { $strings[[int]$value.InnerText] } else { $value.InnerText }
    if (-not [string]::IsNullOrWhiteSpace($text)) { $headerCells[(Column-Number $cell.r)] = [string]$text }
  }
  $maxColumn = 0; foreach ($column in $headerCells.Keys) { if ([int]$column -gt $maxColumn) { $maxColumn = [int]$column } }
  $headers = [System.Collections.Generic.List[string]]::new()
  for ($column = 1; $column -le $maxColumn; $column++) { $headers.Add([string]$headerCells[$column]) }
  if ($headers.Count -eq 0 -or $headers.Contains('')) { throw 'Worksheet headers contain an empty column name.' }
  $records = [System.Collections.Generic.List[object]]::new()
  $recordNumbers = [System.Collections.Generic.List[int]]::new()
  foreach ($row in $sheetRows) {
    $physicalRow = [int]$row.r
    if ($physicalRow -le 1) { continue }
    $cells = @{}
    foreach ($cell in $row.SelectNodes('./m:c',$sNs)) { $cells[(Column-Number $cell.r)] = $cell }
    $descriptors = [System.Collections.Generic.List[object]]::new()
    $hasValue = $false
    for ($column = 1; $column -le $headers.Count; $column++) {
      $cell = $cells[$column]
      if (-not $cell) { $descriptors.Add(@{ kind='blank'; value=$null; raw=$null }); continue }
      $type = $cell.GetAttribute('t'); $formula = $cell.SelectSingleNode('./*[local-name()="f"]'); $value = $cell.SelectSingleNode('./*[local-name()="v"]')
      if ($type -eq 'e') { throw "Stored worksheet error at row $physicalRow." }
      if ($formula -and (-not $value -or [string]::IsNullOrWhiteSpace($value.InnerText))) { throw "Formula cache missing at row $physicalRow." }
      if ($type -eq 'inlineStr') {
        $text = (($cell.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join '')
        $descriptors.Add(@{ kind='string'; value=[string]$text; raw=$null }); if ($text.Length) { $hasValue = $true }; continue
      }
      if (-not $value) { $descriptors.Add(@{ kind='blank'; value=$null; raw=$null }); continue }
      $raw = [string]$value.InnerText
      if ($type -eq 's') {
        $index = [int]$raw; if ($index -lt 0 -or $index -ge $strings.Count) { throw 'Shared string index invalid.' }
        $text = [string]$strings[$index]; $descriptors.Add(@{ kind='string'; value=$text; raw=$raw }); if ($text.Length) { $hasValue = $true }
      } elseif ($type -eq 'str' -or $type -eq 'd') {
        $descriptors.Add(@{ kind='string'; value=$raw; raw=$raw }); if ($raw.Length) { $hasValue = $true }
      } elseif ($type -eq 'b') {
        $descriptors.Add(@{ kind='boolean'; value=($raw -eq '1'); raw=$raw }); $hasValue = $true
      } else {
        if ($raw -notmatch '^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$') { throw "Invalid numeric cell token at row $physicalRow." }
        $descriptors.Add(@{ kind='number'; value=$null; raw=$raw }); $hasValue = $true
      }
    }
    if ($hasValue) { $records.Add($descriptors.ToArray()); $recordNumbers.Add($physicalRow) }
  }
  ConvertTo-Json -InputObject @{ sheetName=[string]$sheetNode.name; headers=$headers.ToArray(); rows=$records.ToArray(); physicalRows=$recordNumbers.ToArray() } -Depth 30 -Compress
} finally { $zip.Dispose() }
`;

function quote(value) { return JSON.stringify(value); }

function serializeDescriptor(descriptor) {
  if (descriptor.kind === 'blank') return 'null';
  if (descriptor.kind === 'string') return quote(descriptor.value);
  if (descriptor.kind === 'boolean') return descriptor.value ? 'true' : 'false';
  if (descriptor.kind === 'number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(descriptor.raw)) return descriptor.raw;
  throw new Error('Unsupported workbook cell representation.');
}

export async function readDashboardWorkbookSheet(filePath, sheetName, { powershell = 'powershell.exe', expectedHeaders = [] } = {}) {
  const sourcePath = path.resolve(filePath instanceof URL ? fileURLToPath(filePath) : filePath);
  const [bytes, sourceStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DASHBOARD_XLSX_PATH: sourcePath, DASHBOARD_XLSX_SHEET: sheetName },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Tidak dapat membaca sheet XLSX ${sheetName}; pastikan workbook, sheet, dan PowerShell tersedia.`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`Parser XLSX tidak menghasilkan struktur valid untuk sheet ${sheetName}.`); }
  if (parsed.sheetName !== sheetName || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) throw new Error(`Struktur sheet XLSX ${sheetName} tidak valid.`);
  const missingHeaders = expectedHeaders.filter((header) => !parsed.headers.includes(header));
  if (missingHeaders.length) throw new Error(`Header wajib tidak ditemukan di sheet ${sheetName}: ${missingHeaders.join(', ')}.`);
  if (parsed.rows.some((row) => !Array.isArray(row) || row.length !== parsed.headers.length)) throw new Error(`Jumlah kolom tidak konsisten pada sheet ${sheetName}.`);
  const rows = parsed.rows.map((cells) => `{${parsed.headers.map((header, index) => `${quote(header)}:${serializeDescriptor(cells[index])}`).join(',')}}`);
  const jsonBytes = Buffer.from(`[${rows.join(',')}]`, 'utf8');
  return {
    sheetName,
    headers: parsed.headers,
    physicalRowNumbers: parsed.physicalRows,
    recordsJson: jsonBytes,
    rowCount: parsed.rows.length,
    sourceSizeBytes: sourceStat.size,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  };
}
