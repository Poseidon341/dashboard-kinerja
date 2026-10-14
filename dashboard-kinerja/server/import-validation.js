const DEFAULT_CHUNK_SIZE = 500;

function issue(sourceRow, code, field, message) {
  return { sourceRow, code, field: field ?? null, message };
}

/** Validate row shape without echoing source values, which may contain personal data. */
export function validateImportRow(row, sourceRow, { requiredFields = [], validators = {} } = {}) {
  const issues = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return [issue(sourceRow, 'row_not_object', null, 'Baris sumber bukan objek.')];
  }
  for (const field of requiredFields) {
    if (!(field in row) || row[field] === null || row[field] === undefined || (typeof row[field] === 'string' && row[field].trim() === '')) {
      issues.push(issue(sourceRow, 'required_value_missing', field, 'Kolom wajib kosong atau tidak tersedia.'));
    }
  }
  for (const [field, validator] of Object.entries(validators)) {
    if (!(field in row) || row[field] === null || row[field] === undefined || row[field] === '') continue;
    let valid = false;
    try { valid = validator(row[field], row) === true; } catch { valid = false; }
    if (!valid) issues.push(issue(sourceRow, 'invalid_value', field, 'Nilai tidak lolos validasi domain.'));
  }
  return issues;
}

/**
 * Process an async row stream in bounded chunks. The caller supplies a domain-specific
 * staging writer, so this utility does not flatten distinct domains into one table.
 * Source row numbers and duplicates are preserved; no deduplication is performed.
 */
export async function processImportStream({
  rows,
  validateRow,
  stageChunk,
  chunkSize = DEFAULT_CHUNK_SIZE,
  onIssues = async () => {},
}) {
  if (!rows?.[Symbol.asyncIterator]) throw new TypeError('rows harus berupa AsyncIterable.');
  if (typeof validateRow !== 'function' || typeof stageChunk !== 'function') {
    throw new TypeError('validateRow dan stageChunk wajib berupa fungsi.');
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10000) {
    throw new RangeError('chunkSize harus berupa integer antara 1 dan 10000.');
  }

  let sourceRow = 0;
  let rowsRead = 0;
  let rowsStaged = 0;
  let rowsRejected = 0;
  let chunk = [];
  let issueChunk = [];

  async function flush() {
    if (chunk.length) {
      await stageChunk(chunk);
      rowsStaged += chunk.length;
      chunk = [];
    }
    if (issueChunk.length) {
      await onIssues(issueChunk);
      issueChunk = [];
    }
  }

  for await (const row of rows) {
    sourceRow += 1;
    rowsRead += 1;
    const rowIssues = await validateRow(row, sourceRow);
    if (rowIssues.length) {
      rowsRejected += 1;
      issueChunk.push(...rowIssues);
    } else {
      chunk.push({ sourceRow, row });
    }
    if (chunk.length >= chunkSize || issueChunk.length >= chunkSize) await flush();
  }
  await flush();
  return { rowsRead, rowsStaged, rowsRejected };
}
