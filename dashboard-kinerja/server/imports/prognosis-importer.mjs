import { createHash } from 'node:crypto';

export const PROGNOSIS_SOURCE_KEY = 'prognosa_data_json';
export const PROGNOSIS_SOURCE_SYSTEM = 'prognosa_data_json';
export const PROGNOSIS_OBJECT_KEY_PREFIX = 'prognosa_data.json::';
export const PROGNOSIS_PARSER_VERSION = 'prognosis-xlsx-stage-v1';
export const PROGNOSIS_SHEETS = Object.freeze(['KOMITMEN SBO', 'KOMITMEN BO', 'Per AH', 'PER RMFT']);
export const PROGNOSIS_EXPECTED_ROWS = Object.freeze({ 'KOMITMEN SBO': 51, 'KOMITMEN BO': 130, 'Per AH': 45, 'PER RMFT': 193 });

function skipSpace(text, index) { while (index < text.length && /\s/.test(text[index])) index += 1; return index; }

function readStringEnd(text, start) {
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error('String JSON tidak tertutup.');
}

function readValueEnd(text, start) {
  if (text[start] === '"') return readStringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let curly = 0; let square = 0; let inString = false; let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') curly += 1;
      else if (ch === '}') { curly -= 1; if (!curly && !square) return i + 1; }
      else if (ch === '[') square += 1;
      else if (ch === ']') { square -= 1; if (!curly && !square) return i + 1; }
    }
    throw new Error('Nilai JSON bertingkat tidak tertutup.');
  }
  let i = start;
  while (i < text.length && text[i] !== ',' && text[i] !== '}' && text[i] !== ']' && !/\s/.test(text[i])) i += 1;
  return i;
}

function objectProperties(text, start = 0) {
  let i = skipSpace(text, start);
  if (text[i] !== '{') throw new Error('Struktur JSON yang diharapkan bukan objek.');
  i = skipSpace(text, i + 1);
  const properties = new Map();
  while (text[i] !== '}') {
    const keyEnd = readStringEnd(text, i);
    const key = JSON.parse(text.slice(i, keyEnd));
    i = skipSpace(text, keyEnd);
    if (text[i++] !== ':') throw new Error('Pemisah property JSON tidak valid.');
    const valueStart = skipSpace(text, i);
    const valueEnd = readValueEnd(text, valueStart);
    properties.set(key, { start: valueStart, end: valueEnd, raw: text.slice(valueStart, valueEnd) });
    i = skipSpace(text, valueEnd);
    if (text[i] === ',') i = skipSpace(text, i + 1);
    else if (text[i] !== '}') throw new Error('Pemisah object JSON tidak valid.');
  }
  return properties;
}

function arrayItemSlices(text, start = 0) {
  let i = skipSpace(text, start);
  if (text[i] !== '[') throw new Error('Rows sheet Prognosa harus berupa array.');
  i = skipSpace(text, i + 1);
  const slices = [];
  if (text[i] === ']') return slices;
  while (i < text.length) {
    const valueEnd = readValueEnd(text, i);
    slices.push(text.slice(i, valueEnd));
    i = skipSpace(text, valueEnd);
    if (text[i] === ',') i = skipSpace(text, i + 1);
    else if (text[i] === ']') return slices;
    else throw new Error('Pemisah item array JSON tidak valid.');
  }
  throw new Error('Array rows sheet Prognosa tidak lengkap.');
}

function addError(errors, code, context = {}) {
  errors.push({ code, ...context });
}

