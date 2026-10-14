import { createHash } from 'node:crypto';

export const UKER_SOURCE_KEY = 'uker_list_json';
export const UKER_SOURCE_SYSTEM = 'uker_list_json';
export const UKER_OBJECT_KEY = 'uker_list.json';
export const UKER_PARSER_VERSION = 'uker-xlsx-v1';
export const OFFICE_MASTER_DOMAIN = 'office_master';

const EXPECTED_COUNTS = Object.freeze({ total: 611, KC: 46, KCP: 35, UNIT: 530 });
const COLUMN_LIMITS = Object.freeze({
  source_code_text: 64,
  source_name: 255,
  source_type: 64,
  source_main_branch_code: 64,
  source_area: 255,
  source_class: 100,
  source_rural_urban: 100,
  dimension_source_code: 32,
  office_type: 32,
  office_name: 255,
  area_name: 255,
  branch_class: 100,
  rural_urban: 100,
});

function textCode(value, rowNumber, fieldName, errors) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push({ rowNumber, fieldName, code: 'invalid_code_type' });
    return null;
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    errors.push({ rowNumber, fieldName, code: 'invalid_code_number' });
    return null;
  }
  const valueText = String(value);
  if (!valueText.length || valueText.trim() !== valueText) {
    errors.push({ rowNumber, fieldName, code: 'invalid_code_value' });
    return null;
  }
  return valueText;
}

function sourceText(value, rowNumber, fieldName, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push({ rowNumber, fieldName, code: 'invalid_value_type' });
    return null;
  }
  return String(value);
}

function checkLimit(value, limit, rowNumber, fieldName, errors) {
  if (value !== null && Array.from(value).length > limit) {
    errors.push({ rowNumber, fieldName, code: 'value_exceeds_column_length', limit });
  }
}

/**
 * source_row_number is the one-based position in the JSON array (first record = 1).
 * The source's NO field remains inside raw_record and is not used as row identity.
 */
