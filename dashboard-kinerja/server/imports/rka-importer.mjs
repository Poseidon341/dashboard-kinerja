import { createHash } from 'node:crypto';

export const RKA_SOURCE_KEY = 'tabel_rka_json';
export const RKA_SOURCE_SYSTEM = 'tabel_rka_json';
export const RKA_OBJECT_KEY = 'tabel_rka.json';
export const RKA_PARSER_VERSION = 'rka-xlsx-stage-v1';
export const RKA_EXPECTED_ROWS = 4577;
export const RKA_MONTHS = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

const EXPECTED_CATEGORIES = 17;
const EXPECTED_OFFICE_CODES = 589;
const DECIMAL_INTEGER_DIGITS = 23;
const DECIMAL_SCALE = 15;
const LIMITS = Object.freeze({ noUrut: 64, rkaKey: 255, category: 255, unitCode: 64 });

function skipWhitespace(text, index) {
  while (/\s/.test(text[index] ?? '')) index += 1;
  return index;
}

function readStringEnd(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') return index + 1;
  }
  throw new Error('String JSON tidak tertutup.');
}

function readJsonValueEnd(text, start) {
  const first = text[start];
  if (first === '"') return readStringEnd(text, start);
  if (first === '{' || first === '[') {
    const opening = first;
    const closing = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opening) depth += 1;
      else if (ch === closing) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    throw new Error('Nilai JSON bertingkat tidak tertutup.');
  }
  let index = start;
  while (index < text.length && text[index] !== ',' && text[index] !== '}' && text[index] !== ']' && !/\s/.test(text[index])) index += 1;
  return index;
}

/** Extract each array record as source text so raw_record does not round JSON numbers through JS Number. */
export function extractRawJsonArrayRecords(text) {
  const source = String(text);
  let index = skipWhitespace(source, 0);
  if (source[index] !== '[') throw new Error('Root sumber JSON harus berupa array.');
  index = skipWhitespace(source, index + 1);
  const records = [];
  if (source[index] === ']') return records;
  while (index < source.length) {
    const start = index;
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escaped = false;
    let endedByComma = false;
    for (; index < source.length; index += 1) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') braces += 1;
      else if (ch === '}') braces -= 1;
      else if (ch === '[') brackets += 1;
      else if (ch === ']') {
        if (braces === 0 && brackets === 0) {
          const raw = source.slice(start, index).trim();
          if (raw) records.push(raw);
          return records;
        }
        brackets -= 1;
      } else if (ch === ',' && braces === 0 && brackets === 0) {
        records.push(source.slice(start, index).trim());
        index += 1;
        endedByComma = true;
        break;
      }
    }
    if (!endedByComma) break;
    index = skipWhitespace(source, index);
  }
  throw new Error('Array sumber JSON tidak lengkap.');
}

function rawObjectValues(rawRecord) {
  const values = new Map();
  let index = skipWhitespace(rawRecord, 0);
  if (rawRecord[index] !== '{') throw new Error('Baris sumber RKA bukan objek JSON.');
  index = skipWhitespace(rawRecord, index + 1);
  while (rawRecord[index] !== '}') {
    const keyEnd = readStringEnd(rawRecord, index);
    const key = JSON.parse(rawRecord.slice(index, keyEnd));
    index = skipWhitespace(rawRecord, keyEnd);
    if (rawRecord[index] !== ':') throw new Error('Properti JSON tidak memiliki pemisah.');
    const valueStart = skipWhitespace(rawRecord, index + 1);
    const valueEnd = readJsonValueEnd(rawRecord, valueStart);
    values.set(key, rawRecord.slice(valueStart, valueEnd));
    index = skipWhitespace(rawRecord, valueEnd);
    if (rawRecord[index] === ',') index = skipWhitespace(rawRecord, index + 1);
    else if (rawRecord[index] !== '}') throw new Error('Pemisah objek JSON tidak valid.');
  }
  return values;
}

