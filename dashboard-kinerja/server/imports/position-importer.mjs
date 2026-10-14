import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export const POSITION_SOURCE_KEY = 'segmen_data_json';
export const POSITION_SOURCE_SYSTEM = 'segmen_data_json';
export const POSITION_OBJECT_KEY = 'segmen_data.json';
export const POSITION_PARSER_VERSION = 'position-xlsx-stage-v1';
export const POSITION_EXPECTED_ROWS = 1_039_742;
export const POSITION_EXPECTED_DATES = 66;
export const POSITION_EXPECTED_DATE_MIN = '2025-12-31';
export const POSITION_EXPECTED_DATE_MAX = '2026-10-04';

const POSITION_KEYS = Object.freeze({
  position: 'Posisi', segment: 'Segmentasi BPR', product: 'Produk', branch: 'Nama Cabang', office: 'Nama Uker',
  accountCount: 'Jumlah Rekening', balance: 'Saldo',
});
const COLUMN_LIMITS = Object.freeze({
  position: 32, segment: 128, product: 128, branch: 255, office: 255, accountCount: 64, balance: 128,
});
const VALID_SEGMENTS = new Set(['MIKRO', 'RITEL', 'KORPORASI']);
const VALID_PRODUCTS = new Set(['TABUNGAN', 'DEPOSITO', 'GIRO']);
const DECIMAL_MAX_INTEGER_DIGITS = 23;
const DECIMAL_MAX_SCALE = 15;

function skipWhitespace(text, index) {
  while (index < text.length && (/\s/.test(text[index]) || (index === 0 && text[index] === '\uFEFF'))) index += 1;
  return index;
}

function rawObjectTokens(raw) {
  const parsed = new Map();
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== '{') throw new Error('Record posisi harus berupa objek JSON.');
  index += 1;
  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (raw[index] === '}') return parsed;
    if (raw[index] !== '"') throw new Error('Nama properti JSON tidak valid.');
    const keyStart = index++;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const key = JSON.parse(raw.slice(keyStart, index));
    index = skipWhitespace(raw, index);
    if (raw[index++] !== ':') throw new Error('Pemisah properti JSON tidak valid.');
    index = skipWhitespace(raw, index);
    const valueStart = index;
    let string = false;
    let escapeValue = false;
    let curly = 0;
    let square = 0;
    for (; index < raw.length; index += 1) {
      const char = raw[index];
      if (string) {
        if (escapeValue) escapeValue = false;
        else if (char === '\\') escapeValue = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') string = true;
      else if (char === '{') curly += 1;
      else if (char === '}') {
        if (curly === 0 && square === 0) break;
        curly -= 1;
      } else if (char === '[') square += 1;
      else if (char === ']') square -= 1;
      else if (char === ',' && curly === 0 && square === 0) break;
    }
    parsed.set(key, raw.slice(valueStart, index).trim());
    if (raw[index] === ',') index += 1;
    else if (raw[index] === '}') return parsed;
    else throw new Error('Akhir properti JSON tidak valid.');
  }
  throw new Error('Objek JSON tidak lengkap.');
}

