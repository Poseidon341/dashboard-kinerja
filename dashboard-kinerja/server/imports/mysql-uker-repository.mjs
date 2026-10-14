import { randomUUID } from 'node:crypto';

const EXPECTED_TARGET = Object.freeze({ host: '127.0.0.1', port: 3308 });
export const ALLOWED_IMPORT_DATABASES = Object.freeze(['dashboard_funding', 'dashboard_funding_test']);
const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['issue_id', 'batch_id', 'issue_code', 'source_row_number', 'field_name'],
  dashboard_stg_office_row: ['batch_id', 'object_id', 'source_row_number', 'raw_record', 'source_code_text', 'source_name', 'source_type', 'source_main_branch_code', 'source_area', 'source_class', 'source_rural_urban', 'parse_status', 'mapping_status'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_dim_office_version: ['office_id', 'office_type', 'office_name', 'area_name', 'branch_class', 'rural_urban', 'observed_at', 'valid_from', 'valid_to', 'source_object_id'],
  dashboard_office_relationship: ['child_office_id', 'parent_office_id', 'relationship_type', 'observed_at', 'valid_from', 'valid_to', 'verification_status', 'evidence_text', 'source_object_id'],
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id', 'publication_version', 'published_at'],
  dashboard_domain_publication_history: ['domain_key', 'scope_key', 'previous_batch_id', 'new_batch_id', 'publication_version', 'action'],
});
const REQUIRED_COLUMN_TYPES = Object.freeze({
  'dashboard_stg_office_row.source_code_text': 'varchar(64)',
  'dashboard_stg_office_row.raw_record': 'longtext',
  'dashboard_stg_office_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_office_row.parse_status': 'varchar(24)',
  'dashboard_stg_office_row.mapping_status': 'varchar(24)',
  'dashboard_dim_office.source_system': 'varchar(50)',
  'dashboard_dim_office.source_code': 'varchar(32)',
  'dashboard_dim_office_version.office_type': 'varchar(32)',
  'dashboard_dim_office_version.office_name': 'varchar(255)',
  'dashboard_dim_office_version.observed_at': 'datetime(3)',
  'dashboard_dim_office_version.valid_from': 'date',
  'dashboard_dim_office_version.valid_to': 'date',
  'dashboard_office_relationship.relationship_type': 'varchar(32)',
  'dashboard_office_relationship.verification_status': 'varchar(24)',
  'dashboard_office_relationship.observed_at': 'datetime(3)',
});

