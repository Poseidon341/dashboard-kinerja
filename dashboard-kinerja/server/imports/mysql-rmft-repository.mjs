import { randomUUID } from 'node:crypto';
import { ALLOWED_IMPORT_DATABASES, assertExpectedImportTarget } from './mysql-uker-repository.mjs';
import { assertAssignmentSnapshotMatches, RMFT_MASTER_DOMAIN, RMFT_OBJECT_KEY, RMFT_SOURCE_KEY } from './rmft-importer.mjs';

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'finished_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'source_size_bytes', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count', 'metadata'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['issue_id', 'batch_id', 'issue_code', 'object_name', 'safe_message', 'context'],
  dashboard_stg_rmft_row: ['batch_id', 'object_id', 'source_row_number', 'raw_record', 'source_pn', 'source_name', 'source_jg', 'source_job_title', 'source_unit_code', 'parse_status', 'mapping_status'],
  dashboard_dim_rmft: ['rmft_id', 'source_system', 'pn', 'rmft_name', 'job_grade', 'job_title'],
  dashboard_dim_office: ['office_id', 'source_system', 'source_code'],
  dashboard_rmft_assignment: ['assignment_id', 'rmft_id', 'office_id', 'source_unit_code', 'mapping_status', 'observed_at', 'source_object_id'],
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id', 'publication_version', 'published_at'],
  dashboard_domain_publication_history: ['domain_key', 'scope_key', 'previous_batch_id', 'new_batch_id', 'publication_version', 'action'],
});
const REQUIRED_TYPES = Object.freeze({
  'dashboard_stg_rmft_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_rmft_row.raw_record': 'longtext',
  'dashboard_stg_rmft_row.source_pn': 'varchar(64)',
  'dashboard_stg_rmft_row.source_unit_code': 'varchar(64)',
  'dashboard_stg_rmft_row.parse_status': 'varchar(24)',
  'dashboard_stg_rmft_row.mapping_status': 'varchar(24)',
  'dashboard_dim_rmft.source_system': 'varchar(50)',
  'dashboard_dim_rmft.pn': 'varchar(32)',
  'dashboard_rmft_assignment.source_unit_code': 'varchar(32)',
  'dashboard_rmft_assignment.mapping_status': 'varchar(24)',
  'dashboard_rmft_assignment.observed_at': 'datetime(3)',
});