/** Streams one JSON array record at a time, retaining only the current source record in memory. */
export async function scanPositionFile(filePath, {
  onRecord = null, highWaterMark = 64 * 1024, expectedRows = POSITION_EXPECTED_ROWS, strictSnapshot = true,
  sourceChecksum = null, sourceSizeBytes = null,
} = {}) {
  const fileStats = await stat(filePath);
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const summary = {
    total: 0, validRows: 0, invalidRows: 0, dateCount: 0, dateMin: null, dateMax: null,
    segments: {}, products: {}, distinctOfficeLabels: 0, distinctBranchLabels: 0,
    sourceTypes: {}, numericValues: { accountCount: { blank: 0, null: 0, zero: 0, invalid: 0 }, balance: { blank: 0, null: 0, zero: 0, invalid: 0 } },
    numericFormats: { accountCount: {}, balance: {} }, numericStringShapes: { accountCount: {}, balance: {} }, fieldBlanks: {}, fieldNulls: {},
    validationErrors: {}, expectedRows,
  };
  const dates = new Set();
  const officeLabels = new Set();
  const branchLabels = new Set();
  let pending = '';
  let started = false;
  let closed = false;
  let inRecord = false;
  let inString = false;
  let escaped = false;
  let curly = 0;
  let square = 0;
  let expectDelimiter = false;
  let rawRecord = '';
  let maxPendingChars = 0;

  async function deliver(recordText) {
    const defaultRowNumber = summary.total + 1;
    const parsed = parsePositionRecord(recordText, defaultRowNumber, summary);
    summary.total += 1;
    if (parsed.parseStatus === 'valid') summary.validRows += 1;
    else summary.invalidRows += 1;
    if (onRecord) await onRecord(parsed);
  }

  async function consume(text) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!started) {
        if (/\s/.test(char) || char === '\uFEFF') continue;
        if (char !== '[') throw new Error('Root sumber Posisi Dana harus berupa array JSON.');
        started = true;
        continue;
      }
      if (closed) {
        if (!/\s/.test(char)) throw new Error('Ada konten setelah array JSON Posisi Dana.');
        continue;
      }
      if (!inRecord) {
        if (/\s/.test(char)) continue;
        if (expectDelimiter) {
          if (char === ',') { expectDelimiter = false; continue; }
          if (char === ']') { closed = true; continue; }
          throw new Error('Pemisah antar record JSON tidak valid.');
        }
        if (char === ']') { closed = true; continue; }
        rawRecord = char;
        inRecord = true;
        inString = char === '"';
        escaped = false;
        curly = char === '{' ? 1 : 0;
        square = char === '[' ? 1 : 0;
        if (curly === 0 && square === 0 && char !== '"') throw new Error('Record Posisi Dana bukan objek JSON.');
        continue;
      }

      rawRecord += char;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') curly += 1;
      else if (char === '}') curly -= 1;
      else if (char === '[') square += 1;
      else if (char === ']') square -= 1;
      if (curly < 0 || square < 0) throw new Error('Struktur JSON Posisi Dana tidak seimbang.');
      if (curly === 0 && square === 0 && !inString) {
        await deliver(rawRecord);
        rawRecord = '';
        inRecord = false;
        expectDelimiter = true;
      }
    }
  }

  const stream = createReadStream(filePath, { highWaterMark });
  try {
    for await (const bytes of stream) {
      hash.update(bytes);
      pending += decoder.write(bytes);
      maxPendingChars = Math.max(maxPendingChars, pending.length);
      await consume(pending);
      pending = '';
    }
    pending += decoder.end();
    if (pending) await consume(pending);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (!started || !closed || inRecord) throw new Error('Array JSON Posisi Dana terpotong atau tidak lengkap.');
  summary.dateCount = dates.size;
  summary.distinctOfficeLabels = officeLabels.size;
  summary.distinctBranchLabels = branchLabels.size;
  if (strictSnapshot) {
    if (summary.total !== expectedRows) addError(summary, 'snapshot_row_count_mismatch');
    if (summary.dateCount !== POSITION_EXPECTED_DATES) addError(summary, 'unexpected_date_count');
    if (summary.dateMin !== POSITION_EXPECTED_DATE_MIN || summary.dateMax !== POSITION_EXPECTED_DATE_MAX) addError(summary, 'unexpected_date_range');
    if (Object.keys(summary.segments).length !== 3) addError(summary, 'unexpected_segment_count');
    if (Object.keys(summary.products).length !== 3) addError(summary, 'unexpected_product_count');
  }
  const streamedChecksum = hash.digest('hex');
  summary.checksum = sourceChecksum ?? streamedChecksum;
  summary.sourceContentChecksum = streamedChecksum;
  summary.sourceSizeBytes = sourceSizeBytes ?? fileStats.size;
  summary.maxPendingChars = maxPendingChars;
  summary.memoryNote = 'Pemrosesan streaming; tidak menyimpan seluruh record sumber.';
  return summary;

  function addError(target, code) { target.validationErrors[code] = (target.validationErrors[code] ?? 0) + 1; }
  function parsePositionRecord(raw, rowNumber, totals) {
    let object;
    let tokens;
    let sourceRaw = raw;
    const errors = [];
    try { object = JSON.parse(raw); tokens = rawObjectTokens(raw); }
    catch {
      errors.push({ field: null, code: 'invalid_json_record' });
      return { rowNumber, rawRecord: raw, parseStatus: 'invalid', mappingStatus: 'unresolved', errors,
        sourcePositionText: null, parsedPositionDate: null, sourceSegment: null, sourceProduct: null,
        sourceBranchLabel: null, sourceOfficeLabel: null, sourceAccountCountText: null, parsedAccountCount: null,
        sourceBalanceText: null, parsedBalance: null };
    }
    if (!object || typeof object !== 'object' || Array.isArray(object)) errors.push({ field: null, code: 'record_not_object' });
    const sourceRowNumberToken = tokens.get('__source_row_number');
    const excelDateSerial = object.__excel_date_serial === true;
    const excelDate1904 = object.__excel_date_1904 === true;
    let actualRowNumber = rowNumber;
    if (sourceRowNumberToken !== undefined || excelDateSerial) {
      if (sourceRowNumberToken !== undefined) {
      const parsedRowNumber = Number(sourceRowNumberToken);
      if (!Number.isSafeInteger(parsedRowNumber) || parsedRowNumber < 1) errors.push({ field: null, code: 'invalid_source_row_number' });
      else actualRowNumber = parsedRowNumber;
      rowNumber = actualRowNumber;
      }
      const internalKeys = new Set(['__source_row_number', '__excel_date_serial', '__excel_date_1904']);
      const rawFields = [...tokens].filter(([key]) => !internalKeys.has(key));
      sourceRaw = `{${rawFields.map(([key, token]) => `${JSON.stringify(key)}:${token}`).join(',')}}`;
      for (const key of internalKeys) { delete object[key]; tokens.delete(key); }
    }
    const row = { rowNumber: actualRowNumber, rawRecord: sourceRaw, errors };
    const typed = {};
    for (const [field, sourceKey] of Object.entries(POSITION_KEYS)) {
      const token = tokens.get(sourceKey);
      const value = object?.[sourceKey];
      if (token === undefined) {
        errors.push({ field: sourceKey, code: 'required_field_missing' });
        typed[field] = null;
        continue;
      }
      if (value === null) {
        totals.fieldNulls[sourceKey] = (totals.fieldNulls[sourceKey] ?? 0) + 1;
        typed[field] = null;
        totals.sourceTypes[`${sourceKey}:null`] = (totals.sourceTypes[`${sourceKey}:null`] ?? 0) + 1;
      } else if (typeof value === 'string' || typeof value === 'number') {
        totals.sourceTypes[`${sourceKey}:${typeof value}`] = (totals.sourceTypes[`${sourceKey}:${typeof value}`] ?? 0) + 1;
        const textValue = typeof value === 'string' ? value : token;
        typed[field] = textValue;
        if (textValue.trim() === '') totals.fieldBlanks[sourceKey] = (totals.fieldBlanks[sourceKey] ?? 0) + 1;
        const limit = COLUMN_LIMITS[field];
        if (Array.from(textValue).length > limit) {
          errors.push({ field: sourceKey, code: 'column_length_exceeded' });
          typed[field] = null;
        }
      } else {
        totals.sourceTypes[`${sourceKey}:${typeof value}`] = (totals.sourceTypes[`${sourceKey}:${typeof value}`] ?? 0) + 1;
        errors.push({ field: sourceKey, code: 'unsupported_source_type' });
        typed[field] = null;
      }
    }

    const positionText = typed.position;
    const positionDate = excelDateSerial ? parseExcelDateSerial(positionText, excelDate1904) : parsePositionDate(positionText);
    if (positionText === null || positionText.trim() === '') errors.push({ field: POSITION_KEYS.position, code: 'position_required' });
    else if (!positionDate) errors.push({ field: POSITION_KEYS.position, code: 'invalid_date' });
    if (positionDate) {
      dates.add(positionDate);
      if (!totals.dateMin || positionDate < totals.dateMin) totals.dateMin = positionDate;
      if (!totals.dateMax || positionDate > totals.dateMax) totals.dateMax = positionDate;
    }

    const segment = typed.segment;
    if (segment === null || segment.trim() === '') errors.push({ field: POSITION_KEYS.segment, code: 'segment_required' });
    else if (!VALID_SEGMENTS.has(segment.trim().toUpperCase())) errors.push({ field: POSITION_KEYS.segment, code: 'unknown_segment' });
    else if (segment !== null && segment.trim() !== '') {
      const key = segment.trim().toUpperCase(); totals.segments[key] = (totals.segments[key] ?? 0) + 1;
    }
    const product = typed.product;
    if (product === null || product.trim() === '') errors.push({ field: POSITION_KEYS.product, code: 'product_required' });
    else if (!VALID_PRODUCTS.has(product.trim().toUpperCase())) errors.push({ field: POSITION_KEYS.product, code: 'unknown_product' });
    else if (product !== null && product.trim() !== '') {
      const key = product.trim().toUpperCase(); totals.products[key] = (totals.products[key] ?? 0) + 1;
    }
    if (typed.office !== null && typed.office !== '') officeLabels.add(typed.office);
    if (typed.branch !== null && typed.branch !== '') branchLabels.add(typed.branch);

    const balanceToken = tokens.get(POSITION_KEYS.balance);
    if (typeof object?.[POSITION_KEYS.balance] === 'string') countStringShape(totals.numericStringShapes.balance, object[POSITION_KEYS.balance]);
    const balance = parsePositionDecimal(object?.[POSITION_KEYS.balance], balanceToken);
    recordNumeric(totals, 'balance', balance);
    if (balance.kind === 'invalid') errors.push({ field: POSITION_KEYS.balance, code: balance.reason });
    const accountToken = tokens.get(POSITION_KEYS.accountCount);
    if (typeof object?.[POSITION_KEYS.accountCount] === 'string') countStringShape(totals.numericStringShapes.accountCount, object[POSITION_KEYS.accountCount]);
    const account = parseAccountCount(object?.[POSITION_KEYS.accountCount], accountToken);
    recordNumeric(totals, 'accountCount', account);
    if (account.kind === 'invalid') errors.push({ field: POSITION_KEYS.accountCount, code: account.reason });

    Object.assign(row, {
      sourcePositionText: typed.position, parsedPositionDate: positionDate,
      sourceSegment: typed.segment, sourceProduct: typed.product,
      sourceBranchLabel: typed.branch, sourceOfficeLabel: typed.office,
      sourceAccountCountText: typed.accountCount, parsedAccountCount: account.kind === 'valid' ? account.value : null,
      sourceBalanceText: typed.balance, parsedBalance: balance.kind === 'valid' ? balance.value : null,
      parseStatus: errors.length ? 'invalid' : 'valid', mappingStatus: 'unresolved',
    });
    for (const error of errors) addError(totals, error.code);
    return row;
  }
}

function parsePositionDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const day = Number(dd); const month = Number(mm); const year = Number(yyyy);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function parseExcelDateSerial(value, date1904) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const serial = Number(value);
  if (!Number.isSafeInteger(Math.floor(serial)) || serial < 0) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(serial) * 86_400_000);
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDecimal(sign, integerPart, fractionPart = '') {
  let integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  let fraction = fractionPart.replace(/0+$/, '');
  if (integer.length > DECIMAL_MAX_INTEGER_DIGITS || fraction.length > DECIMAL_MAX_SCALE) return { kind: 'invalid', reason: 'decimal_out_of_range' };
  const zero = /^0+$/.test(integer) && fraction.length === 0;
  return { kind: 'valid', value: `${!zero && sign === '-' ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`, isZero: zero };
}

function parseJsonDecimalToken(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token ?? '');
  if (!match) return { kind: 'invalid', reason: 'invalid_numeric_format' };
  const [, sign, wholePart, fractionPart = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return { kind: 'invalid', reason: 'decimal_out_of_range' };
  let digits = `${wholePart}${fractionPart}`;
  let scale = fractionPart.length - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  if (scale > digits.length) digits = `${'0'.repeat(scale - digits.length)}${digits}`;
  const split = digits.length - scale;
  return normalizeDecimal(sign, scale ? (digits.slice(0, split) || '0') : digits, scale ? digits.slice(split) : '');
}

