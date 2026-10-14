import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const REQUIRED_HEADERS = Object.freeze([
  'Posisi', 'Segmentasi BPR', 'Produk', 'Nama Cabang', 'Nama Uker', 'Jumlah Rekening', 'Saldo',
]);

// Worksheet XML is consumed row by row with XmlReader. A compact temporary JSON
// array lets the existing position validator retain exact JSON numeric tokens;
// neither the workbook rows nor the generated file are loaded into memory whole.
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:POSITION_XLSX_PATH)
function Read-SmallEntry([string]$name) {
  $entry = $zip.GetEntry($name); if (-not $entry) { throw 'Workbook component missing.' }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Column-Number([string]$reference) {
  $letters = [regex]::Match($reference, '^[A-Z]+').Value; $n = 0
  foreach ($letter in $letters.ToCharArray()) { $n = $n * 26 + ([int]$letter - [int][char]'A' + 1) }
  return $n
}
function Json-String([string]$value) { return (ConvertTo-Json -InputObject $value -Compress) }
function Read-Cell($rowReader, $strings, $dateStyles) {
  $cellReader = $rowReader.ReadSubtree(); $null = $cellReader.Read()
  $column = Column-Number $cellReader.GetAttribute('r'); $type = $cellReader.GetAttribute('t')
  $styleText = $cellReader.GetAttribute('s'); $style = if ($styleText) { [int]$styleText } else { 0 }
  $raw = $null; $inline = [System.Text.StringBuilder]::new(); $formula = $false
  try {
    while ($cellReader.Read()) {
      if ($cellReader.NodeType -ne [Xml.XmlNodeType]::Element) { continue }
      if ($cellReader.LocalName -eq 'f') { $formula = $true }
      elseif ($cellReader.LocalName -eq 'v') { $raw = $cellReader.ReadElementContentAsString() }
      elseif ($cellReader.LocalName -eq 't' -and $type -eq 'inlineStr') { [void]$inline.Append($cellReader.ReadElementContentAsString()) }
    }
  } finally { $cellReader.Dispose() }
  if ($type -eq 'e') { throw 'Workbook contains a stored cell error.' }
  if ($formula -and [string]::IsNullOrWhiteSpace($raw)) { throw 'Workbook formula cache is missing.' }
  $token = 'null'
  if ($type -eq 'inlineStr') { $token = Json-String $inline.ToString() }
  elseif (-not [string]::IsNullOrEmpty($raw)) {
    if ($type -eq 's') { $i=[int]$raw; if ($i -lt 0 -or $i -ge $strings.Count) { throw 'Shared string index invalid.' }; $token=Json-String ([string]$strings[$i]) }
    elseif ($type -eq 'str' -or $type -eq 'd') { $token=Json-String $raw }
    elseif ($type -eq 'b') { if ($raw -eq '1') {$token='true'} elseif ($raw -eq '0') {$token='false'} else {throw 'Boolean cell token invalid.'} }
    else { if ($raw -notmatch '^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$') { throw 'Numeric cell token invalid.' }; $token=$raw }
  }
  return @{ column=$column; type=$type; style=$style; token=$token; isDate=(($type -notin @('s','inlineStr','str','d')) -and $dateStyles.ContainsKey($style) -and $dateStyles[$style]) }
}
try {
  [xml]$workbook = Read-SmallEntry 'xl/workbook.xml'; [xml]$relationships = Read-SmallEntry 'xl/_rels/workbook.xml.rels'
  $wNs = [Xml.XmlNamespaceManager]::new($workbook.NameTable); $wNs.AddNamespace('m','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $rNs = [Xml.XmlNamespaceManager]::new($relationships.NameTable); $rNs.AddNamespace('r','http://schemas.openxmlformats.org/package/2006/relationships')
  $targets = @{}; foreach ($rel in $relationships.SelectNodes('//r:Relationship',$rNs)) { $targets[$rel.Id] = $rel.Target }
  $wanted = $null
  foreach ($node in $workbook.SelectNodes('//m:sheets/m:sheet',$wNs)) { if ($node.name -ceq 'segmen_data') { $wanted = $node; break } }
  if (-not $wanted) { throw 'Worksheet segmen_data not found.' }
  $rid = $wanted.GetAttribute('id','http://schemas.openxmlformats.org/officeDocument/2006/relationships'); $target = $targets[$rid]
  if (-not $target) { throw 'Worksheet relationship invalid.' }
  $entryName = if ($target.StartsWith('/')) { $target.TrimStart('/') } elseif ($target.StartsWith('xl/')) { $target } else { "xl/$target" }
  $strings = [System.Collections.Generic.List[string]]::new()
  if ($zip.GetEntry('xl/sharedStrings.xml')) {
    $sharedStream=$zip.GetEntry('xl/sharedStrings.xml').Open(); $ssReader=[Xml.XmlReader]::Create($sharedStream,[Xml.XmlReaderSettings]::new())
    $pool=[System.Collections.Generic.List[string]]::new(); $indices=[System.Collections.Generic.List[int]]::new(); $lookup=[System.Collections.Generic.Dictionary[string,int]]::new([StringComparer]::Ordinal)
    try {
      $null=$ssReader.Read()
      while (-not $ssReader.EOF) {
        if ($ssReader.NodeType -ne [Xml.XmlNodeType]::Element -or $ssReader.LocalName -ne 'si') { $null=$ssReader.Read(); continue }
        $itemReader=$ssReader.ReadSubtree(); $null=$itemReader.Read(); $text=[System.Text.StringBuilder]::new()
        try { while($itemReader.Read()) { if($itemReader.NodeType -eq [Xml.XmlNodeType]::Element -and $itemReader.LocalName -eq 't') { [void]$text.Append($itemReader.ReadElementContentAsString()) } } }
        finally { $itemReader.Dispose() }
        $value=$text.ToString(); $poolIndex=0
        if (-not $lookup.TryGetValue($value,[ref]$poolIndex)) { $poolIndex=$pool.Count; $lookup.Add($value,$poolIndex); $pool.Add($value) }
        $indices.Add($poolIndex); $null=$ssReader.Read()
      }
      foreach ($index in $indices) { $strings.Add($pool[$index]) }
    } finally { $ssReader.Dispose(); $sharedStream.Dispose() }
  }
  $dateStyles = @{}
  if ($zip.GetEntry('xl/styles.xml')) {
    [xml]$styles = Read-SmallEntry 'xl/styles.xml'
    $styleRows = $styles.SelectNodes("//*[local-name()='cellXfs']/*[local-name()='xf']")
    $customFormats = @{}
    foreach ($format in $styles.SelectNodes("//*[local-name()='numFmt']")) { $customFormats[[int]$format.GetAttribute('numFmtId')] = [string]$format.GetAttribute('formatCode') }
    for ($i = 0; $i -lt $styleRows.Count; $i++) {
      $formatId = [int]$styleRows[$i].GetAttribute('numFmtId'); $formatCode = [string]$customFormats[$formatId]
      $dateStyles[$i] = (($formatId -ge 14 -and $formatId -le 22) -or ($formatCode -match '(?i)(^|[^\\])[dmy]'))
    }
  }
  $workbookProperties = $workbook.SelectSingleNode("//*[local-name()='workbookPr']")
  $date1904 = $workbookProperties -and $workbookProperties.GetAttribute('date1904') -in @('1','true')
  $sheetEntry = $zip.GetEntry($entryName); if (-not $sheetEntry) { throw 'Worksheet data missing.' }
  $stream = $sheetEntry.Open(); $settings = [Xml.XmlReaderSettings]::new(); $settings.IgnoreWhitespace = $true
  $reader = [Xml.XmlReader]::Create($stream,$settings)
  $headers = @{}; $maxColumn = 0; $rowCount = 0; $limit = [int]$env:POSITION_XLSX_LIMIT
  $outputBatch = [System.Collections.Generic.List[string]]::new()
  try {
    $null = $reader.Read()
    while (-not $reader.EOF) {
      if ($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'row') { $null = $reader.Read(); continue }
      $physicalRow = [int]$reader.GetAttribute('r'); $rowReader=$reader.ReadSubtree(); $null=$rowReader.Read(); $cells=@{}
      try { while($rowReader.Read()) { if($rowReader.NodeType -eq [Xml.XmlNodeType]::Element -and $rowReader.LocalName -eq 'c') { $cell=Read-Cell $rowReader $strings $dateStyles; $cells[$cell.column]=$cell } } }
      finally { $rowReader.Dispose() }
      if ($physicalRow -eq 1) {
        foreach ($key in $cells.Keys) {
          $token = $cells[$key].token
          if ($token -eq 'null') { continue }
          $header = [string](ConvertFrom-Json -InputObject $token)
          if (-not [string]::IsNullOrWhiteSpace($header)) { $headers[[int]$key] = $header; if ([int]$key -gt $maxColumn) { $maxColumn = [int]$key } }
        }
        $missing = @($env:POSITION_XLSX_EXPECTED_HEADERS -split [char]31 | Where-Object { $_ -notin $headers.Values })
        if ($missing.Count) { throw ('Required worksheet headers missing: ' + [string]::Join(', ',$missing)) }
        $null=$reader.Read()
        continue
      }
      if ($physicalRow -lt 2) { $null=$reader.Read(); continue }
      $parts = [System.Collections.Generic.List[string]]::new(); $hasValue = $false
      for ($column = 1; $column -le $maxColumn; $column++) {
        $header = $headers[$column]
        if (-not $header) { throw 'Worksheet header has an unnamed interior column.' }
        $token = if ($cells.ContainsKey($column)) { $cells[$column].token } else { 'null' }
        if ($token -ne 'null' -and $token -ne '""') { $hasValue = $true }
        $parts.Add((Json-String $header) + ':' + $token)
      }
      foreach ($column in $cells.Keys) {
        if ([int]$column -gt $maxColumn) {
          $extraToken = $cells[$column].token
          if ($extraToken -ne 'null' -and $extraToken -ne '""') { throw 'Data found outside named worksheet headers.' }
        }
      }
      if (-not $hasValue) { continue }
      $parts.Add('"__source_row_number":' + $physicalRow)
      $positionColumn = 0; foreach ($column in $headers.Keys) { if ($headers[$column] -ceq 'Posisi') { $positionColumn = [int]$column; break } }
      if ($positionColumn -gt 0 -and $cells[$positionColumn] -and $cells[$positionColumn].isDate) {
        $parts.Add('"__excel_date_serial":true')
        $parts.Add('"__excel_date_1904":' + $(if ($date1904) {'true'} else {'false'}))
      }
      $outputBatch.Add('{' + [string]::Join(',',$parts.ToArray()) + '}')
      $rowCount++
      if ($outputBatch.Count -ge 1000) { [Console]::Out.WriteLine([string]::Join([char]10,$outputBatch.ToArray())); $outputBatch.Clear() }
      if ($limit -gt 0 -and $rowCount -ge $limit) { break }
      $null=$reader.Read(); continue
    }
    if ($outputBatch.Count) { [Console]::Out.WriteLine([string]::Join([char]10,$outputBatch.ToArray())); $outputBatch.Clear() }
  } finally { $reader.Dispose(); $stream.Dispose() }
  if ($maxColumn -eq 0) { throw 'Worksheet header row missing.' }
} finally { $zip.Dispose() }
`;

async function checksumFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChunk(stream, text) {
  if (!stream.write(text)) await once(stream, 'drain');
}

export async function materializePositionWorkbook(filePath, { limit = 0, powershell = 'powershell.exe' } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Limit XLSX harus bilangan bulat nonnegatif.');
  const sourcePath = resolve(filePath);
  const [sourceInfo, checksum] = await Promise.all([stat(sourcePath), checksumFile(sourcePath)]);
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-position-xlsx-'));
  const tempPath = join(directory, 'position-rows.tmp');
  const output = createWriteStream(tempPath, { encoding: 'utf8' });
  let rowCount = 0;
  let writtenRows = 0;
  const rowBatch = [];
  let failed = false;
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL], {
    windowsHide: true,
    env: { ...process.env, POSITION_XLSX_PATH: sourcePath, POSITION_XLSX_LIMIT: String(limit), POSITION_XLSX_EXPECTED_HEADERS: REQUIRED_HEADERS.join('\u001f') },
  });
  // Attach immediately: the child may close before the stdout iterator drains,
  // otherwise awaiting a late `close` listener can hang the dry-run forever.
  const childClose = once(child, 'close');
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = [];
  child.stderr.on('data', (chunk) => { if (stderr.length < 10) stderr.push(String(chunk)); });
  try {
    await writeChunk(output, '[');
    for await (const line of lines) {
      if (!line) continue;
      rowBatch.push(line);
      rowCount += 1;
      if (rowBatch.length >= 1000) {
        if (writtenRows) await writeChunk(output, ',');
        await writeChunk(output, rowBatch.join(','));
        writtenRows += rowBatch.length; rowBatch.length = 0;
      }
    }
    if (rowBatch.length) {
      if (writtenRows) await writeChunk(output, ',');
      await writeChunk(output, rowBatch.join(','));
      writtenRows += rowBatch.length; rowBatch.length = 0;
    }
    const [code] = await Promise.all([childClose.then(([status]) => status), new Promise((resolvePromise, rejectPromise) => {
      output.end(']'); output.once('finish', resolvePromise); output.once('error', rejectPromise);
    })]);
    if (code !== 0) throw new Error(`Pembacaan sheet segmen_data gagal${stderr.length ? `: ${stderr.join('').trim().slice(0, 300)}` : '.'}`);
  } catch (error) {
    failed = true;
    child.kill(); output.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  if (failed || rowCount === 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Sheet segmen_data tidak menghasilkan baris.');
  }
  return {
    path: tempPath, rowCount, headers: [...REQUIRED_HEADERS], checksum, sourceSizeBytes: sourceInfo.size,
    limited: limit > 0,
    async verifyUnchanged() { return (await checksumFile(sourcePath)) === checksum; },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}
