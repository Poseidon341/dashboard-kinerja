export const POSITION_FACT_EXPECTED = Object.freeze({
  rows: 1_039_742,
  resolved: 1_038_051,
  unresolved: 1_691,
  inconsistent: 0,
});

export function assertPositionFactTarget(config) {
  const host = String(config?.host ?? '').toLowerCase();
  if (!['127.0.0.1', 'localhost'].includes(host)
    || Number(config?.port) !== 3308
    || config?.database !== 'dashboard_funding_test') {
    const error = new Error('Builder fakta Posisi Dana hanya diizinkan pada MySQL lokal dashboard_funding_test port 3308.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}

export function factFromStaging(row) {
  const resolved = row.mapping_status === 'resolved' && row.office_id != null && row.office_version_id != null;
  const unresolved = row.mapping_status === 'unresolved' && row.office_id == null && row.office_version_id == null;
  if (!resolved && !unresolved) throw new Error('Mapping kantor staging tidak konsisten; candidate fact ditolak.');
  if (row.office_id != null && String(row.office_version_office_id) !== String(row.office_id)) {
    throw new Error('office_version_id tidak dimiliki office_id pada mapping snapshot.');
  }
  if (row.parse_status !== 'valid' || row.parsed_position_date == null) {
    throw new Error('Baris staging tidak valid untuk candidate fact.');
  }
  return {
    batch_id: String(row.batch_id),
    object_id: String(row.object_id),
    source_row_number: String(row.source_row_number),
    position_date: row.parsed_position_date,
    office_id: row.office_id == null ? null : String(row.office_id),
    segment_id: row.segment_id == null ? null : String(row.segment_id),
    product_id: row.product_id == null ? null : String(row.product_id),
    source_segment_label: row.source_segment,
    source_product_label: row.source_product,
    source_branch_label: row.source_branch_label,
    source_office_label: row.source_office_label,
    source_account_count_text: row.source_account_count_text,
    account_count: row.parsed_account_count == null ? null : String(row.parsed_account_count),
    source_balance_text: row.source_balance_text,
    balance: row.parsed_balance == null ? null : String(row.parsed_balance),
    amount_unit_code: null,
    parse_status: row.parse_status,
    mapping_status: row.mapping_status,
  };
}

export function compareFactRows(existing, expected) {
  const normalized = (field, value) => {
    if (value == null) return null;
    if (field === 'position_date' && value instanceof Date) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    if (field === 'balance') {
      const text = String(value);
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
    }
    return String(value);
  };
  const fields = [
    'batch_id', 'object_id', 'source_row_number', 'position_date', 'office_id', 'segment_id', 'product_id',
    'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label',
    'source_account_count_text', 'account_count', 'source_balance_text', 'balance', 'amount_unit_code',
    'parse_status', 'mapping_status',
  ];
  return fields.every((field) => {
    const left = normalized(field, existing[field]);
    const right = normalized(field, expected[field]);
    return left === right;
  });
}

export function planFactChunk(expectedRows, existingRows) {
  const existing = new Map(existingRows.map((row) => [`${row.object_id}:${row.source_row_number}`, row]));
  const missing = [];
  let validatedExisting = 0;
  for (const row of expectedRows) {
    const key = `${row.object_id}:${row.source_row_number}`;
    const current = existing.get(key);
    if (!current) missing.push(row);
    else {
      if (!compareFactRows(current, row)) throw new Error('Candidate fact existing tidak identik; chunk dibatalkan.');
      validatedExisting += 1;
    }
  }
  return { missing, validatedExisting };
}

export async function inFactChunkTransaction(connection, operation) {
  await connection.beginTransaction();
  try {
    const result = await operation();
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export function assertFactSnapshotCounts(actual, expected = POSITION_FACT_EXPECTED) {
  for (const [field, value] of Object.entries(expected)) {
    if (Number(actual?.[field] ?? 0) !== value) throw new Error(`Snapshot Posisi Dana tidak sesuai audit pada ${field}.`);
  }
  return true;
}

function unsignedBigInt(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${label} harus non-negatif.`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} harus berupa BIGINT presisi penuh.`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} tidak valid.`);
}

export async function* keysetPages(fetchPage, { chunkSize = 2000, initialCursor = '0' } = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Ukuran halaman keyset tidak valid.');
  let cursor = unsignedBigInt(initialCursor, 'Cursor keyset');
  while (true) {
    const rows = await fetchPage(cursor.toString(), chunkSize);
    if (!Array.isArray(rows)) throw new Error('Query keyset harus menghasilkan array baris.');
    if (rows.length === 0) return;
    let pageCursor = cursor;
    for (const row of rows) {
      const id = unsignedBigInt(row.stg_position_id, 'stg_position_id');
      if (id <= pageCursor) throw new Error('Cursor keyset tidak maju atau identitas staging berulang.');
      pageCursor = id;
    }
    cursor = pageCursor;
    yield rows;
  }
}

export function assertProgressWithinTotal(processed, totalRows) {
  if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(totalRows) || processed < 0 || processed > totalRows) {
    throw new Error('Progres baris tidak boleh melampaui jumlah staging yang diverifikasi.');
  }
  return processed;
}