function parseStringDecimal(text) {
  const value = text.trim();
  let match = /^([+-]?)(\d+)$/.exec(value);
  if (match) return normalizeDecimal(match[1], match[2]);
  // Full-source profiling found comma-delimited groups of three digits throughout Saldo strings.
  match = /^([+-]?)(\d{1,3}(?:,\d{3})+)$/.exec(value);
  if (match) return normalizeDecimal(match[1], match[2].replaceAll(',', ''));
  return { kind: 'invalid', reason: 'invalid_numeric_format' };
}

function parsePositionDecimal(value, rawToken) {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string') return value.trim() === '' ? { kind: 'blank' } : parseStringDecimal(value);
  if (typeof value === 'number') return parseJsonDecimalToken(rawToken);
  return { kind: 'invalid', reason: 'unsupported_numeric_type' };
}

function parseAccountCount(value, rawToken) {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string' && value.trim() === '') return { kind: 'blank' };
  let exact;
  if (typeof value === 'number') {
    const decimal = parseJsonDecimalToken(rawToken);
    if (decimal.kind !== 'valid') return decimal;
    exact = decimal.value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    let integer = /^([+-]?)(\d+)$/.exec(text);
    if (!integer) integer = /^([+-]?)(\d{1,3}(?:,\d{3})+)$/.exec(text);
    if (!integer) return { kind: 'invalid', reason: 'account_count_must_be_integer' };
    exact = `${integer[1]}${integer[2].replaceAll(',', '')}`;
  } else return { kind: 'invalid', reason: 'unsupported_numeric_type' };
  if (!/^-?\d+$/.test(exact)) return { kind: 'invalid', reason: 'account_count_must_be_integer' };
  const bigint = BigInt(exact);
  if (bigint < -9223372036854775808n || bigint > 9223372036854775807n) return { kind: 'invalid', reason: 'account_count_out_of_range' };
  return { kind: 'valid', value: bigint.toString(), isZero: bigint === 0n };
}