export function prepareOfficeSnapshot(fileBytes, { strictSnapshot = true, checksum: sourceChecksum, sourceSizeBytes } = {}) {
  const bytes = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
  const checksum = sourceChecksum ?? createHash('sha256').update(bytes).digest('hex');
  const snapshotSizeBytes = sourceSizeBytes ?? bytes.byteLength;
  let records;
  try {
    records = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { checksum, sourceSizeBytes: snapshotSizeBytes, records: [], rows: [], relationships: [], errors: [{ rowNumber: null, fieldName: null, code: 'invalid_json' }] };
  }
  if (!Array.isArray(records)) {
    return { checksum, sourceSizeBytes: snapshotSizeBytes, records: [], rows: [], relationships: [], errors: [{ rowNumber: null, fieldName: null, code: 'root_not_array' }] };
  }

  const errors = [];
  const counts = { total: records.length, KC: 0, KCP: 0, UNIT: 0 };
  const rows = [];
  const seenCodes = new Map();

  records.forEach((record, index) => {
    const rowNumber = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ rowNumber, fieldName: null, code: 'record_not_object' });
      return;
    }

    const code = textCode(record['BRANCH CODE'], rowNumber, 'BRANCH CODE', errors);
    const mainCode = textCode(record['MAIN BRANCH CODE'], rowNumber, 'MAIN BRANCH CODE', errors);
    const name = sourceText(record.BRANCH, rowNumber, 'BRANCH', errors);
    const type = sourceText(record['BRANCH TYPE'], rowNumber, 'BRANCH TYPE', errors);
    const area = sourceText(record.AREA, rowNumber, 'AREA', errors);
    const branchClass = sourceText(record['MAIN BRANCH CLASS'], rowNumber, 'MAIN BRANCH CLASS', errors);
    const ruralUrban = sourceText(record['Rural Urban'], rowNumber, 'Rural Urban', errors);
    if (type && Object.hasOwn(counts, type)) counts[type] += 1;

    for (const [field, value] of Object.entries({
      source_code_text: code,
      source_name: name,
      source_type: type,
      source_main_branch_code: mainCode,
      source_area: area,
      source_class: branchClass,
      source_rural_urban: ruralUrban,
      dimension_source_code: code,
      office_type: type,
      office_name: name,
      area_name: area,
      branch_class: branchClass,
      rural_urban: ruralUrban,
    })) {
      checkLimit(value, COLUMN_LIMITS[field], rowNumber, field, errors);
    }

    if (!code) errors.push({ rowNumber, fieldName: 'BRANCH CODE', code: 'required_code_missing' });
    if (!mainCode) errors.push({ rowNumber, fieldName: 'MAIN BRANCH CODE', code: 'required_code_missing' });
    if (!name) errors.push({ rowNumber, fieldName: 'BRANCH', code: 'required_name_missing' });
    if (!type || !['KC', 'KCP', 'UNIT'].includes(type)) {
      errors.push({ rowNumber, fieldName: 'BRANCH TYPE', code: 'unknown_office_type' });
    }
    if (code) {
      if (seenCodes.has(code)) errors.push({ rowNumber, fieldName: 'BRANCH CODE', code: 'duplicate_office_code', firstRowNumber: seenCodes.get(code) });
      else seenCodes.set(code, rowNumber);
    }

    rows.push({
      rowNumber,
      code,
      mainCode,
      rawRecord: JSON.stringify(record),
      sourceName: name,
      sourceType: type,
      sourceArea: area,
      sourceClass: branchClass,
      sourceRuralUrban: ruralUrban,
      parseStatus: 'valid',
      mappingStatus: 'resolved',
    });
  });

  const validCodes = new Set(rows.map((row) => row.code).filter(Boolean));
  const officeTypeByCode = new Map(rows.filter((row) => row.code).map((row) => [row.code, row.sourceType]));
  for (const row of rows) {
    if (row.mainCode && !validCodes.has(row.mainCode)) {
      errors.push({ rowNumber: row.rowNumber, fieldName: 'MAIN BRANCH CODE', code: 'main_branch_code_not_found' });
      continue;
    }
    const parentType = officeTypeByCode.get(row.mainCode);
    if (parentType !== 'KC') {
      errors.push({ rowNumber: row.rowNumber, fieldName: 'MAIN BRANCH CODE', code: 'unsupported_parent_relationship' });
    }
  }

  if (strictSnapshot) {
    for (const [key, expected] of Object.entries(EXPECTED_COUNTS)) {
      if (counts[key] !== expected) errors.push({ rowNumber: null, fieldName: key, code: 'unexpected_snapshot_count', expected, actual: counts[key] });
    }
  }

  const relationships = rows
    .filter((row) => row.code && row.mainCode && row.code !== row.mainCode)
    .map((row) => ({ childCode: row.code, parentCode: row.mainCode, sourceRowNumber: row.rowNumber }));

  return { checksum, sourceSizeBytes: snapshotSizeBytes, records, rows, relationships, counts, errors };
}

export async function executeOfficeImport(snapshot, repository, { parserVersion = UKER_PARSER_VERSION } = {}) {
  if (!snapshot || snapshot.errors?.length) {
    const error = new Error('Validasi master unit kerja gagal; tidak ada batch yang dipublikasikan.');
    error.name = 'OfficeSourceValidationError';
    error.validationErrors = snapshot?.errors ?? [];
    throw error;
  }

  return repository.withSourceLock(UKER_SOURCE_KEY, async () => {
    const batch = await repository.reserveBatch({
      sourceKey: UKER_SOURCE_KEY,
      sourceSystem: UKER_SOURCE_SYSTEM,
      objectKey: UKER_OBJECT_KEY,
      parserVersion,
      checksum: snapshot.checksum,
      sourceSizeBytes: snapshot.sourceSizeBytes,
      sourceRowCount: snapshot.rows.length,
      validationSummary: { counts: snapshot.counts, relationshipRows: snapshot.relationships.length },
    });

    if (batch.alreadyPublished) return { status: 'already_published', batchId: batch.batchId };

    try {
      await repository.publishSnapshot({ batch, snapshot, sourceSystem: UKER_SOURCE_SYSTEM });
      return { status: 'published', batchId: batch.batchId, rows: snapshot.rows.length, relationships: snapshot.relationships.length };
    } catch (error) {
      try { await repository.markFailed(batch.batchId); } catch { /* the batch remains non-published if failure logging is unavailable */ }
      throw error;
    }
  });
}
