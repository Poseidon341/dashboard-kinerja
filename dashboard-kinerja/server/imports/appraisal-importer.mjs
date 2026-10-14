import { createHash } from 'node:crypto';

export const APPRAISAL_SOURCE_KEY = 'appraisal_google_sheets';
export const APPRAISAL_SOURCE_SYSTEM = 'appraisal_google_sheets';
export const APPRAISAL_PARSER_VERSION = 'appraisal-api-stage-v1';
export const APPRAISAL_PAGE_SIZE = 500;

const PROFILE_FIELDS = Object.freeze(['Nama RM', 'PN', 'Kode KC', 'Kantor Cabang', 'Kode Uker', 'Unit Kerja', 'Jabatan', 'JG']);
const METRIC_NAMES = Object.freeze([
  'Daily Average Tabungan', 'Posisi Saldo Tabungan', 'Daily Average Giro Retail', 'Daily Average DPK Retail',
  'New Account Payroll', 'Jumlah Merchant EDC Produktif', 'Jumlah Merchant QRIS Produktif',
  'Daily Average CASA EDC Merchant', 'Sales Volume Merchant EDC', 'Sales Volume Merchant QRIS',
  'Jumlah User Aktif BRImo', 'User Aktif QLOLA', 'Product Holding',
]);
export const APPRAISAL_EXPECTED_HEADERS = Object.freeze([
  ...PROFILE_FIELDS,
  ...METRIC_NAMES.flatMap((name) => [`Target ${name}`, name, `% Realisasi ${name}`, `Score ${name}`]),
  'Score', 'Tier',
]);

const SOURCE_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ALLOWED_TYPES = new Set(['RO', 'KP']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export class AppraisalSourceError extends Error {
  constructor(message, { status = null, applicationError = null, retryable = false } = {}) {
    super(message);
    this.name = 'AppraisalSourceError';
    this.status = status;
    this.applicationError = applicationError;
    this.retryable = retryable;
  }
}

function safeApplicationError(payload) {
  const value = payload?.error;
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

async function requestJson(url, fetchImpl, { retries = 2, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } }); }
    catch {
      lastError = new AppraisalSourceError('Koneksi ke endpoint Appraisal lokal gagal.', { retryable: true });
      if (attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
      throw lastError;
    }
    let payload;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (response.ok) {
      if (!isRecord(payload)) throw new AppraisalSourceError('Respons endpoint Appraisal bukan objek JSON.', { status: response.status });
      return payload;
    }
    const applicationError = safeApplicationError(payload);
    const status = Number(response.status) || null;
    const retryable = status === 429 || (status !== null && status >= 500 && applicationError !== 'source_schema_mismatch');
    lastError = new AppraisalSourceError(
      `Endpoint Appraisal mengembalikan HTTP ${status ?? 'unknown'}${applicationError ? ` (${applicationError})` : ''}.`,
      { status, applicationError, retryable },
    );
    if (!retryable || attempt === retries) throw lastError;
    const retryAfterHeader = response.headers?.get?.('retry-after');
    const seconds = Number(retryAfterHeader);
    await sleep(Number.isFinite(seconds) && seconds >= 0 ? Math.min(10_000, seconds * 1000) : 250 * (attempt + 1));
  }
  throw lastError ?? new AppraisalSourceError('Endpoint Appraisal tidak dapat dibaca.');
}

function normalizeSource(source) {
  if (!isRecord(source) || typeof source.period !== 'string' || !SOURCE_PERIOD_PATTERN.test(source.period)
    || !ALLOWED_TYPES.has(source.type) || typeof source.sheetName !== 'string' || !source.sheetName.trim()) {
    throw new AppraisalSourceError('Daftar sumber berisi pasangan periode/tipe yang tidak valid.');
  }
  return {
    period: source.period,
    periodDate: `${source.period}-01`,
    type: source.type,
    sheetName: source.sheetName,
    rowCount: Number.isSafeInteger(source.rowCount) && source.rowCount >= 0 ? source.rowCount : null,
    objectKey: `appraisal/${source.period}/${source.type}`,
  };
}

