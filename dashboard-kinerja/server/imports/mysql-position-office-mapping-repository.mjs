import {
  assertAuditMatches,
  assertExistingMappingsMatch,
  inTransaction,
  mappingRowsForInsert,
  POSITION_MAPPING_EXPECTED,
  resolveExactOfficeLabel,
} from './position-office-mapping.mjs';

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'finished_at'],
  dashboard_source_registry: ['source_id', 'source_key'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_object: ['object_id', 'source_checksum', 'source_row_count'],
  dashboard_stg_position_row: ['stg_position_id', 'object_id', 'source_row_number', 'source_office_label', 'raw_record'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_dim_office_version: ['office_version_id', 'office_id', 'office_name', 'source_object_id', 'observed_at'],
  dashboard_stg_position_office_mapping: ['stg_position_id', 'master_source_object_id', 'office_id', 'office_version_id', 'mapping_status'],
});

const REQUIRED_FOREIGN_KEYS = [
  'fk_stg_position_office_mapping_position',
  'fk_stg_position_office_mapping_source',
  'fk_stg_position_office_mapping_office',
  'fk_stg_position_office_mapping_version',
];

function rowsAndValues(rows, columns) {
  return {
    placeholders: rows.map(() => `(${columns.map(() => '?').join(',')})`).join(','),
    values: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

export class MysqlPositionOfficeMappingRepository {
  constructor(pool, config, { chunkSize = 10000, onProgress = null } = {}) {
    if (config.database !== 'dashboard_funding_test' || !['127.0.0.1', 'localhost'].includes(String(config.host).toLowerCase()) || Number(config.port) !== 3308) {
      throw new Error('Target backfill mapping tidak diizinkan.');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10000) throw new Error('Ukuran chunk harus 1 sampai 10000.');
    this.pool = pool;
    this.config = config;
    this.chunkSize = chunkSize;
    this.onProgress = onProgress;
  }

  async run({ apply = false } = {}) {
    const connection = await this.pool.getConnection();
    let lockAcquired = false;
    try {
      const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
      if (databaseRows[0]?.database_name !== this.config.database) throw new Error('Database aktif tidak cocok dengan target backfill.');
      if (apply) {
        const [locks] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', ['position-office-mapping:segmen_data_json']);
        lockAcquired = Number(locks[0]?.acquired) === 1;
        if (!lockAcquired) throw new Error('Tidak berhasil memperoleh lock backfill mapping Posisi Dana.');
      }
      await this.verifySchema(connection);
      const snapshot = await this.readSnapshots(connection);
      const officeLookup = await this.readOfficeLookup(connection, snapshot);
      const audit = await this.auditCandidates(connection, snapshot, officeLookup);
      assertAuditMatches(audit);
      const currentMapping = await this.validateExistingMappings(connection, snapshot, officeLookup);
      let applyResult = null;
      if (apply) applyResult = await this.writeMappings(connection, snapshot, officeLookup, currentMapping);
      return { snapshot, audit, currentMapping, applyResult };
    } finally {
      if (lockAcquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', ['position-office-mapping:segmen_data_json']); } catch { /* released with connection */ }
      }
      connection.release();
    }
  }

  async verifySchema(connection) {
    const tableNames = Object.keys(REQUIRED_COLUMNS);
    const [columns] = await connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tableNames.map(() => '?').join(',')})`, tableNames,
    );
    const byTable = new Map();
    for (const row of columns) {
      if (!byTable.has(row.TABLE_NAME)) byTable.set(row.TABLE_NAME, new Set());
      byTable.get(row.TABLE_NAME).add(row.COLUMN_NAME);
    }
    const missing = [];
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of required) if (!byTable.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`Skema backfill tidak lengkap: ${missing.join(', ')}.`);

    const [keys] = await connection.execute(
      `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='dashboard_stg_position_office_mapping'`,
    );
    const present = new Set(keys.filter((row) => row.REFERENCED_TABLE_NAME).map((row) => row.CONSTRAINT_NAME));
    const absent = REQUIRED_FOREIGN_KEYS.filter((name) => !present.has(name));
    if (absent.length) throw new Error(`Foreign key tabel mapping tidak sesuai migration 003: ${absent.join(', ')}.`);
    const [indexes] = await connection.execute(
      `SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_stg_position_office_mapping' AND NON_UNIQUE=0
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    );
    const primary = indexes.filter((row) => row.INDEX_NAME === 'PRIMARY').map((row) => row.COLUMN_NAME);
    if (JSON.stringify(primary) !== JSON.stringify(['stg_position_id', 'master_source_object_id'])) {
      throw new Error('Primary key tabel mapping tidak sesuai migration 003.');
    }
  }

  async readSnapshots(connection) {
    const [masters] = await connection.execute(
      `SELECT p.batch_id, p.publication_version, b.status, s.source_key, oi.object_id,
              o.source_checksum, o.source_row_count
       FROM dashboard_domain_publication p
       JOIN dashboard_import_batch b ON b.batch_id=p.batch_id
       JOIN dashboard_source_registry s ON s.source_id=b.source_id
       JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='uker_list.json'
       JOIN dashboard_import_object o ON o.object_id=oi.object_id
       WHERE p.domain_key='office_master' AND p.scope_key='default'`,
    );
    if (masters.length !== 1) throw new Error('Publikasi master kantor aktif tidak tunggal atau tidak tersedia.');
    const master = masters[0];
    if (master.status !== 'completed' || master.source_key !== 'uker_list_json' || Number(master.source_row_count) !== 611) {
      throw new Error('Snapshot master kantor aktif bukan snapshot uker_list_json yang tervalidasi.');
    }
    const masterObjectId = String(master.object_id);
    const [officeVersions] = await connection.execute(
      `SELECT COUNT(*) AS version_count, COUNT(DISTINCT v.office_id) AS office_count,
              COUNT(DISTINCT v.observed_at) AS observed_count,
              SUM(o.office_id IS NULL) AS missing_office_count,
              COUNT(DISTINCT o.source_code) AS unique_code_count
       FROM dashboard_dim_office_version v
       LEFT JOIN dashboard_dim_office o ON o.office_id=v.office_id AND o.source_system='uker_list_json'
       WHERE v.source_object_id=?`, [masterObjectId],
    );
    const versionSummary = officeVersions[0] ?? {};
    if (Number(versionSummary.version_count) !== 611 || Number(versionSummary.office_count) !== 611
      || Number(versionSummary.observed_count) !== 1 || Number(versionSummary.missing_office_count ?? 0) !== 0
      || Number(versionSummary.unique_code_count) !== 611) {
      throw new Error('Versi kantor snapshot aktif tidak lengkap, tidak unik, atau tidak konsisten dengan sumber master.');
    }

    const [positions] = await connection.execute(
      `SELECT b.batch_id, b.status, s.source_key, oi.object_id, o.source_checksum, o.source_row_count
       FROM dashboard_source_registry s
       JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
       JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='segmen_data.json'
       JOIN dashboard_import_object o ON o.object_id=oi.object_id
       WHERE s.source_key='segmen_data_json'
       ORDER BY b.finished_at DESC, oi.object_id DESC LIMIT 1`,
    );
    if (positions.length !== 1) throw new Error('Snapshot staging Posisi Dana completed tidak ditemukan.');
    const position = positions[0];
    if (position.source_key !== 'segmen_data_json' || Number(position.source_row_count) !== POSITION_MAPPING_EXPECTED.rows) {
      throw new Error('Snapshot Posisi Dana tidak sesuai sumber yang diharapkan; backfill dihentikan.');
    }
    return {
      officeMaster: {
        batchId: String(master.batch_id),
        publicationVersion: String(master.publication_version),
        sourceObjectId: masterObjectId,
        checksum: master.source_checksum,
      },
      position: {
        batchId: String(position.batch_id),
        sourceObjectId: String(position.object_id),
        checksum: position.source_checksum,
        rowCount: Number(position.source_row_count),
      },
    };
  }

  async readOfficeLookup(connection, snapshot) {
    const [rows] = await connection.execute(
      `SELECT o.office_id, o.source_code, v.office_version_id, v.office_name
       FROM dashboard_dim_office_version v
       JOIN dashboard_dim_office o ON o.office_id=v.office_id
       WHERE v.source_object_id=? AND o.source_system='uker_list_json'
       ORDER BY o.source_code`, [snapshot.officeMaster.sourceObjectId],
    );
    if (rows.length !== 611) throw new Error('Snapshot master tidak memuat tepat 611 versi kantor untuk mapping.');
    const lookup = new Map();
    const codes = new Set();
    const officeIds = new Set();
    for (const row of rows) {
      const name = row.office_name == null ? null : String(row.office_name);
      if (name === null) throw new Error('Snapshot master memiliki nama kantor kosong; exact-match tidak aman.');
      const code = String(row.source_code);
      const officeId = String(row.office_id);
      const versionId = String(row.office_version_id);
      if (codes.has(code) || officeIds.has(officeId)) throw new Error('Kode atau kantor master berulang pada snapshot aktif.');
      codes.add(code);
      officeIds.add(officeId);
      const candidates = lookup.get(name) ?? [];
      candidates.push({ officeId, versionId, code });
      lookup.set(name, candidates);
    }
    if (codes.size !== 611 || officeIds.size !== 611) throw new Error('Kode master tidak unik pada snapshot aktif.');
    return lookup;
  }

  async *positionRows(connection, objectId, afterRowNumber = '0', missingOnly = false, masterObjectId = null) {
    let cursor = String(afterRowNumber);
    while (true) {
      const mappingJoin = missingOnly
        ? `LEFT JOIN dashboard_stg_position_office_mapping m
             ON m.stg_position_id=p.stg_position_id AND m.master_source_object_id=?`
        : '';
      const whereMissing = missingOnly ? 'AND m.stg_position_id IS NULL' : '';
      const params = missingOnly ? [masterObjectId, objectId, cursor] : [objectId, cursor];
      const [rows] = await connection.execute(
        `SELECT p.stg_position_id, p.source_row_number, p.source_office_label${missingOnly ? '' : ''}
         FROM dashboard_stg_position_row p ${mappingJoin}
         WHERE p.object_id=? AND p.source_row_number>? ${whereMissing}
         ORDER BY p.source_row_number LIMIT ${this.chunkSize}`,
        params,
      );
      if (!rows.length) return;
      cursor = String(rows.at(-1).source_row_number);
      yield rows;
    }
  }

  async auditCandidates(connection, snapshot, officeLookup) {
    const labelCounts = new Map();
    let totalRows = 0;
    for await (const rows of this.positionRows(connection, snapshot.position.sourceObjectId)) {
      for (const row of rows) {
        const label = row.source_office_label == null ? null : String(row.source_office_label);
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        totalRows += 1;
      }
      this.onProgress?.({ phase: 'audit-source-labels', processedRows: totalRows, distinctLabels: labelCounts.size });
    }
    let exactLabels = 0;
    let exactRows = 0;
    let unresolvedLabels = 0;
    let unresolvedRows = 0;
    let ambiguousLabels = 0;
    let kanwilMalangRows = 0;
    let unitAyniMagetanRows = 0;
    for (const [label, count] of labelCounts) {
      const matches = label === null ? [] : (officeLookup.get(label) ?? []);
      if (matches.length === 1) {
        exactLabels += 1;
        exactRows += count;
      } else if (matches.length > 1) ambiguousLabels += 1;
      else {
        unresolvedLabels += 1;
        unresolvedRows += count;
        if (label === 'KANWIL MALANG') kanwilMalangRows += count;
        if (label === 'UNIT A. YANI MAGETAN') unitAyniMagetanRows += count;
      }
    }
    return {
      rows: totalRows,
      uniqueLabels: labelCounts.size,
      exactLabels,
      exactRows,
      unresolvedLabels,
      unresolvedRows,
      ambiguousLabels,
      kanwilMalangRows,
      unitAyniMagetanRows,
    };
  }

  async validateExistingMappings(connection, snapshot, officeLookup) {
    let cursor = '0';
    let total = 0;
    let resolved = 0;
    let unresolved = 0;
    while (true) {
      const [rows] = await connection.execute(
        `SELECT p.stg_position_id, p.source_row_number, p.source_office_label,
                m.master_source_object_id, m.office_id, m.office_version_id, m.mapping_status
         FROM dashboard_stg_position_row p
         JOIN dashboard_stg_position_office_mapping m
           ON m.stg_position_id=p.stg_position_id AND m.master_source_object_id=?
         WHERE p.object_id=? AND p.source_row_number>?
         ORDER BY p.source_row_number LIMIT ${this.chunkSize}`,
        [snapshot.officeMaster.sourceObjectId, snapshot.position.sourceObjectId, cursor],
      );
      if (!rows.length) break;
      const expected = rows.map((row) => {
        const label = row.source_office_label == null ? null : String(row.source_office_label);
        const match = resolveExactOfficeLabel(label, officeLookup);
        return {
          stg_position_id: String(row.stg_position_id),
          master_source_object_id: snapshot.officeMaster.sourceObjectId,
          office_id: match?.officeId ?? null,
          office_version_id: match?.versionId ?? null,
          mapping_status: match ? 'resolved' : 'unresolved',
        };
      });
      assertExistingMappingsMatch(expected, rows);
      total += rows.length;
      resolved += expected.filter((row) => row.mapping_status === 'resolved').length;
      unresolved += expected.filter((row) => row.mapping_status === 'unresolved').length;
      cursor = String(rows.at(-1).source_row_number);
      this.onProgress?.({ phase: 'validate-existing', processedRows: total, existingResolved: resolved, existingUnresolved: unresolved });
    }
    return { total, resolved, unresolved };
  }

  async writeMappings(connection, snapshot, officeLookup, currentMapping) {
    let inserted = 0;
    let scannedUnmapped = 0;
    for await (const rows of this.positionRows(connection, snapshot.position.sourceObjectId, '0', true, snapshot.officeMaster.sourceObjectId)) {
      const expected = mappingRowsForInsert(rows.map((row) => {
        const label = row.source_office_label == null ? null : String(row.source_office_label);
        const match = resolveExactOfficeLabel(label, officeLookup);
        return {
          ...row,
          master_source_object_id: snapshot.officeMaster.sourceObjectId,
          office_id: match?.officeId ?? null,
          office_version_id: match?.versionId ?? null,
          mapping_status: match ? 'resolved' : 'unresolved',
        };
      }));
      const columns = ['stg_position_id', 'master_source_object_id', 'office_id', 'office_version_id', 'mapping_status'];
      const values = rowsAndValues(expected, columns);
      await inTransaction(connection, () => connection.execute(
        `INSERT INTO dashboard_stg_position_office_mapping (${columns.join(',')}) VALUES ${values.placeholders}`,
        values.values,
      ));
      inserted += expected.length;
      scannedUnmapped += rows.length;
      this.onProgress?.({ phase: 'backfill-missing', insertedRows: inserted, remainingRows: null });
    }
    const [finalCounts] = await connection.execute(
      `SELECT COUNT(*) AS total,
              SUM(m.mapping_status='resolved' AND m.office_id IS NOT NULL AND m.office_version_id IS NOT NULL) AS resolved_rows,
              SUM(m.mapping_status='unresolved' AND m.office_id IS NULL AND m.office_version_id IS NULL) AS unresolved_rows,
              SUM((m.office_id IS NULL)<>(m.office_version_id IS NULL)) AS inconsistent_rows
       FROM dashboard_stg_position_office_mapping m
       JOIN dashboard_stg_position_row p ON p.stg_position_id=m.stg_position_id
       WHERE p.object_id=? AND m.master_source_object_id=?`,
      [snapshot.position.sourceObjectId, snapshot.officeMaster.sourceObjectId],
    );
    const counts = finalCounts[0] ?? {};
    if (Number(counts.total) !== POSITION_MAPPING_EXPECTED.rows
      || Number(counts.resolved_rows) !== POSITION_MAPPING_EXPECTED.exactRows
      || Number(counts.unresolved_rows) !== POSITION_MAPPING_EXPECTED.unresolvedRows
      || Number(counts.inconsistent_rows ?? 0) !== 0) {
      throw new Error('Validasi akhir tabel mapping gagal; mapping tidak dipublikasikan. Periksa dan retry snapshot yang sama.');
    }
    const totalMappings = Number(counts.total ?? 0);
    if (currentMapping.total + scannedUnmapped !== totalMappings) throw new Error('Baris mapping yang divalidasi dan ditambahkan tidak sesuai total akhir.');
    return {
      visitedRows: snapshot.position.rowCount,
      insertedRows: inserted,
      existingRows: currentMapping.total,
      ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value ?? 0)])),
    };
  }
}
