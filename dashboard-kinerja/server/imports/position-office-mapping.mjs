export const POSITION_MAPPING_EXPECTED = Object.freeze({
  rows: 1_039_742,
  uniqueLabels: 613,
  exactLabels: 611,
  exactRows: 1_038_051,
  unresolvedLabels: 2,
  unresolvedRows: 1_691,
  ambiguousLabels: 0,
  kanwilMalangRows: 131,
  unitAyniMagetanRows: 1_560,
});

export function assertPositionMappingTarget(config) {
  const host = String(config?.host ?? '').toLowerCase();
  const allowedHost = host === '127.0.0.1' || host === 'localhost';
  if (!allowedHost || Number(config?.port) !== 3308 || config?.database !== 'dashboard_funding_test') {
    const error = new Error('Backfill mapping Posisi Dana hanya diizinkan pada MySQL lokal dashboard_funding_test port 3308.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}

export function assertAuditMatches(actual, expected = POSITION_MAPPING_EXPECTED) {
  const fields = Object.keys(expected);
  const mismatches = fields.filter((field) => Number(actual?.[field] ?? 0) !== expected[field]);
  if (mismatches.length) {
    throw new Error(`Hasil audit mapping kantor berubah pada: ${mismatches.join(', ')}. Backfill dihentikan.`);
  }
  return true;
}

export function mappingRowsForInsert(rows) {
  return rows.map((row) => {
    const officeId = row.office_id == null ? null : String(row.office_id);
    const versionId = row.office_version_id == null ? null : String(row.office_version_id);
    if ((officeId === null) !== (versionId === null)) {
      throw new Error('office_id dan office_version_id harus sama-sama terisi atau sama-sama NULL.');
    }
    if (officeId !== null && row.mapping_status !== 'resolved') throw new Error('Mapping berkantor harus berstatus resolved.');
    if (officeId === null && row.mapping_status !== 'unresolved') throw new Error('Mapping tanpa kantor harus berstatus unresolved.');
    return {
      stg_position_id: String(row.stg_position_id),
      master_source_object_id: String(row.master_source_object_id),
      office_id: officeId,
      office_version_id: versionId,
      mapping_status: row.mapping_status,
    };
  });
}

export function resolveExactOfficeLabel(label, officeLookup) {
  if (label === null || label === undefined) return null;
  const candidates = officeLookup.get(String(label)) ?? [];
  if (candidates.length > 1) throw new Error('Label kantor cocok dengan lebih dari satu kode master.');
  return candidates[0] ?? null;
}

export function assertExistingMappingsMatch(expectedRows, existingRows) {
  const existing = new Map(existingRows.map((row) => [String(row.stg_position_id), row]));
  for (const expected of expectedRows) {
    const actual = existing.get(String(expected.stg_position_id));
    if (!actual) continue;
    if (String(actual.master_source_object_id) !== String(expected.master_source_object_id)
      || (actual.office_id == null ? null : String(actual.office_id)) !== expected.office_id
      || (actual.office_version_id == null ? null : String(actual.office_version_id)) !== expected.office_version_id
      || actual.mapping_status !== expected.mapping_status) {
      throw new Error('Mapping yang sudah ada berbeda dari hasil exact-match snapshot ini. Backfill dihentikan.');
    }
  }
  return expectedRows.filter((row) => !existing.has(String(row.stg_position_id)));
}

export async function inTransaction(connection, operation) {
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