function asCodeText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function validateRecord(record, source, knownOfficeTypes, seenSourceRows) {
  const errors = [];
  if (!isRecord(record)) return { errors: ['record_not_object'], staged: null };
  const missing = APPRAISAL_EXPECTED_HEADERS.filter((header) => !Object.hasOwn(record, header));
  if (missing.length) errors.push('record_contract_mismatch');
  const sourceRowNumber = Number(record.sourceRow);
  if (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1) errors.push('invalid_source_row_number');
  const duplicateSourceRow = Number.isSafeInteger(sourceRowNumber) && seenSourceRows.has(sourceRowNumber);
  if (duplicateSourceRow) errors.push('duplicate_source_row_number');
  else if (Number.isSafeInteger(sourceRowNumber) && sourceRowNumber > 0) seenSourceRows.add(sourceRowNumber);

  const pn = asCodeText(record.PN);
  const kcCode = asCodeText(record['Kode KC']);
  const officeType = kcCode ? knownOfficeTypes.get(kcCode) : null;
  const officeMapping = officeType === 'KC' ? 'matched' : 'unresolved';
  const staged = Number.isSafeInteger(sourceRowNumber) && sourceRowNumber > 0 && !duplicateSourceRow ? {
    sourceType: source.type,
    sourceSheet: source.sheetName,
    sourcePeriod: source.periodDate,
    sourceRowNumber,
    headerFingerprint: null,
    schemaStatus: missing.length ? 'invalid' : 'valid',
    rawRecord: JSON.stringify(record),
    pnText: pn,
    officeMapping,
    rawValues: record,
  } : null;
  return {
    errors,
    missingHeaders: missing,
    staged,
  };
}

export async function fetchAppraisalSnapshot({ baseUrl = 'http://127.0.0.1:8787', fetchImpl = fetch, knownOfficeTypes = new Map(), sleep } = {}) {
  const normalizedBase = String(baseUrl).replace(/\/$/, '');
  const request = (url) => requestJson(url, fetchImpl, { ...(sleep ? { sleep } : {}) });
  const sourcesPayload = await request(`${normalizedBase}/api/appraisal/sources`);
  if (!Array.isArray(sourcesPayload.sources)) throw new AppraisalSourceError('Respons daftar sumber Appraisal tidak memiliki daftar sumber.');
  const sources = sourcesPayload.sources.map(normalizeSource);
  const pairKeys = new Set();
  for (const source of sources) {
    const key = `${source.period}|${source.type}`;
    if (pairKeys.has(key)) throw new AppraisalSourceError('Daftar sumber memiliki pasangan periode/tipe ganda.');
    pairKeys.add(key);
  }
  if (!sources.length) throw new AppraisalSourceError('Tidak ada sumber periode/tipe Appraisal yang dapat diimpor.');
  sources.sort((a, b) => a.period.localeCompare(b.period) || a.type.localeCompare(b.type));

  const errors = [];
  const sheets = [];
  const valueTypes = { null: 0, string: 0, number: 0, boolean: 0, other: 0 };
  let totalRows = 0;
  for (const source of sources) {
    const records = [];
    let offset = 0;
    let expectedRecordCount = null;
    let sourceRange = null;
    const seenSourceRows = new Set();
    do {
      const query = new URLSearchParams({ period: source.period, type: source.type, limit: String(APPRAISAL_PAGE_SIZE), offset: String(offset) });
      const payload = await request(`${normalizedBase}/api/appraisal/data?${query.toString()}`);
      if (!isRecord(payload.pagination) || !Array.isArray(payload.records) || !Number.isSafeInteger(payload.recordCount)
        || !Number.isSafeInteger(payload.pagination.returned) || payload.pagination.offset !== offset
        || payload.pagination.returned !== payload.records.length) {
        throw new AppraisalSourceError(`Kontrak pagination untuk periode ${source.period} tipe ${source.type} tidak valid.`);
      }
      if (expectedRecordCount === null) expectedRecordCount = payload.recordCount;
      else if (expectedRecordCount !== payload.recordCount) throw new AppraisalSourceError(`Jumlah record sumber berubah saat pagination periode ${source.period} tipe ${source.type}.`);
      if (!isRecord(payload.source) || payload.source.period !== source.period || payload.source.type !== source.type
        || payload.source.sheetName !== source.sheetName) throw new AppraisalSourceError(`Identitas sumber berubah saat pagination periode ${source.period} tipe ${source.type}.`);
      if (typeof payload.source.range === 'string') {
        if (sourceRange !== null && sourceRange !== payload.source.range) throw new AppraisalSourceError(`Range sumber berubah saat pagination periode ${source.period} tipe ${source.type}.`);
        sourceRange = payload.source.range;
      }
      for (const record of payload.records) {
        const checked = validateRecord(record, source, knownOfficeTypes, seenSourceRows);
        if (checked.errors.length) {
          errors.push({ period: source.period, type: source.type, sourceRowNumber: record?.sourceRow ?? null, codes: checked.errors, missingHeaders: checked.missingHeaders ?? [] });
        }
        const staged = checked.staged;
        if (!staged) continue;
        for (const value of Object.values(staged.rawValues)) {
          const type = value === null ? 'null' : typeof value;
          valueTypes[valueTypes[type] === undefined ? 'other' : type] += 1;
        }
        records.push(staged);
      }
      if (payload.pagination.returned === 0 && offset < expectedRecordCount) throw new AppraisalSourceError(`Pagination berhenti sebelum seluruh record periode ${source.period} tipe ${source.type} diterima.`);
      offset += payload.pagination.returned;
      if (offset > expectedRecordCount) throw new AppraisalSourceError(`Pagination melewati jumlah record periode ${source.period} tipe ${source.type}.`);
    } while (offset < (expectedRecordCount ?? 0));
    if (records.length !== expectedRecordCount) errors.push({ period: source.period, type: source.type, sourceRowNumber: null, codes: ['record_count_mismatch'], missingHeaders: [] });
    totalRows += expectedRecordCount ?? records.length;
    sheets.push({ ...source, sourceRange, rows: records, sourceRowCount: records.length, recordCount: expectedRecordCount ?? 0 });
  }

  const summaryContent = sheets.map(({ period, type, sheetName, sourceRange, rows }) => ({ period, type, sheetName, sourceRange, rows: rows.map((row) => row.rawValues) }));
  const checksum = sha256(JSON.stringify(summaryContent));
  const objects = sheets.map((sheet) => ({
    objectKey: sheet.objectKey,
    objectName: sheet.sheetName,
    objectType: 'google_sheet_snapshot',
    sourceChecksum: sha256(JSON.stringify({ sourceRange: sheet.sourceRange, rows: sheet.rows.map((row) => row.rawValues) })),
    sourceRowCount: sheet.sourceRowCount,
    sourcePeriod: sheet.period,
    sourceType: sheet.type,
    sourceSheet: sheet.sheetName,
    sourceRange: sheet.sourceRange,
    rows: sheet.rows,
  }));
  return {
    checksum,
    sourceSizeBytes: null,
    totalRows,
    sheets,
    objects,
    metadata: { sourceCount: sources.length, sources: sources.map(({ period, type, rowCount }) => ({ period, type, rowCount })), headerFingerprint: null, headerValidation: 'API berhasil melewati pemeriksaan header backend; header aktual tidak dikembalikan oleh endpoint.' },
    valueTypes,
    officeMapping: {
      matched: sheets.flatMap((sheet) => sheet.rows).filter((row) => row.officeMapping === 'matched').length,
      unresolved: sheets.flatMap((sheet) => sheet.rows).filter((row) => row.officeMapping === 'unresolved').length,
    },
    errors,
  };
}