function valuesFor(rows, columns) {
  return {
    placeholders: rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', '),
    values: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

export class MysqlRmftRepository {
  constructor(pool, config) {
    assertExpectedImportTarget(config);
    if (!ALLOWED_IMPORT_DATABASES.includes(config.database)) throw new Error('Database impor RMFT tidak diizinkan.');
    this.pool = pool;
    this.database = config.database;
    this.connection = null;
  }

  async withSourceLock(sourceKey, callback) {
    const connection = await this.pool.getConnection();
    this.connection = connection;
    let acquired = false;
    try {
      const [dbRows] = await connection.execute('SELECT DATABASE() AS database_name');
      if (dbRows[0]?.database_name !== this.database) throw new Error('Database aktif tidak sesuai target impor RMFT yang diizinkan.');
      const lockName = `dashboard_import:${sourceKey}`;
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
      acquired = Number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new Error('Tidak berhasil memperoleh lock impor RMFT.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (acquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* releasing the connection also drops the lock */ }
      }
      this.connection = null;
      connection.release();
    }
  }

  async verifySchema() {
    const connection = this.connection;
    const tables = Object.keys(REQUIRED_COLUMNS);
    const placeholders = tables.map(() => '?').join(', ');
    const [columnRows] = await connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`, tables,
    );
    const columnsByTable = new Map();
    const types = new Map();
    for (const row of columnRows) {
      if (!columnsByTable.has(row.TABLE_NAME)) columnsByTable.set(row.TABLE_NAME, new Set());
      columnsByTable.get(row.TABLE_NAME).add(row.COLUMN_NAME);
      types.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE).toLowerCase());
    }
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) if (!columnsByTable.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`Skema impor RMFT tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(REQUIRED_TYPES).filter(([column, type]) => types.get(column) !== type).map(([column]) => column);
    if (wrongTypes.length) throw new Error(`Tipe kolom impor RMFT tidak sesuai: ${wrongTypes.join(', ')}.`);

    const [uniqueRows] = await connection.execute(
      `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND TABLE_NAME IN
       ('dashboard_source_registry','dashboard_import_object_identity','dashboard_import_idempotency',
        'dashboard_stg_rmft_row','dashboard_dim_rmft') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );
    const unique = new Map();
    for (const row of uniqueRows) {
      const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
      if (!unique.has(key)) unique.set(key, []);
      unique.get(key).push(row.COLUMN_NAME);
    }
    const expectedUnique = [
      ['dashboard_source_registry.uq_dashboard_source_registry_source_key', ['source_key']],
      ['dashboard_import_object_identity.uq_object_identity_batch_key', ['batch_id', 'object_key']],
      ['dashboard_import_idempotency.uq_import_content_parser', ['source_id', 'source_checksum', 'parser_version']],
      ['dashboard_stg_rmft_row.uq_stg_rmft_source_row', ['object_id', 'source_row_number']],
      ['dashboard_dim_rmft.uq_rmft_source_pn', ['source_system', 'pn']],
    ];
    const badUnique = expectedUnique.filter(([key, columns]) => JSON.stringify(unique.get(key) ?? []) !== JSON.stringify(columns)).map(([key]) => key);
    if (badUnique.length) throw new Error(`Unique key impor RMFT tidak sesuai: ${badUnique.join(', ')}.`);

    const [foreignRows] = await connection.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE()
       AND REFERENCED_TABLE_NAME IS NOT NULL AND CONSTRAINT_NAME IN
       ('fk_stg_rmft_batch','fk_stg_rmft_object','fk_rmft_assignment_rmft','fk_rmft_assignment_office',
        'fk_rmft_assignment_object','fk_idempotency_source','fk_idempotency_batch','fk_publication_batch',
        'fk_publication_history_new','fk_publication_history_previous')`,
    );
    const found = new Set(foreignRows.map((row) => row.CONSTRAINT_NAME));
    const expectedForeign = [
      'fk_stg_rmft_batch', 'fk_stg_rmft_object', 'fk_rmft_assignment_rmft', 'fk_rmft_assignment_office',
      'fk_rmft_assignment_object', 'fk_idempotency_source', 'fk_idempotency_batch', 'fk_publication_batch',
      'fk_publication_history_new', 'fk_publication_history_previous',
    ];
    const missingForeign = expectedForeign.filter((key) => !found.has(key));
    if (missingForeign.length) throw new Error(`Foreign key impor RMFT tidak tersedia: ${missingForeign.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, sourceSystem, objectKey, parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor RMFT harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute('SELECT source_id, source_type FROM dashboard_source_registry WHERE source_key = ? FOR UPDATE', [sourceKey]);
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [insertSource] = await connection.execute(
          'INSERT INTO dashboard_source_registry (source_key, source_type, display_name, source_location) VALUES (?, ?, ?, ?)',
          [sourceKey, 'json_file', 'Master RMFT', 'data/source-archive/rmft_list.json'],
        );
        sourceId = insertSource.insertId;
      } else if (sourceRows[0].source_type !== 'json_file') throw new Error('Registry sumber RMFT memiliki source_type yang berbeda.');

      const [idempotencyRows] = await connection.execute(
        `SELECT idempotency_id, batch_id FROM dashboard_import_idempotency
         WHERE source_id = ? AND source_checksum = ? AND parser_version = ? FOR UPDATE`, [sourceId, checksum, parserVersion],
      );
      let batchId = idempotencyRows[0]?.batch_id;
      let batchStatus;
      let observedAt;
      if (batchId) {
        const [batchRows] = await connection.execute(
          `SELECT status, source_checksum, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_import_batch WHERE batch_id = ? AND source_id = ? FOR UPDATE`, [batchId, sourceId],
        );
        if (!batchRows.length || batchRows[0].source_checksum !== checksum) throw new Error('Idempotency RMFT tidak cocok dengan batch sumber.');
        batchStatus = batchRows[0].status;
        observedAt = batchRows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(
          'INSERT INTO dashboard_import_batch (batch_id, source_id, status, source_checksum, rows_read, rows_staged, rows_rejected) VALUES (?, ?, ?, ?, 0, 0, 0)',
          [batchId, sourceId, 'loading', checksum],
        );
        const [times] = await connection.execute(
          `SELECT DATE_FORMAT(GREATEST(CURRENT_TIMESTAMP(3),
             COALESCE(DATE_ADD(MAX(observed_at), INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))),
             '%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_rmft_assignment`,
        );
        observedAt = times[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan observed_at snapshot RMFT.');
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
         FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id = oi.object_id
         WHERE oi.batch_id = ? AND oi.object_key = ? FOR UPDATE`, [batchId, objectKey],
      );
      if (identityRows.length) {
        const existing = identityRows[0];
        if (existing.object_name !== objectKey || existing.object_type !== 'json_file' || existing.source_checksum !== checksum) throw new Error('Object identity RMFT memiliki metadata yang berbeda.');
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
        await connection.execute('INSERT INTO dashboard_import_object_identity (object_id, batch_id, object_key) VALUES (?, ?, ?)', [objectId, batchId, objectKey]);
      }
      if (!idempotencyRows.length) {
        await connection.execute('INSERT INTO dashboard_import_idempotency (source_id, source_checksum, parser_version, batch_id) VALUES (?, ?, ?, ?)', [sourceId, checksum, parserVersion, batchId]);
      }

      let alreadyPublished = false;
      if (batchStatus === 'completed') {
        const [publishedRows] = await connection.execute(
          `SELECT publication_event_id FROM dashboard_domain_publication_history
           WHERE domain_key = ? AND scope_key = 'default' AND new_batch_id = ? AND action = 'publish' LIMIT 1`, [RMFT_MASTER_DOMAIN, batchId],
        );
        if (!publishedRows.length) throw new Error('Batch RMFT completed tidak memiliki catatan publikasi.');
        alreadyPublished = true;
      } else {
        await connection.execute('UPDATE dashboard_import_batch SET status = ?, finished_at = NULL WHERE batch_id = ?', ['loading', batchId]);
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
    if (!connection) throw new Error('Impor RMFT harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const knownCodes = snapshot.knownOfficeCodes;
      const officeRowsByCode = new Map();
      for (let offset = 0; offset < knownCodes.length; offset += 400) {
        const part = knownCodes.slice(offset, offset + 400);
        if (!part.length) continue;
        const [rows] = await connection.execute(
          `SELECT office_id, source_code FROM dashboard_dim_office WHERE source_system = 'uker_list_json' AND source_code IN (${part.map(() => '?').join(',')})`, part,
        );
        for (const row of rows) officeRowsByCode.set(String(row.source_code), row.office_id);
      }
      const absentMasterCodes = knownCodes.filter((code) => !officeRowsByCode.has(code));
      if (absentMasterCodes.length) throw new Error(`Master kantor sumber uker_list_json belum memuat semua kode yang diharapkan (${absentMasterCodes.length} kode).`);

      const rmftColumns = ['source_system', 'pn', 'rmft_name', 'job_grade', 'job_title'];
      const rmftValues = valuesFor(snapshot.rows.map((row) => ({
        source_system: sourceSystem, pn: row.pn, rmft_name: row.name, job_grade: row.grade, job_title: row.jobTitle,
      })), rmftColumns);
      await connection.execute(
        `INSERT INTO dashboard_dim_rmft (${rmftColumns.join(', ')}) VALUES ${rmftValues.placeholders}
         ON DUPLICATE KEY UPDATE rmft_name = VALUES(rmft_name), job_grade = VALUES(job_grade), job_title = VALUES(job_title)`, rmftValues.values,
      );
      const pnValues = snapshot.rows.map((row) => row.pn);
      const [dimRows] = await connection.execute(
        `SELECT rmft_id, pn FROM dashboard_dim_rmft WHERE source_system = ? AND pn IN (${pnValues.map(() => '?').join(',')})`,
        [sourceSystem, ...pnValues],
      );
      const rmftIdByPn = new Map(dimRows.map((row) => [String(row.pn), row.rmft_id]));
      if (snapshot.rows.some((row) => !rmftIdByPn.has(row.pn))) throw new Error('Tidak semua PN sumber mendapat rmft_id.');

      const assignments = snapshot.rows.map((row) => {
        const officeId = officeRowsByCode.get(row.unitCode) ?? null;
        const mappingStatus = officeId === null ? 'unresolved' : 'resolved';
        if (officeId !== null && !snapshot.knownOfficeCodes.includes(row.unitCode)) throw new Error('Kode kantor tidak dinyatakan oleh snapshot master kantor.');
        return {
          rmft_id: rmftIdByPn.get(row.pn), office_id: officeId, source_unit_code: row.unitCode,
          mapping_status: mappingStatus, observed_at: batch.observedAt, source_object_id: batch.objectId,
        };
      });

      const staged = snapshot.rows.map((row) => ({
        batch_id: batch.batchId, object_id: batch.objectId, source_row_number: row.rowNumber, raw_record: row.rawRecord,
        source_pn: row.pn, source_name: row.name, source_jg: row.grade, source_job_title: row.jobTitle,
        source_unit_code: row.unitCode, parse_status: row.parseStatus,
        mapping_status: officeRowsByCode.has(row.unitCode) ? 'resolved' : 'unresolved',
      }));
      const stageColumns = ['batch_id', 'object_id', 'source_row_number', 'raw_record', 'source_pn', 'source_name', 'source_jg', 'source_job_title', 'source_unit_code', 'parse_status', 'mapping_status'];
      const stageValues = valuesFor(staged, stageColumns);
      await connection.execute(
        `INSERT INTO dashboard_stg_rmft_row (${stageColumns.join(', ')}) VALUES ${stageValues.placeholders}
         ON DUPLICATE KEY UPDATE raw_record=VALUES(raw_record), source_pn=VALUES(source_pn), source_name=VALUES(source_name),
         source_jg=VALUES(source_jg), source_job_title=VALUES(source_job_title), source_unit_code=VALUES(source_unit_code),
         parse_status=VALUES(parse_status), mapping_status=VALUES(mapping_status)`, stageValues.values,
      );

      // The DDL has no assignment unique key. Serialize by source lock and verify existing rows before reusing them.
      const [existingAssignments] = await connection.execute(
        `SELECT assignment_id, rmft_id, office_id, source_unit_code, mapping_status
         FROM dashboard_rmft_assignment WHERE source_object_id = ? AND observed_at = ? FOR UPDATE`, [batch.objectId, batch.observedAt],
      );
      if (existingAssignments.length) {
        assertAssignmentSnapshotMatches(assignments, existingAssignments);
      } else {
        const assignmentColumns = ['rmft_id', 'office_id', 'source_unit_code', 'mapping_status', 'valid_from', 'valid_to', 'observed_at', 'source_object_id'];
        const assignmentValues = valuesFor(assignments.map((row) => ({ ...row, valid_from: null, valid_to: null })), assignmentColumns);
        await connection.execute(`INSERT INTO dashboard_rmft_assignment (${assignmentColumns.join(', ')}) VALUES ${assignmentValues.placeholders}`, assignmentValues.values);
      }

      const [stageCounts] = await connection.execute(
        `SELECT COUNT(*) AS total, SUM(parse_status='valid') AS valid_rows,
         SUM(mapping_status='resolved') AS resolved_rows, SUM(mapping_status='unresolved') AS unresolved_rows
         FROM dashboard_stg_rmft_row WHERE object_id = ?`, [batch.objectId],
      );
      if (Number(stageCounts[0]?.total) !== snapshot.rows.length || Number(stageCounts[0]?.valid_rows) !== snapshot.rows.length
        || Number(stageCounts[0]?.unresolved_rows) !== assignments.filter((row) => row.office_id === null).length
        || Number(stageCounts[0]?.resolved_rows) !== assignments.filter((row) => row.office_id !== null).length) {
        throw new Error('Jumlah atau status staging RMFT tidak sesuai hasil pemetaan.');
      }
      const [assignmentCounts] = await connection.execute(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT rmft_id) AS unique_people,
         SUM(office_id IS NULL AND mapping_status='unresolved') AS unresolved_rows
         FROM dashboard_rmft_assignment WHERE source_object_id = ? AND observed_at = ?`, [batch.objectId, batch.observedAt],
      );
      if (Number(assignmentCounts[0]?.total) !== assignments.length || Number(assignmentCounts[0]?.unique_people) !== assignments.length
        || Number(assignmentCounts[0]?.unresolved_rows) !== assignments.filter((row) => row.office_id === null).length) {
        throw new Error('Jumlah assignment RMFT tidak sesuai atau terdapat assignment ganda.');
      }

      const [publicationRows] = await connection.execute(
        `SELECT batch_id, publication_version FROM dashboard_domain_publication WHERE domain_key = ? AND scope_key = 'default' FOR UPDATE`, [RMFT_MASTER_DOMAIN],
      );
      const previousBatchId = publicationRows[0]?.batch_id ?? null;
      const publicationVersion = Number(publicationRows[0]?.publication_version ?? 0) + 1;
      await connection.execute(
        `INSERT INTO dashboard_domain_publication (domain_key, scope_key, batch_id, publication_version, published_at)
         VALUES (?, 'default', ?, ?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE batch_id=VALUES(batch_id), publication_version=VALUES(publication_version), published_at=VALUES(published_at)`,
        [RMFT_MASTER_DOMAIN, batch.batchId, publicationVersion],
      );
      await connection.execute(
        `INSERT INTO dashboard_domain_publication_history
         (domain_key, scope_key, previous_batch_id, new_batch_id, publication_version, action, reason)
         VALUES (?, 'default', ?, ?, ?, 'publish', ?)`,
        [RMFT_MASTER_DOMAIN, previousBatchId, batch.batchId, publicationVersion, 'Master RMFT tervalidasi'],
      );
      await connection.execute(
        `UPDATE dashboard_import_batch SET status='completed', finished_at=CURRENT_TIMESTAMP(3), rows_read=?, rows_staged=?, rows_rejected=0 WHERE batch_id=?`,
        [snapshot.rows.length, snapshot.rows.length, batch.batchId],
      );
      await connection.execute('UPDATE dashboard_import_batch_detail SET validation_summary=? WHERE batch_id=?', [JSON.stringify({ counts: snapshot.counts, errors: 0 }), batch.batchId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  async markFailed(batchId) {
    if (!this.connection) return;
    const connection = this.connection;
    await connection.beginTransaction();
    try {
      const [batchRows] = await connection.execute('SELECT status FROM dashboard_import_batch WHERE batch_id = ? FOR UPDATE', [batchId]);
      if (!batchRows.length || batchRows[0].status === 'completed') {
        await connection.commit();
        return;
      }
      await connection.execute("UPDATE dashboard_import_batch SET status='failed', finished_at=CURRENT_TIMESTAMP(3) WHERE batch_id=? AND status <> 'completed'", [batchId]);
      const [issues] = await connection.execute(
        `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='RMFT_IMPORT_FAILED' AND object_name=? LIMIT 1 FOR UPDATE`,
        [batchId, RMFT_OBJECT_KEY],
      );
      if (!issues.length) await connection.execute(
        `INSERT INTO dashboard_import_issue (batch_id, severity, issue_code, object_name, safe_message, context)
         VALUES (?, 'error', 'RMFT_IMPORT_FAILED', ?, ?, ?)`,
        [batchId, RMFT_OBJECT_KEY, 'Impor master RMFT gagal sebelum publikasi.', JSON.stringify({ phase: 'publish' })],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
}
