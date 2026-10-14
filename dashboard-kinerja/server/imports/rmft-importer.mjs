import { createHash } from 'node:crypto';

export const RMFT_SOURCE_KEY = 'rmft_list_json';
export const RMFT_SOURCE_SYSTEM = 'rmft_list_json';
export const RMFT_OBJECT_KEY = 'rmft_list.json';
export const RMFT_PARSER_VERSION = 'rmft-xlsx-v1';
export const RMFT_MASTER_DOMAIN = 'rmft_master';

const EXPECTED_RECORDS = 192;
const EXPECTED_UNIQUE_UNITS = 60;
const EXPECTED_UNRESOLVED_854 = 2;
const LIMITS = Object.freeze({
  source_pn: 64,
  dimension_pn: 32,
  source_name: 255,
  rmft_name: 255,
  source_jg: 64,
  job_grade: 64,
  source_job_title: 255,
  job_title: 255,
  source_unit_code: 64,
  assignment_unit_code: 32,
});

function textValue(value, rowNumber, fieldName, errors, { required = false, code = false } = {}) {
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
  if (code && (!text.length || text.trim() !== text)) errors.push({ rowNumber, fieldName, code: 'invalid_code_value' });
  return text;
}

function checkLimit(value, limit, rowNumber, fieldName, errors) {
  if (value !== null && Array.from(value).length > limit) {
    errors.push({ rowNumber, fieldName, code: 'value_exceeds_column_length', limit });
  }
}

/** source_row_number is the one-based array position; the source `No` is retained only in raw_record. */
export function prepareRmftSnapshot(fileBytes, {
  knownOfficeCodes = new Set(), strictSnapshot = true, checksum: sourceChecksum, sourceSizeBytes,
  expectedSnapshot = {},
} = {}) {
  const bytes = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
  const checksum = sourceChecksum ?? createHash('sha256').update(bytes).digest('hex');
  const snapshotSizeBytes = sourceSizeBytes ?? bytes.byteLength;
  let records;
  try {
    records = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { checksum, sourceSizeBytes: snapshotSizeBytes, records: [], rows: [], errors: [{ rowNumber: null, fieldName: null, code: 'invalid_json' }] };
  }
  if (!Array.isArray(records)) {
    return { checksum, sourceSizeBytes: snapshotSizeBytes, records: [], rows: [], errors: [{ rowNumber: null, fieldName: null, code: 'root_not_array' }] };
  }

  const officeCodes = new Set([...knownOfficeCodes].map(String));
  const errors = [];
  const seenPn = new Map();
  const unitCodes = new Set();
  const unresolvedByCode = new Map();
  const rows = [];
  for (const [index, record] of records.entries()) {
    const rowNumber = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ rowNumber, fieldName: null, code: 'record_not_object' });
      rows.push({ rowNumber, rawRecord: JSON.stringify(record), pn: null, name: null, grade: null, jobTitle: null, unitCode: null, parseStatus: 'invalid', mappingStatus: 'invalid' });
      continue;
    }
    const pn = textValue(record.PN, rowNumber, 'PN', errors, { required: true, code: true });
    const name = textValue(record.Nama, rowNumber, 'Nama', errors, { required: true });
    const grade = textValue(record.JG, rowNumber, 'JG', errors);
    const jobTitle = textValue(record.Jabatan, rowNumber, 'Jabatan', errors);
    const unitCode = textValue(record['Kode Uker'], rowNumber, 'Kode Uker', errors, { required: true, code: true });

    for (const [field, value] of Object.entries({
      source_pn: pn, dimension_pn: pn, source_name: name, rmft_name: name,
      source_jg: grade, job_grade: grade, source_job_title: jobTitle,
      job_title: jobTitle, source_unit_code: unitCode, assignment_unit_code: unitCode,
    })) checkLimit(value, LIMITS[field], rowNumber, field, errors);

    if (pn) {
      if (seenPn.has(pn)) errors.push({ rowNumber, fieldName: 'PN', code: 'duplicate_pn', firstRowNumber: seenPn.get(pn) });
      else seenPn.set(pn, rowNumber);
    }
    if (unitCode) {
      unitCodes.add(unitCode);
      if (!officeCodes.has(unitCode)) unresolvedByCode.set(unitCode, (unresolvedByCode.get(unitCode) ?? 0) + 1);
    }
    const mappingStatus = unitCode ? (officeCodes.has(unitCode) ? 'resolved' : 'unresolved') : 'invalid';
    rows.push({
      rowNumber,
      rawRecord: JSON.stringify(record),
      pn,
      name,
      grade,
      jobTitle,
      unitCode,
      parseStatus: pn && name && unitCode ? 'valid' : 'invalid',
      mappingStatus,
    });
  }

  const counts = {
    total: records.length,
    uniquePn: seenPn.size,
    uniqueUnitCodes: unitCodes.size,
    resolved: rows.filter((row) => row.mappingStatus === 'resolved').length,
    unresolved: rows.filter((row) => row.mappingStatus === 'unresolved').length,
    unresolvedByCode: Object.fromEntries([...unresolvedByCode].sort(([a], [b]) => a.localeCompare(b))),
  };
  if (strictSnapshot) {
    const expectedRecords = Object.hasOwn(expectedSnapshot, 'records') ? expectedSnapshot.records : EXPECTED_RECORDS;
    const expectedUniqueUnits = Object.hasOwn(expectedSnapshot, 'uniqueUnitCodes') ? expectedSnapshot.uniqueUnitCodes : EXPECTED_UNIQUE_UNITS;
    const expectedUnresolved854 = Object.hasOwn(expectedSnapshot, 'unresolved854') ? expectedSnapshot.unresolved854 : EXPECTED_UNRESOLVED_854;
    if (counts.total !== expectedRecords) errors.push({ rowNumber: null, fieldName: null, code: 'unexpected_snapshot_count', expected: expectedRecords, actual: counts.total });
    if (counts.uniquePn !== counts.total) errors.push({ rowNumber: null, fieldName: 'PN', code: 'unexpected_unique_count', expected: counts.total, actual: counts.uniquePn });
    if (expectedUniqueUnits !== null && expectedUniqueUnits !== undefined && counts.uniqueUnitCodes !== expectedUniqueUnits) {
      errors.push({ rowNumber: null, fieldName: 'Kode Uker', code: 'unexpected_unique_count', expected: expectedUniqueUnits, actual: counts.uniqueUnitCodes });
    }
    if (expectedUnresolved854 !== null && expectedUnresolved854 !== undefined && (counts.unresolvedByCode['854'] ?? 0) !== expectedUnresolved854) {
      errors.push({ rowNumber: null, fieldName: 'Kode Uker', code: 'unexpected_unresolved_code_count', expected: expectedUnresolved854, actual: counts.unresolvedByCode['854'] ?? 0 });
    }
  }
  return { checksum, sourceSizeBytes: snapshotSizeBytes, records, rows, counts, errors, knownOfficeCodes: [...officeCodes] };
}