export function assertExpectedImportTarget(config) {
  if (config.host !== EXPECTED_TARGET.host || config.port !== EXPECTED_TARGET.port || !ALLOWED_IMPORT_DATABASES.includes(config.database)) {
    const error = new Error('Target impor tidak sesuai konfigurasi yang diizinkan.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}

function buildValues(rows, columns) {
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
  return { placeholders, values: rows.flatMap((row) => columns.map((column) => row[column])) };
}

export class MysqlUkerRepository {
  constructor(pool, config) {
    assertExpectedImportTarget(config);
    this.pool = pool;
    this.database = config.database;
    this.connection = null;
  }

  async withSourceLock(sourceKey, callback) {
    const connection = await this.pool.getConnection();
    this.connection = connection;
    let acquired = false;
    try {
      const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
      if (databaseRows[0]?.database_name !== this.database) {
        throw new Error('Database aktif tidak sesuai target impor yang diizinkan.');
      }
      const lockName = `dashboard_import:${sourceKey}`;
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
      acquired = Number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new Error('Tidak berhasil memperoleh lock impor master unit kerja.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (acquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* connection release also drops the lock */ }
      }
      this.connection = null;
      connection.release();
    }
  }

  async verifySchema() {
    const names = Object.keys(REQUIRED_COLUMNS);
    const placeholders = names.map(() => '?').join(', ');
    const [rows] = await this.connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
      names,
    );
    const columnsByTable = new Map();
    const typesByColumn = new Map();
    for (const row of rows) {
      if (!columnsByTable.has(row.TABLE_NAME)) columnsByTable.set(row.TABLE_NAME, new Set());
      columnsByTable.get(row.TABLE_NAME).add(row.COLUMN_NAME);
      typesByColumn.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE).toLowerCase());
    }
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = columnsByTable.get(table) ?? new Set();
      for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`Skema impor master unit kerja tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(REQUIRED_COLUMN_TYPES)
      .filter(([column, expectedType]) => typesByColumn.get(column) !== expectedType)
      .map(([column]) => column);
    if (wrongTypes.length) throw new Error(`Tipe kolom impor master unit kerja tidak sesuai: ${wrongTypes.join(', ')}.`);

    const [indexes] = await this.connection.execute(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('dashboard_source_registry','dashboard_import_object_identity','dashboard_import_idempotency',
         'dashboard_stg_office_row','dashboard_dim_office','dashboard_dim_office_version','dashboard_office_relationship')
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );
    const uniqueKeys = new Map();
    for (const row of indexes) {
      if (Number(row.NON_UNIQUE) !== 0) continue;
      const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
      if (!uniqueKeys.has(key)) uniqueKeys.set(key, []);
      uniqueKeys.get(key).push(row.COLUMN_NAME);
    }
    const expected = [
      ['dashboard_source_registry.uq_dashboard_source_registry_source_key', ['source_key']],
      ['dashboard_import_object_identity.uq_object_identity_batch_key', ['batch_id', 'object_key']],
      ['dashboard_import_idempotency.uq_import_content_parser', ['source_id', 'source_checksum', 'parser_version']],
      ['dashboard_stg_office_row.uq_stg_office_source_row', ['object_id', 'source_row_number']],
      ['dashboard_dim_office.uq_office_source_code', ['source_system', 'source_code']],
      ['dashboard_dim_office_version.uq_office_version_observation', ['office_id', 'observed_at']],
      ['dashboard_office_relationship.uq_office_relationship_snapshot', ['child_office_id', 'parent_office_id', 'relationship_type', 'observed_at']],
    ];
    const badKeys = expected.filter(([key, columns]) => JSON.stringify(uniqueKeys.get(key) ?? []) !== JSON.stringify(columns)).map(([key]) => key);
    if (badKeys.length) throw new Error(`Unique key impor master unit kerja tidak sesuai: ${badKeys.join(', ')}.`);

    const [foreignKeys] = await this.connection.execute(
      `SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       AND CONSTRAINT_NAME IN ('fk_stg_office_batch','fk_stg_office_object','fk_office_version_office',
         'fk_office_version_object','fk_office_relationship_child','fk_office_relationship_parent','fk_office_relationship_object',
         'fk_idempotency_source','fk_idempotency_batch','fk_publication_batch','fk_publication_history_new','fk_publication_history_previous')`,
    );
    const foundForeignKeys = new Set(foreignKeys.map((row) => row.CONSTRAINT_NAME));
    const requiredForeignKeys = [
      'fk_stg_office_batch', 'fk_stg_office_object', 'fk_office_version_office', 'fk_office_version_object',
      'fk_office_relationship_child', 'fk_office_relationship_parent', 'fk_office_relationship_object',
      'fk_idempotency_source', 'fk_idempotency_batch', 'fk_publication_batch',
      'fk_publication_history_new', 'fk_publication_history_previous',
    ];
    const missingForeignKeys = requiredForeignKeys.filter((key) => !foundForeignKeys.has(key));
    if (missingForeignKeys.length) throw new Error(`Foreign key impor master unit kerja tidak tersedia: ${missingForeignKeys.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, sourceSystem, objectKey, parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute(
        'SELECT source_id, source_type FROM dashboard_source_registry WHERE source_key = ? FOR UPDATE',
        [sourceKey],
      );
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [insertSource] = await connection.execute(
          'INSERT INTO dashboard_source_registry (source_key, source_type, display_name, source_location) VALUES (?, ?, ?, ?)',
          [sourceKey, 'json_file', 'Master unit kerja', 'data/source-archive/uker_list.json'],
        );
        sourceId = insertSource.insertId;
      } else if (sourceRows[0].source_type !== 'json_file') {
        throw new Error('Registry sumber unit kerja memiliki source_type yang berbeda.');
      }

      const [idempotencyRows] = await connection.execute(
        `SELECT idempotency_id, batch_id FROM dashboard_import_idempotency
         WHERE source_id = ? AND source_checksum = ? AND parser_version = ? FOR UPDATE`,
        [sourceId, checksum, parserVersion],
      );
      let batchId = idempotencyRows[0]?.batch_id;
      let batchStatus;
      let observedAt;
      if (batchId) {
        const [batchRows] = await connection.execute(
          `SELECT status, source_checksum, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_import_batch WHERE batch_id = ? AND source_id = ? FOR UPDATE`,
          [batchId, sourceId],
        );
        if (!batchRows.length || batchRows[0].source_checksum !== checksum) {
          throw new Error('Record idempotensi tidak cocok dengan batch sumber.');
        }
        batchStatus = batchRows[0].status;
        observedAt = batchRows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(
          'INSERT INTO dashboard_import_batch (batch_id, source_id, status, source_checksum, rows_read, rows_staged, rows_rejected) VALUES (?, ?, ?, ?, 0, 0, 0)',
          [batchId, sourceId, 'loading', checksum],
        );
        const [snapshotTimes] = await connection.execute(
          `SELECT DATE_FORMAT(
             GREATEST(CURRENT_TIMESTAMP(3), COALESCE(DATE_ADD(MAX(observed_at), INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))),
             '%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_dim_office_version`,
        );
        observedAt = snapshotTimes[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan observed_at snapshot master kantor.');
        await connection.execute('UPDATE dashboard_import_batch SET started_at = ? WHERE batch_id = ?', [observedAt, batchId]);
        await connection.execute(
          'INSERT INTO dashboard_import_batch_detail (batch_id, parser_version, source_size_bytes, validation_summary) VALUES (?, ?, ?, ?)',
          [batchId, parserVersion, sourceSizeBytes, JSON.stringify(validationSummary)],
        );
        batchStatus = 'loading';
      }

      let objectId;
      const [identityRows] = await connection.execute(
        `SELECT oi.object_id, o.object_name, o.object_type, o.source_checksum, o.source_row_count
         FROM dashboard_import_object_identity oi
         JOIN dashboard_import_object o ON o.object_id = oi.object_id
         WHERE oi.batch_id = ? AND oi.object_key = ? FOR UPDATE`,
        [batchId, objectKey],
      );
      if (identityRows.length) {
        const existing = identityRows[0];
        if (existing.object_name !== objectKey || existing.object_type !== 'json_file' || existing.source_checksum !== checksum) {
          throw new Error('Object identity batch memiliki metadata sumber yang berbeda.');
        }
        objectId = existing.object_id;
        if (Number(existing.source_row_count) !== sourceRowCount) {
          await connection.execute('UPDATE dashboard_import_object SET source_row_count = ? WHERE object_id = ?', [sourceRowCount, objectId]);
        }
      } else {
        const [insertObject] = await connection.execute(
          'INSERT INTO dashboard_import_object (batch_id, object_name, object_type, source_checksum, source_row_count, metadata) VALUES (?, ?, ?, ?, ?, ?)',
          [batchId, objectKey, 'json_file', checksum, sourceRowCount, JSON.stringify({ sourceSystem })],
        );
        objectId = insertObject.insertId;
        await connection.execute(
          'INSERT INTO dashboard_import_object_identity (object_id, batch_id, object_key) VALUES (?, ?, ?)',
          [objectId, batchId, objectKey],
        );
      }

      if (!idempotencyRows.length) {
        await connection.execute(
          'INSERT INTO dashboard_import_idempotency (source_id, source_checksum, parser_version, batch_id) VALUES (?, ?, ?, ?)',
          [sourceId, checksum, parserVersion, batchId],
        );
      }

      let alreadyPublished = false;
      if (batchStatus === 'completed') {
        const [publishedRows] = await connection.execute(
          `SELECT publication_event_id FROM dashboard_domain_publication_history
           WHERE domain_key = ? AND scope_key = 'default' AND new_batch_id = ? AND action = 'publish' LIMIT 1`,
          ['office_master', batchId],
        );
        if (!publishedRows.length) throw new Error('Batch completed tidak memiliki catatan publikasi; perlu pemeriksaan manual.');
        alreadyPublished = true;
      } else {
        await connection.execute(
          'UPDATE dashboard_import_batch SET status = ?, finished_at = NULL WHERE batch_id = ?',
          ['loading', batchId],
        );
      }

      await connection.commit();
      return { batchId, objectId, observedAt, alreadyPublished };
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async publishSnapshot({ batch, snapshot, sourceSystem }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const staged = snapshot.rows.map((row) => ({
        batch_id: batch.batchId,
        object_id: batch.objectId,
        source_row_number: row.rowNumber,
        raw_record: row.rawRecord,
        source_code_text: row.code,
        source_name: row.sourceName,
        source_type: row.sourceType,
        source_main_branch_code: row.mainCode,
        source_area: row.sourceArea,
        source_class: row.sourceClass,
        source_rural_urban: row.sourceRuralUrban,
        parse_status: row.parseStatus,
        mapping_status: row.mappingStatus,
      }));
      const stagingColumns = [
        'batch_id', 'object_id', 'source_row_number', 'raw_record', 'source_code_text', 'source_name',
        'source_type', 'source_main_branch_code', 'source_area', 'source_class', 'source_rural_urban',
        'parse_status', 'mapping_status',
      ];
      const stagingValues = buildValues(staged, stagingColumns);
      await connection.execute(
        `INSERT INTO dashboard_stg_office_row (${stagingColumns.join(', ')}) VALUES ${stagingValues.placeholders}
         ON DUPLICATE KEY UPDATE raw_record = VALUES(raw_record), source_code_text = VALUES(source_code_text),
         source_name = VALUES(source_name), source_type = VALUES(source_type), source_main_branch_code = VALUES(source_main_branch_code),
         source_area = VALUES(source_area), source_class = VALUES(source_class), source_rural_urban = VALUES(source_rural_urban),
         parse_status = VALUES(parse_status), mapping_status = VALUES(mapping_status)`,
        stagingValues.values,
      );

      const officeRecords = snapshot.rows.map((row) => ({ source_system: sourceSystem, source_code: row.code }));
      const officeColumns = ['source_system', 'source_code'];
      const officeValues = buildValues(officeRecords, officeColumns);
      await connection.execute(
        `INSERT INTO dashboard_dim_office (${officeColumns.join(', ')}) VALUES ${officeValues.placeholders}
         ON DUPLICATE KEY UPDATE source_code = VALUES(source_code)`,
        officeValues.values,
      );
      const [officeRows] = await connection.execute(
        'SELECT office_id, source_code FROM dashboard_dim_office WHERE source_system = ?',
        [sourceSystem],
      );
      const officeIdByCode = new Map(officeRows.map((row) => [String(row.source_code), row.office_id]));
      if (snapshot.rows.some((row) => !officeIdByCode.has(row.code))) throw new Error('Tidak semua kode sumber mendapat office_id.');

      const versions = snapshot.rows.map((row) => ({
        office_id: officeIdByCode.get(row.code),
        office_type: row.sourceType,
        office_name: row.sourceName,
        area_name: row.sourceArea,
        branch_class: row.sourceClass,
        rural_urban: row.sourceRuralUrban,
        observed_at: batch.observedAt,
        valid_from: null,
        valid_to: null,
        source_object_id: batch.objectId,
      }));
      const versionColumns = ['office_id', 'office_type', 'office_name', 'area_name', 'branch_class', 'rural_urban', 'observed_at', 'valid_from', 'valid_to', 'source_object_id'];
      const versionValues = buildValues(versions, versionColumns);
      await connection.execute(
        `INSERT INTO dashboard_dim_office_version (${versionColumns.join(', ')}) VALUES ${versionValues.placeholders}
         ON DUPLICATE KEY UPDATE office_type = VALUES(office_type), office_name = VALUES(office_name), area_name = VALUES(area_name),
         branch_class = VALUES(branch_class), rural_urban = VALUES(rural_urban), valid_from = NULL, valid_to = NULL, source_object_id = VALUES(source_object_id)`,
        versionValues.values,
      );

      const relationRows = snapshot.relationships.map((relation) => ({
        child_office_id: officeIdByCode.get(relation.childCode),
        parent_office_id: officeIdByCode.get(relation.parentCode),
        relationship_type: 'main_branch',
        observed_at: batch.observedAt,
        verification_status: 'source_declared',
        evidence_text: `MAIN BRANCH CODE=${relation.parentCode}`,
        source_object_id: batch.objectId,
      }));
      const relationColumns = ['child_office_id', 'parent_office_id', 'relationship_type', 'observed_at', 'valid_from', 'valid_to', 'verification_status', 'evidence_text', 'source_object_id'];
      const relationValues = buildValues(relationRows.map((row) => ({ ...row, valid_from: null, valid_to: null })), relationColumns);
      await connection.execute(
        `INSERT INTO dashboard_office_relationship (${relationColumns.join(', ')}) VALUES ${relationValues.placeholders}
         ON DUPLICATE KEY UPDATE verification_status = VALUES(verification_status), evidence_text = VALUES(evidence_text), source_object_id = VALUES(source_object_id)`,
        relationValues.values,
      );

      const [stagingCounts] = await connection.execute(
        `SELECT COUNT(*) AS row_count,
         SUM(parse_status = 'valid') AS valid_count, SUM(mapping_status = 'resolved') AS resolved_count
         FROM dashboard_stg_office_row WHERE object_id = ?`,
        [batch.objectId],
      );
      if (Number(stagingCounts[0]?.row_count) !== snapshot.rows.length
        || Number(stagingCounts[0]?.valid_count) !== snapshot.rows.length
        || Number(stagingCounts[0]?.resolved_count) !== snapshot.rows.length) {
        throw new Error('Jumlah atau status staging master kantor tidak sesuai hasil validasi.');
      }
      const [versionCounts] = await connection.execute(
        `SELECT COUNT(*) AS row_count FROM dashboard_dim_office_version
         WHERE source_object_id = ? AND observed_at = ?`,
        [batch.objectId, batch.observedAt],
      );
      if (Number(versionCounts[0]?.row_count) !== snapshot.rows.length) throw new Error('Jumlah versi master kantor tidak sesuai snapshot.');
      const [relationshipCounts] = await connection.execute(
        `SELECT COUNT(*) AS row_count,
         SUM(child_office_id = parent_office_id) AS self_reference_count
         FROM dashboard_office_relationship WHERE source_object_id = ? AND observed_at = ?`,
        [batch.objectId, batch.observedAt],
      );
      if (Number(relationshipCounts[0]?.row_count) !== snapshot.relationships.length
        || Number(relationshipCounts[0]?.self_reference_count ?? 0) !== 0) {
        throw new Error('Jumlah relasi kantor tidak sesuai snapshot atau memuat self-reference.');
      }
      const [unsupportedParentRows] = await connection.execute(
        `SELECT COUNT(*) AS row_count FROM dashboard_office_relationship r
         JOIN dashboard_dim_office_version parent_version
           ON parent_version.office_id = r.parent_office_id
          AND parent_version.source_object_id = r.source_object_id
          AND parent_version.observed_at = r.observed_at
         WHERE r.source_object_id = ? AND r.observed_at = ? AND parent_version.office_type <> 'KC'`,
        [batch.objectId, batch.observedAt],
      );
      if (Number(unsupportedParentRows[0]?.row_count) !== 0) throw new Error('Relasi parent snapshot tidak sesuai tipe kantor yang dinyatakan sumber.');

      const [publicationRows] = await connection.execute(
        `SELECT batch_id, publication_version FROM dashboard_domain_publication
         WHERE domain_key = ? AND scope_key = 'default' FOR UPDATE`,
        ['office_master'],
      );
      const previousBatchId = publicationRows[0]?.batch_id ?? null;
      const publicationVersion = Number(publicationRows[0]?.publication_version ?? 0) + 1;
      await connection.execute(
        `INSERT INTO dashboard_domain_publication (domain_key, scope_key, batch_id, publication_version, published_at)
         VALUES (?, 'default', ?, ?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE batch_id = VALUES(batch_id), publication_version = VALUES(publication_version), published_at = VALUES(published_at)`,
        ['office_master', batch.batchId, publicationVersion],
      );
      await connection.execute(
        `INSERT INTO dashboard_domain_publication_history
         (domain_key, scope_key, previous_batch_id, new_batch_id, publication_version, action, reason)
         VALUES (?, 'default', ?, ?, ?, 'publish', ?)`,
        ['office_master', previousBatchId, batch.batchId, publicationVersion, 'Master unit kerja tervalidasi'],
      );
      await connection.execute(
        `UPDATE dashboard_import_batch SET status = 'completed', finished_at = CURRENT_TIMESTAMP(3),
         rows_read = ?, rows_staged = ?, rows_rejected = 0 WHERE batch_id = ?`,
        [snapshot.rows.length, snapshot.rows.length, batch.batchId],
      );
      await connection.execute(
        'UPDATE dashboard_import_batch_detail SET validation_summary = ? WHERE batch_id = ?',
        [JSON.stringify({ counts: snapshot.counts, relationshipRows: snapshot.relationships.length, errors: 0 }), batch.batchId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async markFailed(batchId) {
    if (!this.connection) return;
    await this.connection.beginTransaction();
    try {
      const [batchRows] = await this.connection.execute(
        'SELECT status FROM dashboard_import_batch WHERE batch_id = ? FOR UPDATE',
        [batchId],
      );
      if (!batchRows.length || batchRows[0].status === 'completed') {
        await this.connection.commit();
        return;
      }
      await this.connection.execute(
        `UPDATE dashboard_import_batch SET status = 'failed', finished_at = CURRENT_TIMESTAMP(3)
         WHERE batch_id = ? AND status <> 'completed'`,
        [batchId],
      );
      const [existingIssues] = await this.connection.execute(
        `SELECT issue_id FROM dashboard_import_issue
         WHERE batch_id = ? AND issue_code = 'OFFICE_IMPORT_FAILED' AND object_name = ? LIMIT 1 FOR UPDATE`,
        [batchId, 'uker_list.json'],
      );
      if (!existingIssues.length) {
        await this.connection.execute(
          `INSERT INTO dashboard_import_issue
           (batch_id, severity, issue_code, object_name, safe_message, context)
           VALUES (?, 'error', 'OFFICE_IMPORT_FAILED', ?, ?, ?)`,
          [batchId, 'uker_list.json', 'Impor master unit kerja gagal sebelum publikasi.', JSON.stringify({ phase: 'publish' })],
        );
      }
      await this.connection.commit();
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
