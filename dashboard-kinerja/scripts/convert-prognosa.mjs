import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const defaultSource = path.join(projectDirectory, 'data', 'import', 'prognosa.xlsx');
const sourcePath = path.resolve(process.argv[2] || defaultSource);
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const expectedSheets = ['KOMITMEN SBO', 'KOMITMEN BO', 'Per AH', 'PER RMFT'];

const fail = (message) => {
  console.error(`[convert-prognosa] ${message}`);
  process.exitCode = 1;
};

try {
  if (!outputPath) throw new Error('Tentukan path output sementara secara eksplisit; converter tidak lagi menulis dataset JSON ke proyek.');
  await access(sourcePath, constants.R_OK);
  try {
    await access(outputPath, constants.F_OK);
    throw new Error(`Output sudah ada dan tidak akan ditimpa: ${outputPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const sourceStats = await stat(sourcePath);
  const powershell = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourcePath = $env:PROGNOSIS_SOURCE
$outputPath = $env:PROGNOSIS_OUTPUT
$expectedNames = @('KOMITMEN SBO', 'KOMITMEN BO', 'Per AH', 'PER RMFT')
$spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
$relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
$zip = [IO.Compression.ZipFile]::OpenRead($sourcePath)

function Read-ZipEntry([string]$entryName) {
  $entry = $zip.GetEntry($entryName)
  if (-not $entry) { throw "Bagian workbook tidak ditemukan: $entryName" }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-ColumnNumber([string]$column) {
  $number = 0
  foreach ($character in $column.ToCharArray()) {
    $number = ($number * 26) + ([int]$character - [int][char]'A' + 1)
  }
  return $number
}

function Get-ColumnName([int]$number) {
  $name = ''
  while ($number -gt 0) {
    $number--
    $name = [string][char](65 + ($number % 26)) + $name
    $number = [math]::Floor($number / 26)
  }
  return $name
}

function Get-CellValue($cell, $sharedStrings, $sheetName) {
  $type = $cell.GetAttribute('t')
  $valueNode = $cell.SelectSingleNode('./*[local-name()="v"]')
  if ($type -eq 'e') { throw "Sel error tersimpan ditemukan di $sheetName/$($cell.r)." }
  if ($cell.SelectSingleNode('./*[local-name()="f"]') -and (-not $valueNode -or [string]::IsNullOrWhiteSpace($valueNode.InnerText))) {
    throw "Hasil formula tersimpan tidak tersedia di $sheetName/$($cell.r)."
  }
  if ($type -eq 's' -and $valueNode) {
    $index = [int]$valueNode.InnerText
    if ($index -lt 0 -or $index -ge $sharedStrings.Count) { throw "Indeks shared string tidak valid di $sheetName/$($cell.r)." }
    return [string]$sharedStrings[$index]
  }
  if ($type -eq 'inlineStr') {
    return (($cell.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join '')
  }
  if (-not $valueNode) { return $null }
  if ($type -eq 'b') { return ($valueNode.InnerText -eq '1') }
  if ($type -eq 'str' -or $type -eq 'd') { return [string]$valueNode.InnerText }
  $number = 0.0
  if (-not [double]::TryParse($valueNode.InnerText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    throw "Nilai numerik tidak valid di $sheetName/$($cell.r)."
  }
  return $number
}

try {
  [xml]$workbook = Read-ZipEntry 'xl/workbook.xml'
  [xml]$relationships = Read-ZipEntry 'xl/_rels/workbook.xml.rels'
  $workbookManager = [Xml.XmlNamespaceManager]::new($workbook.NameTable)
  $workbookManager.AddNamespace('m', $spreadsheetNs)
  $relationshipManager = [Xml.XmlNamespaceManager]::new($relationships.NameTable)
  $relationshipManager.AddNamespace('p', 'http://schemas.openxmlformats.org/package/2006/relationships')

  $sharedStrings = [System.Collections.Generic.List[string]]::new()
  $sharedStringsXml = $zip.GetEntry('xl/sharedStrings.xml')
  if ($sharedStringsXml) {
    [xml]$sharedStringsDocument = Read-ZipEntry 'xl/sharedStrings.xml'
    $sharedManager = [Xml.XmlNamespaceManager]::new($sharedStringsDocument.NameTable)
    $sharedManager.AddNamespace('m', $spreadsheetNs)
    foreach ($item in $sharedStringsDocument.SelectNodes('//m:si', $sharedManager)) {
      $sharedStrings.Add((($item.SelectNodes('.//m:t', $sharedManager) | ForEach-Object { $_.InnerText }) -join ''))
    }
  }

  $relationshipTargets = @{}
  foreach ($relationship in $relationships.SelectNodes('//p:Relationship', $relationshipManager)) {
    $relationshipTargets[$relationship.Id] = $relationship.Target
  }

  $sheets = [ordered]@{}
  $periodHeaders = [ordered]@{}
  $pipelineWeekLabels = [ordered]@{}
  $foundNames = [System.Collections.Generic.List[string]]::new()

  foreach ($sheetNode in $workbook.SelectNodes('//m:sheets/m:sheet', $workbookManager)) {
    $sheetName = $sheetNode.GetAttribute('name')
    if ($sheetName -notin $expectedNames) { continue }
    if ($sheets.Contains($sheetName)) { throw "Nama sheet duplikat: $sheetName" }

    $relationshipId = $sheetNode.GetAttribute('id', $relationshipNs)
    $target = $relationshipTargets[$relationshipId]
    if (-not $target) { throw "Relasi untuk sheet $sheetName tidak ditemukan." }
    if ($target.StartsWith('/')) { $entryName = $target.TrimStart('/') }
    elseif ($target.StartsWith('xl/')) { $entryName = $target }
    else { $entryName = "xl/$target" }

    [xml]$sheetXml = Read-ZipEntry $entryName
    $sheetManager = [Xml.XmlNamespaceManager]::new($sheetXml.NameTable)
    $sheetManager.AddNamespace('m', $spreadsheetNs)
    $dimensionNode = $sheetXml.SelectSingleNode('//m:dimension', $sheetManager)
    if (-not $dimensionNode) { throw "Dimensi sheet $sheetName tidak ditemukan." }
    $rangeMatch = [regex]::Match($dimensionNode.ref, '^([A-Z]+)(\d+):([A-Z]+)(\d+)$')
    if (-not $rangeMatch.Success) { throw "Rentang sheet tidak dikenal: $sheetName ($($dimensionNode.ref))." }

    $startColumn = Get-ColumnNumber $rangeMatch.Groups[1].Value
    $startRow = [int]$rangeMatch.Groups[2].Value
    $endColumn = Get-ColumnNumber $rangeMatch.Groups[3].Value
    $endRow = [int]$rangeMatch.Groups[4].Value
    $rowNodes = @{}
    foreach ($rowNode in $sheetXml.SelectNodes('//m:sheetData/m:row', $sheetManager)) {
      $rowNodes[[int]$rowNode.r] = $rowNode
    }

    $rowOutput = [System.Collections.Generic.List[object]]::new()
    $valueByAddress = @{}
    $formulaCellCount = 0
    $cachedFormulaCellCount = 0
    $headerRows = if ($sheetName -eq 'PER RMFT') { @(1) } else { @(1, 2, 3) }
    $headerLabels = [System.Collections.Generic.List[object]]::new()
    $weekLabels = [System.Collections.Generic.List[string]]::new()

    for ($rowNumber = $startRow; $rowNumber -le $endRow; $rowNumber++) {
      $values = [object[]]::new($endColumn - $startColumn + 1)
      $rowNode = $rowNodes[$rowNumber]
      if ($rowNode) {
        foreach ($cell in $rowNode.SelectNodes('./m:c', $sheetManager)) {
          $cellMatch = [regex]::Match($cell.r, '^([A-Z]+)(\d+)$')
          if (-not $cellMatch.Success) { throw "Referensi sel tidak valid di sheet $sheetName." }
          $columnNumber = Get-ColumnNumber $cellMatch.Groups[1].Value
          if ($columnNumber -lt $startColumn -or $columnNumber -gt $endColumn) { continue }
          $value = Get-CellValue $cell $sharedStrings $sheetName
          $values[$columnNumber - $startColumn] = $value
          $valueByAddress[$cell.r] = $value

          if ($cell.SelectSingleNode('./m:f', $sheetManager)) {
            $formulaCellCount++
            $cachedFormulaCellCount++
          }
          if ($rowNumber -in $headerRows -and $value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)) {
            if ($rowNumber -eq 1 -and $value -match '^PIPELINE W[1-5]$' -and -not $weekLabels.Contains($value)) { $weekLabels.Add($value) }
            if ($value -match '(?i)202\d|JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER|PIPELINE|MTD|YTD|RKA|GAP|KECUKUPAN|KOMITMEN|TOTAL') {
              $headerLabels.Add([ordered]@{ cell = $cell.r; label = $value })
            }
          }
        }
      }
      $rowOutput.Add([ordered]@{ row = $rowNumber; values = $values })
    }

    $merges = @()
    foreach ($merge in $sheetXml.SelectNodes('//m:mergeCells/m:mergeCell', $sheetManager)) { $merges += $merge.ref }
    $sheetResult = [ordered]@{
      sourceRange = $dimensionNode.ref
      firstColumn = Get-ColumnName $startColumn
      lastColumn = Get-ColumnName $endColumn
      headerRows = $headerRows
      formulaCellCount = $formulaCellCount
      cachedFormulaCellCount = $cachedFormulaCellCount
      mergedRanges = $merges
      rows = $rowOutput.ToArray()
    }

    $sheets[$sheetName] = $sheetResult
    $periodHeaders[$sheetName] = $headerLabels.ToArray()
    $pipelineWeekLabels[$sheetName] = $weekLabels.ToArray()
    $foundNames.Add($sheetName)
  }

  $missingNames = @($expectedNames | Where-Object { $_ -notin $foundNames })
  if ($missingNames.Count -gt 0 -or $foundNames.Count -ne 4) { throw "Empat sheet wajib tidak lengkap. Tidak terbaca: $($missingNames -join ', ')." }

  function Assert-Cell($sheetName, $address, $expected) {
    $actual = $valueByAddress = $null
    $rowMatch = [regex]::Match($address, '^([A-Z]+)(\d+)$')
    $column = Get-ColumnNumber $rowMatch.Groups[1].Value
    $rowNumber = [int]$rowMatch.Groups[2].Value
    $sheet = $sheets[$sheetName]
    $row = $sheet.rows | Where-Object row -eq $rowNumber | Select-Object -First 1
    if (-not $row) { throw "Sel validasi tidak ada: $sheetName/$address." }
    $start = Get-ColumnNumber $sheet.firstColumn
    $actual = $row.values[$column - $start]
    if ($expected -is [double]) {
      if ($actual -isnot [double] -or [math]::Abs($actual - $expected) -gt 0.00000001) { throw "Nilai validasi berbeda di $sheetName/$address." }
    } elseif ($actual -cne $expected) {
      throw "Label validasi berbeda di $sheetName/$address." 
    }
  }

  Assert-Cell 'KOMITMEN SBO' 'D4' 12.75
  Assert-Cell 'KOMITMEN SBO' 'D38' 348.76
  Assert-Cell 'KOMITMEN SBO' 'A38' 'TOTAL'
  Assert-Cell 'KOMITMEN BO' 'D29' 3953.1600000000003
  Assert-Cell 'KOMITMEN BO' 'D58' 3925.89
  Assert-Cell 'KOMITMEN BO' 'D87' 27.250000000000011
  Assert-Cell 'KOMITMEN BO' 'A29' 'TOTAL'
  Assert-Cell 'KOMITMEN BO' 'A58' 'TOTAL'
  Assert-Cell 'KOMITMEN BO' 'A87' 'TOTAL'
  Assert-Cell 'Per AH' 'D35' 3953.1599999999989
  Assert-Cell 'Per AH' 'A35' 'GRAND TOTAL'
  Assert-Cell 'PER RMFT' 'K2' 3.5
  Assert-Cell 'PER RMFT' 'K192' 1179.8220833333337
  Assert-Cell 'PER RMFT' 'A192' 'Grand Total'

  foreach ($sheetName in $expectedNames) {
    $sheet = $sheets[$sheetName]
    if ($sheet.formulaCellCount -ne $sheet.cachedFormulaCellCount) { throw "Formula tanpa hasil tersimpan pada $sheetName." }
  }

  $sourceInfo = Get-Item -LiteralPath $sourcePath
  $payload = [ordered]@{
    metadata = [ordered]@{
      sourceFile = [IO.Path]::GetFileName($sourcePath)
      sourceSizeBytes = $sourceInfo.Length
      sourceModifiedAt = $sourceInfo.LastWriteTimeUtc.ToString('o')
      convertedAt = [DateTimeOffset]::UtcNow.ToString('o')
      includedSheets = $foundNames.ToArray()
      periodHeaders = $periodHeaders
      pipelineWeekLabels = $pipelineWeekLabels
      pipelineWeekDateRanges = $null
      currencyUnit = $null
      formulaPolicy = 'Nilai hasil tersimpan dari workbook; formula tidak dihitung ulang.'
    }
    sheets = $sheets
  }

  $json = ConvertTo-Json -InputObject $payload -Depth 100 -Compress
  [IO.File]::WriteAllText($outputPath, $json, [Text.UTF8Encoding]::new($false))
  Write-Output "converted sheets=$($foundNames.Count) output=$outputPath"
} finally {
  $zip.Dispose()
}
`;

  const encodedScript = Buffer.from(powershell, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
    encoding: 'utf8',
    env: { ...process.env, PROGNOSIS_SOURCE: sourcePath, PROGNOSIS_OUTPUT: outputPath },
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Konversi PowerShell gagal.').trim());
  if (result.stdout?.trim()) console.log(result.stdout.trim());

  const payload = JSON.parse(await readFile(outputPath, 'utf8'));
  if (JSON.stringify(payload.metadata.includedSheets) !== JSON.stringify(expectedSheets)) {
    throw new Error('Daftar sheet pada JSON hasil konversi tidak sesuai urutan sumber yang disetujui.');
  }

  const sheetRowExpectations = {
    'KOMITMEN SBO': { rows: 51, formulas: 2065 },
    'KOMITMEN BO': { rows: 130, formulas: 5097 },
    'Per AH': { rows: 45, formulas: 3042 },
    'PER RMFT': { rows: 193, formulas: 1146 },
  };
  for (const [sheetName, expected] of Object.entries(sheetRowExpectations)) {
    const sheet = payload.sheets[sheetName];
    if (!sheet || sheet.rows.length !== expected.rows) throw new Error(`Jumlah baris JSON tidak cocok: ${sheetName}.`);
    if (sheet.formulaCellCount !== expected.formulas || sheet.cachedFormulaCellCount !== expected.formulas) {
      throw new Error(`Hasil formula tersimpan tidak lengkap: ${sheetName}.`);
    }
  }

  const cell = (sheetName, address) => {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    let column = 0;
    for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
    const sheet = payload.sheets[sheetName];
    let firstColumn = 0;
    for (const char of sheet.firstColumn) firstColumn = firstColumn * 26 + char.charCodeAt(0) - 64;
    return sheet.rows[Number(match[2]) - 1].values[column - firstColumn];
  };
  const verify = (sheetName, address, expected) => {
    const actual = cell(sheetName, address);
    if (typeof expected === 'number' ? typeof actual !== 'number' || Math.abs(actual - expected) > 1e-8 : actual !== expected) {
      throw new Error(`Nilai JSON tidak sesuai untuk ${sheetName}/${address}.`);
    }
  };

  verify('KOMITMEN SBO', 'D4', 12.75);
  verify('KOMITMEN SBO', 'D38', 348.76);
  verify('KOMITMEN SBO', 'A38', 'TOTAL');
  verify('KOMITMEN BO', 'D29', 3953.1600000000003);
  verify('KOMITMEN BO', 'D58', 3925.89);
  verify('KOMITMEN BO', 'D87', 27.250000000000011);
  verify('KOMITMEN BO', 'A29', 'TOTAL');
  verify('KOMITMEN BO', 'A58', 'TOTAL');
  verify('KOMITMEN BO', 'A87', 'TOTAL');
  verify('Per AH', 'D35', 3953.1599999999989);
  verify('Per AH', 'A35', 'GRAND TOTAL');
  verify('PER RMFT', 'K2', 3.5);
  verify('PER RMFT', 'K192', 1179.8220833333337);
  verify('PER RMFT', 'A192', 'Grand Total');
  verify('PER RMFT', 'F2', 0);
  verify('PER RMFT', 'L2', null);

  const countNonEmpty = (sheetName, columnName, startRow, endRow) => {
    const sheet = payload.sheets[sheetName];
    let index = 0;
    for (const char of columnName) index = index * 26 + char.charCodeAt(0) - 64;
    let firstColumn = 0;
    for (const char of sheet.firstColumn) firstColumn = firstColumn * 26 + char.charCodeAt(0) - 64;
    let count = 0;
    for (let row = startRow; row <= endRow; row++) {
      const value = sheet.rows[row - 1].values[index - firstColumn];
      if (typeof value === 'number') count++;
    }
    return count;
  };
  if (countNonEmpty('KOMITMEN SBO', 'A', 4, 37) !== 34) throw new Error('Jumlah data unit KOMITMEN SBO tidak sesuai audit.');
  if (countNonEmpty('KOMITMEN BO', 'A', 4, 28) !== 25 || countNonEmpty('KOMITMEN BO', 'A', 33, 57) !== 25 || countNonEmpty('KOMITMEN BO', 'A', 62, 86) !== 25) {
    throw new Error('Jumlah data per kelompok KOMITMEN BO tidak sesuai audit.');
  }
  if (countNonEmpty('Per AH', 'A', 4, 33) !== 25) throw new Error('Jumlah data Per AH tidak sesuai audit.');
  if (countNonEmpty('PER RMFT', 'A', 2, 191) !== 190) throw new Error('Jumlah data PER RMFT tidak sesuai audit.');

  console.log(`Verified local JSON (${(await stat(outputPath)).size} bytes); source size ${sourceStats.size} bytes; blank and numeric zero are distinct.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