function recordNumeric(summary, key, parsed) {
  const counts = summary.numericValues[key];
  if (parsed.kind === 'blank') counts.blank += 1;
  else if (parsed.kind === 'null') counts.null += 1;
  else if (parsed.kind === 'invalid') counts.invalid += 1;
  else if (parsed.isZero) counts.zero += 1;
  const formatKey = parsed.kind === 'valid' ? (parsed.value.includes('.') ? 'decimal' : 'integer') : parsed.reason ?? parsed.kind;
  summary.numericFormats[key][formatKey] = (summary.numericFormats[key][formatKey] ?? 0) + 1;
}

function countStringShape(counter, value) {
  const trimmed = value.trim();
  const parts = trimmed.match(/\d+/g) ?? [];
  const lengthBucket = (length) => length <= 3 ? String(length) : '4+';
  const punctuation = trimmed.replace(/[\d\s]/g, '');
  const signature = trimmed === '' ? '<blank>' : `${punctuation || 'none'}:${parts.map((part) => lengthBucket(part.length)).join('-') || 'no-digits'}`;
  counter[signature] = (counter[signature] ?? 0) + 1;
}

export async function importPositionFile(filePath, repository, {
  batchSize = 500, expectedRows = POSITION_EXPECTED_ROWS, strictSnapshot = true,
  sourceChecksum = null, sourceSizeBytes = null, verifySourceUnchanged = null,
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('Ukuran chunk posisi harus 1 sampai 2000 baris.');
  const manifest = await scanPositionFile(filePath, { expectedRows, strictSnapshot, sourceChecksum, sourceSizeBytes });
  return repository.withSourceLock(POSITION_SOURCE_KEY, async () => {
    const batch = await repository.reserveBatch({
      sourceKey: POSITION_SOURCE_KEY, sourceSystem: POSITION_SOURCE_SYSTEM, objectKey: POSITION_OBJECT_KEY,
      parserVersion: POSITION_PARSER_VERSION, checksum: manifest.checksum, sourceSizeBytes: manifest.sourceSizeBytes,
      sourceRowCount: manifest.total, validationSummary: manifest,
    });
    if (batch.alreadyStaged) return { status: 'already_staged', batchId: batch.batchId, rows: manifest.total, checksum: manifest.checksum, summary: manifest };
    try {
      let chunkRows = [];
      let invalidRows = 0;
    let processedRows = 0;
    const secondPass = await scanPositionFile(filePath, {
        expectedRows,
        strictSnapshot,
        sourceChecksum,
        sourceSizeBytes,
        onRecord: async (row) => {
          processedRows += 1;
          chunkRows.push(row);
          if (row.parseStatus !== 'valid') invalidRows += 1;
          if (chunkRows.length >= batchSize) {
            await repository.stageChunk(batch, chunkRows, { rowsRead: processedRows, rowsRejected: invalidRows });
            chunkRows = [];
          }
        },
      });
      if (chunkRows.length) await repository.stageChunk(batch, chunkRows, { rowsRead: secondPass.total, rowsRejected: invalidRows });
      if (secondPass.checksum !== manifest.checksum || secondPass.total !== manifest.total) throw new Error('Sumber Posisi Dana berubah antara validasi dan staging; batch tidak boleh diselesaikan.');
      if (verifySourceUnchanged && !(await verifySourceUnchanged())) throw new Error('Workbook Posisi Dana berubah selama proses; batch tidak boleh diselesaikan.');
      const status = await repository.finalizeBatch(batch, secondPass);
      return { status, batchId: batch.batchId, rows: secondPass.total, checksum: secondPass.checksum, summary: secondPass };
    } catch (error) {
      try { await repository.markFailed(batch.batchId); } catch { /* batch cannot be completed if failure status recording fails */ }
      throw error;
    }
  });
}