export async function executeRmftImport(snapshot, repository, { parserVersion = RMFT_PARSER_VERSION } = {}) {
  if (!snapshot || snapshot.errors?.length) {
    const error = new Error('Validasi master RMFT gagal; tidak ada batch yang dipublikasikan.');
    error.name = 'RmftSourceValidationError';
    error.validationErrors = snapshot?.errors ?? [];
    throw error;
  }
  return repository.withSourceLock(RMFT_SOURCE_KEY, async () => {
    const batch = await repository.reserveBatch({
      sourceKey: RMFT_SOURCE_KEY,
      sourceSystem: RMFT_SOURCE_SYSTEM,
      objectKey: RMFT_OBJECT_KEY,
      parserVersion,
      checksum: snapshot.checksum,
      sourceSizeBytes: snapshot.sourceSizeBytes,
      sourceRowCount: snapshot.rows.length,
      validationSummary: { counts: snapshot.counts },
    });
    if (batch.alreadyPublished) return { status: 'already_published', batchId: batch.batchId };
    try {
      await repository.publishSnapshot({ batch, snapshot, sourceSystem: RMFT_SOURCE_SYSTEM });
      return { status: 'published', batchId: batch.batchId, rows: snapshot.rows.length, unresolved: snapshot.counts.unresolved };
    } catch (error) {
      try { await repository.markFailed(batch.batchId); } catch { /* batch remains unpublished if issue logging also fails */ }
      throw error;
    }
  });
}

/** Verify an existing snapshot's assignment rows before reuse; the DDL has no assignment unique key. */
export function assertAssignmentSnapshotMatches(expectedAssignments, existingAssignments) {
  const existingByRmft = new Map();
  for (const assignment of existingAssignments) {
    const key = String(assignment.rmft_id);
    if (existingByRmft.has(key)) throw new Error('Snapshot RMFT sudah memiliki assignment duplikat; publikasi dihentikan.');
    existingByRmft.set(key, assignment);
  }
  if (existingByRmft.size !== expectedAssignments.length || expectedAssignments.some((expected) => {
    const actual = existingByRmft.get(String(expected.rmft_id));
    return !actual || !sameNullable(actual.office_id, expected.office_id)
      || !sameNullable(actual.source_unit_code, expected.source_unit_code)
      || actual.mapping_status !== expected.mapping_status;
  })) throw new Error('Assignment RMFT yang sudah ada berbeda dari snapshot; publikasi dihentikan untuk mencegah duplikasi.');
  return true;
}

function sameNullable(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left == null && right == null;
  return String(left) === String(right);
}