export function preparePrognosisSnapshot(fileBytes, { strictSnapshot = true, sourceChecksum = null, sourceSizeBytes = null } = {}) {
  const bytes = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8');
  let payload;
  try { payload = JSON.parse(text); }
  catch { return { checksum, sourceSizeBytes: bytes.byteLength, sheets: [], totalRows: 0, errors: [{ code: 'invalid_json' }] }; }
  if (!payload || typeof payload !== 'object' || !payload.metadata || !payload.sheets) {
    return { checksum, sourceSizeBytes: bytes.byteLength, sheets: [], totalRows: 0, errors: [{ code: 'invalid_payload_structure' }] };
  }

  const errors = [];
  const rootProperties = objectProperties(text);
  const rawSheetsProperty = rootProperties.get('sheets');
  const rawSheets = objectProperties(text, rawSheetsProperty.start);
  const includedSheets = payload.metadata.includedSheets;
  if (!Array.isArray(includedSheets) || JSON.stringify(includedSheets) !== JSON.stringify(PROGNOSIS_SHEETS)) addError(errors, 'included_sheets_mismatch');
  const actualNames = Object.keys(payload.sheets);
  if (JSON.stringify(actualNames) !== JSON.stringify(PROGNOSIS_SHEETS)) addError(errors, 'sheet_names_or_order_mismatch');

  const valueTypes = {}; const valueCounts = { null: 0, blankString: 0, zero: 0 };
  const sheets = [];
  let totalRows = 0;
  for (const sheetName of PROGNOSIS_SHEETS) {
    const sourceSheet = payload.sheets[sheetName];
    const rawSheetRange = rawSheets.get(sheetName);
    if (!sourceSheet || !rawSheetRange || !Array.isArray(sourceSheet.rows)) {
      addError(errors, 'sheet_structure_missing', { sheetName });
      continue;
    }
    let rawSheetProperties;
    try { rawSheetProperties = objectProperties(text, rawSheetRange.start); }
    catch { addError(errors, 'sheet_raw_structure_invalid', { sheetName }); continue; }
    const rawRowsProperty = rawSheetProperties.get('rows');
    if (!rawRowsProperty) { addError(errors, 'rows_array_missing', { sheetName }); continue; }
    let rawRows;
    try { rawRows = arrayItemSlices(text, rawRowsProperty.start); }
    catch { addError(errors, 'raw_rows_extraction_failed', { sheetName }); continue; }
    if (rawRows.length !== sourceSheet.rows.length) addError(errors, 'raw_row_count_mismatch', { sheetName });
    if (strictSnapshot && sourceSheet.rows.length !== PROGNOSIS_EXPECTED_ROWS[sheetName]) {
      addError(errors, 'unexpected_sheet_row_count', { sheetName, expected: PROGNOSIS_EXPECTED_ROWS[sheetName], actual: sourceSheet.rows.length });
    }
    const rowByPhysicalNumber = new Map(sourceSheet.rows.map((row, index) => [Number(row?.row), rawRows[index]]));
    const headers = [];
    for (const headerRowNumber of (Array.isArray(sourceSheet.headerRows) ? sourceSheet.headerRows : [sourceSheet.headerRows])) {
      const rawHeader = rowByPhysicalNumber.get(Number(headerRowNumber));
      if (rawHeader) headers.push(rawHeader);
      else addError(errors, 'header_row_not_found', { sheetName, sourceRowNumber: headerRowNumber });
    }
    const headerLevels = `{${[
      `"sheetName":${JSON.stringify(sheetName)}`,
      `"sourceRange":${JSON.stringify(sourceSheet.sourceRange ?? null)}`,
      `"firstColumn":${JSON.stringify(sourceSheet.firstColumn ?? null)}`,
      `"lastColumn":${JSON.stringify(sourceSheet.lastColumn ?? null)}`,
      `"headerRows":${JSON.stringify(sourceSheet.headerRows ?? [])}`,
      `"headers":[${headers.join(',')}]`,
      `"mergedRanges":${JSON.stringify(sourceSheet.mergedRanges ?? [])}`,
      `"formulaCellCount":${JSON.stringify(sourceSheet.formulaCellCount ?? null)}`,
      `"cachedFormulaCellCount":${JSON.stringify(sourceSheet.cachedFormulaCellCount ?? null)}`,
      `"formulaPolicy":${JSON.stringify(payload.metadata.formulaPolicy ?? null)}`,
    ].join(',')}}`;
    const rows = [];
    sourceSheet.rows.forEach((row, index) => {
      const rowNo = Number(row?.row);
      const rawRow = rawRows[index];
      const rowErrors = [];
      if (!Number.isSafeInteger(rowNo) || rowNo < 1) rowErrors.push('invalid_source_row_number');
      if (!Array.isArray(row?.values)) rowErrors.push('row_values_not_array');
      if (typeof rawRow !== 'string') rowErrors.push('raw_row_missing');
      if (row?.values && !Array.isArray(row.values)) rowErrors.push('row_values_not_array');
      if (Array.isArray(row?.values)) {
        for (const value of row.values) {
          const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          valueTypes[type] = (valueTypes[type] ?? 0) + 1;
          if (value === null) valueCounts.null += 1;
          else if (value === '') valueCounts.blankString += 1;
          else if (typeof value === 'number' && value === 0) valueCounts.zero += 1;
        }
      }
      if (rowErrors.length) for (const code of rowErrors) addError(errors, code, { sheetName, sourceRowNumber: rowNo });
      const firstColumn = sourceSheet.firstColumn ?? 'A';
      const lastColumn = sourceSheet.lastColumn ?? firstColumn;
      rows.push({
        sheetName, sourceRowNumber: rowNo, sourceRange: `${firstColumn}${rowNo}:${lastColumn}${rowNo}`,
        headerLevels, rawRow: rawRow ?? JSON.stringify(row), rowStatus: rowErrors.length ? 'invalid' : 'valid',
      });
    });
    totalRows += rows.length;
    if (sourceSheet.formulaCellCount !== sourceSheet.cachedFormulaCellCount) addError(errors, 'cached_formula_count_mismatch', { sheetName });
    sheets.push({
      sheetName, sourceRange: sourceSheet.sourceRange, firstColumn: sourceSheet.firstColumn, lastColumn: sourceSheet.lastColumn,
      sourceRowCount: rows.length, headerRows: sourceSheet.headerRows, formulaCellCount: sourceSheet.formulaCellCount,
      cachedFormulaCellCount: sourceSheet.cachedFormulaCellCount, rows,
    });
  }

  const metadata = {
    includedSheets: includedSheets ?? null,
    currencyUnit: payload.metadata.currencyUnit ?? null,
    pipelineWeekDateRanges: payload.metadata.pipelineWeekDateRanges ?? null,
    sourceFile: payload.metadata.sourceFile ?? null,
    sourceSizeBytes: payload.metadata.sourceSizeBytes ?? null,
    sourceModifiedAt: payload.metadata.sourceModifiedAt ?? null,
    convertedAt: payload.metadata.convertedAt ?? null,
    formulaPolicy: payload.metadata.formulaPolicy ?? null,
    rowStatusMeaning: 'JSON row syntax only; no detail/subtotal/total classification or aggregation.',
  };
  return { checksum: sourceChecksum ?? checksum, sourceSizeBytes: sourceSizeBytes ?? bytes.byteLength, totalRows, sheets, metadata, valueTypes, valueCounts, errors };
}