function normalizeDecimal(sign, integerRaw, fractionRaw = '') {
  let integer = integerRaw.replace(/^0+(?=\d)/, '');
  let fraction = fractionRaw.replace(/0+$/, '');
  if (!integer) integer = '0';
  if (integer.length > DECIMAL_INTEGER_DIGITS || fraction.length > DECIMAL_SCALE) {
    return { kind: 'invalid', reason: 'decimal_out_of_range' };
  }
  const isZero = /^0+$/.test(integer) && fraction.length === 0;
  return { kind: 'valid', decimalText: `${!isZero && sign === '-' ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`, isZero };
}

function parseJsonNumberToken(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return { kind: 'invalid', reason: 'invalid_json_number' };
  const [, sign, integerPart, fractionPart = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return { kind: 'invalid', reason: 'decimal_out_of_range' };
  let digits = `${integerPart}${fractionPart}`;
  let scale = fractionPart.length - exponent;
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  if (scale > digits.length) digits = `${'0'.repeat(scale - digits.length)}${digits}`;
  const split = digits.length - scale;
  const whole = scale ? digits.slice(0, split) || '0' : digits;
  const fractional = scale ? digits.slice(split) : '';
  return normalizeDecimal(sign, whole, fractional);
}

/** Parse JSON numeric tokens exactly and Indonesian-formatted strings without IEEE-754 arithmetic. */
export function parseRkaDecimal(value, rawToken = null) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return { kind: 'blank', decimalText: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || rawToken === null) return { kind: 'invalid', reason: 'numeric_source_lexeme_unavailable' };
    return parseJsonNumberToken(rawToken);
  }
  if (typeof value !== 'string') return { kind: 'invalid', reason: 'unsupported_value_type' };
  const text = value.trim();
  const match = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/.exec(text);
  if (!match) return { kind: 'invalid', reason: 'invalid_indonesian_number_format' };
  return normalizeDecimal(match[1], match[2].replaceAll('.', ''), match[3] ?? '');
}

function sourceScalar(value, rowNumber, fieldName, limit, errors, { required = false, code = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) errors.push({ rowNumber, fieldName, code: 'required_value_missing' });
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push({ rowNumber, fieldName, code: 'invalid_value_type' });
    return null;
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || (code && (!Number.isSafeInteger(value) || value < 0)))) {
    errors.push({ rowNumber, fieldName, code: 'invalid_numeric_value' });
    return null;
  }
  const text = String(value);
  if (code && (!text.trim() || text.trim() !== text)) errors.push({ rowNumber, fieldName, code: 'invalid_code_value' });
  if (limit !== null && Array.from(text).length > limit) {
    errors.push({ rowNumber, fieldName, code: 'value_exceeds_column_length', limit });
    return null;
  }
  return text;
}