export async function executeAppraisalStage(snapshot, repository, {
  parserVersion = APPRAISAL_PARSER_VERSION,
  sourceKey = APPRAISAL_SOURCE_KEY,
  sourceSystem = APPRAISAL_SOURCE_SYSTEM,
  registryType = 'google_sheets',
  displayName = 'Appraisal Google Sheets (staging)',
  sourceLocation = 'Google Sheets API via local appraisal endpoint',
} = {}) {
  if (!snapshot || !Array.isArray(snapshot.objects) || !snapshot.objects.length || !snapshot.totalRows) {
    const error = new Error('Snapshot Appraisal tidak valid atau tidak memiliki baris.');
    error.name = 'AppraisalSourceValidationError'; error.validationErrors = snapshot?.errors ?? []; throw error;
  }
  return repository.withSourceLock(sourceKey, async () => {
    const batch = await repository.reserveBatch({
      sourceKey, sourceSystem, registryType, displayName, sourceLocation,
      parserVersion, checksum: snapshot.checksum, sourceSizeBytes: snapshot.sourceSizeBytes,
      sourceRowCount: snapshot.totalRows, validationSummary: {
        sourceCount: snapshot.metadata.sourceCount, sources: snapshot.metadata.sources,
        officeMapping: snapshot.officeMapping, valueTypes: snapshot.valueTypes,
        validationErrors: snapshot.errors.length, publication: 'none', facts: 'not written',
      }, objects: snapshot.objects,
    });
    if (batch.alreadyStaged) return { status: 'already_staged', batchId: batch.batchId, rows: snapshot.totalRows };
    try { return await repository.stageSnapshot({ batch, snapshot }); }
    catch (error) { try { await repository.markFailed(batch.batchId); } catch { /* previous published data is not touched */ } throw error; }
  });
}