export async function executePrognosisStage(snapshot, repository, {
  parserVersion = PROGNOSIS_PARSER_VERSION,
  registryType = 'xlsx_file',
  sourceLocation = 'data/import/prognosa.xlsx',
  objectName = 'prognosa.xlsx',
  objectType = 'xlsx_sheet',
} = {}) {
  if (!snapshot || !Array.isArray(snapshot.sheets) || snapshot.sheets.length !== PROGNOSIS_SHEETS.length || !snapshot.totalRows) {
    const error = new Error('Snapshot Prognosa tidak valid atau tidak memuat empat sheet yang disetujui.');
    error.name = 'PrognosisSourceValidationError'; error.validationErrors = snapshot?.errors ?? []; throw error;
  }
  return repository.withSourceLock(PROGNOSIS_SOURCE_KEY, async () => {
    const batch = await repository.reserveBatch({
      sourceKey: PROGNOSIS_SOURCE_KEY, sourceSystem: PROGNOSIS_SOURCE_SYSTEM,
      parserVersion, checksum: snapshot.checksum, sourceSizeBytes: snapshot.sourceSizeBytes,
      objectKeyPrefix: PROGNOSIS_OBJECT_KEY_PREFIX, sheets: snapshot.sheets,
      registryType, sourceLocation, objectName, objectType,
      sourceRowCount: snapshot.totalRows, validationSummary: {
        sheetRows: Object.fromEntries(snapshot.sheets.map((sheet) => [sheet.sheetName, sheet.sourceRowCount])),
        errors: snapshot.errors.length, currencyUnit: snapshot.metadata.currencyUnit,
        pipelineWeekDateRanges: snapshot.metadata.pipelineWeekDateRanges,
      },
    });
    if (batch.alreadyStaged) return { status: 'already_staged', batchId: batch.batchId, rows: snapshot.totalRows };
    try {
      return await repository.stageSnapshot({ batch, snapshot, sourceSystem: PROGNOSIS_SOURCE_SYSTEM });
    } catch (error) {
      try { await repository.markFailed(batch.batchId); } catch { /* no publication is made on a failed stage */ }
      throw error;
    }
  });
}