export function prepareRkaSnapshot(fileBytes, { knownOfficeCodes = new Set(), strictSnapshot = true, checksum: sourceChecksum, sourceSizeBytes } = {}) {
  const bytes = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
  const checksum = sourceChecksum ?? createHash('sha256').update(bytes).digest('hex');
  const snapshotSizeBytes = sourceSizeBytes ?? bytes.byteLength;
  const sourceText = bytes.toString('utf8');
  let records;
  try { records = JSON.parse(sourceText); }
  catch { return { checksum, sourceSizeBytes: snapshotSizeBytes, rows: [], categories: [], errors: [{ rowNumber: null, fieldName: null, code: 'invalid_json' }] }; }
  if (!Array.isArray(records)) return { checksum, sourceSizeBytes: snapshotSizeBytes, rows: [], categories: [], errors: [{ rowNumber: null, fieldName: null, code: 'root_not_array' }] };

  let rawRecords;
  try { rawRecords = extractRawJsonArrayRecords(sourceText); }
  catch { return { checksum, sourceSizeBytes: snapshotSizeBytes, rows: [], categories: [], errors: [{ rowNumber: null, fieldName: null, code: 'raw_record_extraction_failed' }] }; }
  if (rawRecords.length !== records.length) return { checksum, sourceSizeBytes: snapshotSizeBytes, rows: [], categories: [], errors: [{ rowNumber: null, fieldName: null, code: 'raw_record_count_mismatch' }] };

  const masterCodes = new Set([...knownOfficeCodes].map((code) => String(code).trim()));
  const errors = [];
  const categorySet = new Set();
  const unitCodeSet = new Set();
  const pairRows = new Map();
  const monthTotals = { totalCells: 0, validNumeric: 0, blank: 0, zero: 0, invalid: 0, sourceTypeCounts: {}, decimalScaleMax: 0 };
  const rows = [];

  records.forEach((record, index) => {
    const rowNumber = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ rowNumber, fieldName: null, code: 'record_not_object' });
      rows.push({ rowNumber, rawRecord: rawRecords[index], rawMonthValues: null, sourceNoUrut: null, sourceRkaKey: null, sourceCategory: null, sourceUnitCode: null, unitCodeKey: null, monthValues: {}, parseStatus: 'invalid', mappingStatus: 'unresolved' });
      return;
    }
    const rawRecord = rawRecords[index];
    let rawFields;
    try { rawFields = rawObjectValues(rawRecord); }
    catch {
      errors.push({ rowNumber, fieldName: null, code: 'raw_record_field_extraction_failed' });
      rawFields = new Map();
    }
    const rowErrors = [];
    const sourceNoUrut = sourceScalar(record['NO URUT'], rowNumber, 'NO URUT', 64, rowErrors);
    const sourceRkaKey = sourceScalar(record['RKA KEY'], rowNumber, 'RKA KEY', LIMITS.rkaKey, rowErrors);
    const sourceCategory = sourceScalar(record['MATA ANGGARAN'], rowNumber, 'MATA ANGGARAN', LIMITS.category, rowErrors, { required: true });
    const sourceUnitCode = sourceScalar(record['KODE UKER'], rowNumber, 'KODE UKER', LIMITS.unitCode, rowErrors, { required: true, code: true });
    const unitCodeKey = sourceUnitCode?.trim() || null;
    if (!sourceRkaKey) rowErrors.push({ rowNumber, fieldName: 'RKA KEY', code: 'required_value_missing' });
    if (sourceCategory && !sourceCategory.trim()) rowErrors.push({ rowNumber, fieldName: 'MATA ANGGARAN', code: 'required_value_missing' });
    if (unitCodeKey) {
      unitCodeSet.add(unitCodeKey);
      if (!masterCodes.has(unitCodeKey)) rowErrors.push({ rowNumber, fieldName: 'KODE UKER', code: 'office_code_not_found_in_master' });
    }
    if (sourceCategory !== null && unitCodeKey) {
      const pairKey = `${unitCodeKey}\u0000${sourceCategory}`;
      const firstRowNumber = pairRows.get(pairKey);
      if (firstRowNumber) rowErrors.push({ rowNumber, fieldName: 'KODE UKER/MATA ANGGARAN', code: 'duplicate_unit_category', firstRowNumber });
      else pairRows.set(pairKey, rowNumber);
      categorySet.add(sourceCategory);
    }

    const rawMonths = {};
    const rawMonthEntries = [];
    const parsedMonths = {};
    for (const month of RKA_MONTHS) {
      const valueExists = Object.hasOwn(record, month);
      const value = valueExists ? record[month] : null;
      rawMonths[month] = value;
      rawMonthEntries.push(`${JSON.stringify(month)}:${valueExists ? (rawFields.get(month) ?? 'null') : 'null'}`);
      monthTotals.totalCells += 1;
      monthTotals.sourceTypeCounts[!valueExists ? 'missing' : value === null ? 'null' : typeof value] = (monthTotals.sourceTypeCounts[!valueExists ? 'missing' : value === null ? 'null' : typeof value] ?? 0) + 1;
      const parsed = parseRkaDecimal(value, rawFields.get(month));
      parsedMonths[month] = parsed;
      if (parsed.kind === 'blank') monthTotals.blank += 1;
      else if (parsed.kind === 'valid') {
        monthTotals.validNumeric += 1;
        if (parsed.isZero) monthTotals.zero += 1;
        const scale = parsed.decimalText.includes('.') ? parsed.decimalText.length - parsed.decimalText.indexOf('.') - 1 : 0;
        monthTotals.decimalScaleMax = Math.max(monthTotals.decimalScaleMax, scale);
      } else {
        monthTotals.invalid += 1;
        rowErrors.push({ rowNumber, fieldName: month, code: parsed.reason });
      }
    }
    errors.push(...rowErrors);
    rows.push({
      rowNumber, rawRecord, rawMonthValues: `{${rawMonthEntries.join(',')}}`, sourceNoUrut, sourceRkaKey,
      sourceCategory, sourceUnitCode, unitCodeKey, monthValues: parsedMonths,
      parseStatus: rowErrors.some((error) => error.rowNumber === rowNumber) ? 'invalid' : 'valid',
      // No official category-to-metric mapping has been approved yet.
      mappingStatus: 'unresolved',
    });
  });

  const officeCodesMatched = [...unitCodeSet].filter((code) => masterCodes.has(code)).length;
  const summary = {
    total: records.length,
    categories: categorySet.size,
    uniqueOfficeCodes: unitCodeSet.size,
    officeCodesMatched,
    officeCodesUnmatched: [...unitCodeSet].filter((code) => !masterCodes.has(code)).sort(),
    duplicateUnitCategoryPairs: [...errors].filter((error) => error.code === 'duplicate_unit_category').length,
    validRows: rows.filter((row) => row.parseStatus === 'valid').length,
    invalidRows: rows.filter((row) => row.parseStatus !== 'valid').length,
    monthValues: monthTotals,
  };
  if (strictSnapshot) {
    if (summary.total !== RKA_EXPECTED_ROWS) errors.push({ rowNumber: null, fieldName: null, code: 'unexpected_snapshot_count', expected: RKA_EXPECTED_ROWS, actual: summary.total });
    if (summary.categories !== EXPECTED_CATEGORIES) errors.push({ rowNumber: null, fieldName: 'MATA ANGGARAN', code: 'unexpected_category_count', expected: EXPECTED_CATEGORIES, actual: summary.categories });
    if (summary.uniqueOfficeCodes !== EXPECTED_OFFICE_CODES) errors.push({ rowNumber: null, fieldName: 'KODE UKER', code: 'unexpected_office_code_count', expected: EXPECTED_OFFICE_CODES, actual: summary.uniqueOfficeCodes });
  }
  return { checksum, sourceSizeBytes: snapshotSizeBytes, rows, categories: [...categorySet], summary, errors, knownOfficeCodes: [...masterCodes] };
}

export async function executeRkaStage(snapshot, repository, { parserVersion = RKA_PARSER_VERSION } = {}) {
  if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
    const error = new Error('Snapshot RKA tidak valid atau tidak memiliki baris.');
    error.name = 'RkaSourceValidationError';
    error.validationErrors = snapshot?.errors ?? [];
    throw error;
  }
  return repository.withSourceLock(RKA_SOURCE_KEY, async () => {
    const batch = await repository.reserveBatch({
      sourceKey: RKA_SOURCE_KEY, sourceSystem: RKA_SOURCE_SYSTEM, objectKey: RKA_OBJECT_KEY,
      parserVersion, checksum: snapshot.checksum, sourceSizeBytes: snapshot.sourceSizeBytes,
      sourceRowCount: snapshot.rows.length, validationSummary: snapshot.summary,
    });
    if (batch.alreadyStaged) return { status: 'already_staged', batchId: batch.batchId, rows: snapshot.rows.length };
    try {
      return await repository.stageSnapshot({ batch, snapshot, sourceSystem: RKA_SOURCE_SYSTEM });
    } catch (error) {
      try { await repository.markFailed(batch.batchId); } catch { /* no publication occurs if issue recording also fails */ }
      throw error;
    }
  });
}
