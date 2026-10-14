import { randomUUID } from 'node:crypto';
import { assertExpectedImportTarget } from './mysql-uker-repository.mjs';

const TABLE_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type', 'display_name', 'source_location'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'finished_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'source_size_bytes', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count', 'metadata'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['batch_id', 'severity', 'issue_code', 'object_name', 'source_row_number', 'field_name', 'safe_message', 'context'],
  dashboard_stg_appraisal_row: ['batch_id', 'object_id', 'source_type', 'source_sheet', 'source_period', 'source_row_number', 'header_fingerprint', 'raw_record', 'schema_status'],
});
const COLUMN_TYPES = Object.freeze({
  'dashboard_source_registry.source_key': 'varchar(100)',
  'dashboard_import_batch.source_checksum': 'char(64)',
  'dashboard_import_batch_detail.parser_version': 'varchar(64)',
  'dashboard_import_object_identity.object_key': 'varchar(255)',
  'dashboard_import_idempotency.parser_version': 'varchar(64)',
  'dashboard_stg_appraisal_row.source_type': 'varchar(32)',
  'dashboard_stg_appraisal_row.source_sheet': 'varchar(255)',
  'dashboard_stg_appraisal_row.source_period': 'date',
  'dashboard_stg_appraisal_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_appraisal_row.header_fingerprint': 'char(64)',
  'dashboard_stg_appraisal_row.raw_record': 'longtext',
  'dashboard_stg_appraisal_row.schema_status': 'varchar(24)',
});
const FOREIGN_KEYS = Object.freeze([
  'fk_dashboard_import_batch_source', 'fk_batch_detail_batch', 'fk_dashboard_import_object_batch',
  'fk_object_identity_object', 'fk_object_identity_batch', 'fk_idempotency_source', 'fk_idempotency_batch',
  'fk_dashboard_import_issue_batch', 'fk_stg_appraisal_batch', 'fk_stg_appraisal_object',
]);

export function assertAppraisalTestTarget(config) {
  assertExpectedImportTarget(config);
  if (config.database !== 'dashboard_funding_test') {
    const error = new Error('Importer Appraisal tahap ini hanya diizinkan ke dashboard_funding_test.');
    error.name = 'ImportTargetMismatchError'; throw error;
  }
}

export function assertAppraisalDatabaseIdentity(actual, expectedDatabase = 'dashboard_funding_test') {
  if (actual?.database_name !== expectedDatabase || Number(actual?.mysql_port) !== 3308) {
    const error = new Error('Identitas koneksi MySQL aktual bukan database uji pada port yang diizinkan.');
    error.name = 'ImportTargetMismatchError'; throw error;
  }
}

function buildValues(rows, columns) {
  return { placeholders: rows.map(() => `(${columns.map(() => '?').join(',')})`).join(','), values: rows.flatMap((row) => columns.map((column) => row[column])) };
}

export class MysqlAppraisalRepository {
  constructor(pool, config) { assertAppraisalTestTarget(config); this.pool = pool; this.database = config.database; this.connection = null; }

  async withSourceLock(sourceKey, callback) {
    const connection = await this.pool.getConnection(); this.connection = connection; let locked = false;
    try {
      const [dbRows] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS mysql_port');
      assertAppraisalDatabaseIdentity(dbRows[0], this.database);
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?,15) AS acquired', [`dashboard_import:${sourceKey}`]);
      locked = Number(lockRows[0]?.acquired) === 1;
      if (!locked) throw new Error('Tidak berhasil memperoleh lock impor Appraisal.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (locked) { try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* connection close releases the lock */ } }
      this.connection = null; connection.release();
    }
  }

  async verifySchema() {
    const tables = Object.keys(TABLE_COLUMNS);
    const [columns] = await this.connection.execute(
      `SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables,
    );
    const names = new Map(); const types = new Map();
    for (const column of columns) { if (!names.has(column.TABLE_NAME)) names.set(column.TABLE_NAME, new Set()); names.get(column.TABLE_NAME).add(column.COLUMN_NAME); types.set(`${column.TABLE_NAME}.${column.COLUMN_NAME}`, String(column.COLUMN_TYPE).toLowerCase()); }
    const missing = [];
    for (const [table, required] of Object.entries(TABLE_COLUMNS)) for (const column of required) if (!names.get(table)?.has(column)) missing.push(`${table}.${column}`);
    if (missing.length) throw new Error(`Skema staging Appraisal tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(COLUMN_TYPES).filter(([key, expected]) => types.get(key) !== expected).map(([key]) => key);
    if (wrongTypes.length) throw new Error(`Tipe kolom staging Appraisal tidak sesuai DDL: ${wrongTypes.join(', ')}.`);

    const [indexRows] = await this.connection.execute(
      `SELECT TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND NON_UNIQUE=0
       AND TABLE_NAME IN ('dashboard_source_registry','dashboard_import_object_identity','dashboard_import_idempotency','dashboard_stg_appraisal_row') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
    );
    const indexMap = new Map();
    for (const row of indexRows) { const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`; if (!indexMap.has(key)) indexMap.set(key, []); indexMap.get(key).push(row.COLUMN_NAME); }
    const expectedIndexes = [
      ['dashboard_source_registry.uq_dashboard_source_registry_source_key', ['source_key']],
      ['dashboard_import_object_identity.uq_object_identity_batch_key', ['batch_id', 'object_key']],
      ['dashboard_import_idempotency.uq_import_content_parser', ['source_id', 'source_checksum', 'parser_version']],
      ['dashboard_stg_appraisal_row.uq_stg_appraisal_source_row', ['object_id', 'source_row_number']],
    ];
    const missingIndexes = expectedIndexes.filter(([key, expected]) => JSON.stringify(indexMap.get(key) ?? []) !== JSON.stringify(expected)).map(([key]) => key);
    if (missingIndexes.length) throw new Error(`Unique key staging Appraisal tidak sesuai DDL: ${missingIndexes.join(', ')}.`);

    const [foreignRows] = await this.connection.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       AND CONSTRAINT_NAME IN (${FOREIGN_KEYS.map(() => '?').join(',')})`, FOREIGN_KEYS,
    );
    const found = new Set(foreignRows.map((row) => row.CONSTRAINT_NAME));
    const missingForeign = FOREIGN_KEYS.filter((key) => !found.has(key));
    if (missingForeign.length) throw new Error(`Foreign key staging Appraisal tidak tersedia: ${missingForeign.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, sourceSystem, registryType = 'google_sheets', displayName = 'Appraisal Google Sheets (staging)', sourceLocation = 'Google Sheets API via local appraisal endpoint', parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary, objects }) {
    const connection = this.connection;
    if (!connection) throw new Error('Impor Appraisal harus berjalan di dalam source lock.');
    await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute('SELECT source_id,source_type FROM dashboard_source_registry WHERE source_key=? FOR UPDATE', [sourceKey]);
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [inserted] = await connection.execute(
          'INSERT INTO dashboard_source_registry (source_key,source_type,display_name,source_location) VALUES (?,?,?,?)',
          [sourceKey, registryType, displayName, sourceLocation],
        ); sourceId = inserted.insertId;
      } else if (sourceRows[0].source_type !== registryType) throw new Error('Registry sumber Appraisal memiliki source_type berbeda.');

      const [idemRows] = await connection.execute(
        'SELECT batch_id FROM dashboard_import_idempotency WHERE source_id=? AND source_checksum=? AND parser_version=? FOR UPDATE',
        [sourceId, checksum, parserVersion],
      );
      let batchId = idemRows[0]?.batch_id; let status; let observedAt;
      if (batchId) {
        const [batchRows] = await connection.execute(
          `SELECT status,source_checksum,DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_import_batch WHERE batch_id=? AND source_id=? FOR UPDATE`, [batchId, sourceId],
        );
        if (!batchRows.length || batchRows[0].source_checksum !== checksum) throw new Error('Batch idempotensi Appraisal tidak konsisten.');
        status = batchRows[0].status; observedAt = batchRows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(`INSERT INTO dashboard_import_batch (batch_id,source_id,status,source_checksum,rows_read,rows_staged,rows_rejected) VALUES (?,?,'loading',?,0,0,0)`, [batchId, sourceId, checksum]);
        const [timeRows] = await connection.execute(`SELECT DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_import_batch WHERE batch_id=?`, [batchId]);
        observedAt = timeRows[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan waktu batch Appraisal.');
        await connection.execute('INSERT INTO dashboard_import_batch_detail (batch_id,parser_version,source_size_bytes,validation_summary) VALUES (?,?,?,?)', [batchId, parserVersion, sourceSizeBytes, JSON.stringify(validationSummary)]);
        status = 'loading';
      }

      const objectIds = {};
      for (const object of objects) {
        const [existingRows] = await connection.execute(
          `SELECT oi.object_id,o.object_name,o.object_type,o.source_checksum,o.source_row_count FROM dashboard_import_object_identity oi
           JOIN dashboard_import_object o ON o.object_id=oi.object_id WHERE oi.batch_id=? AND oi.object_key=? FOR UPDATE`, [batchId, object.objectKey],
        );
        if (existingRows.length) {
          const current = existingRows[0];
          if (current.object_name !== object.objectName || current.object_type !== object.objectType || current.source_checksum !== object.sourceChecksum) throw new Error(`Identitas object Appraisal ${object.objectKey} tidak konsisten.`);
          objectIds[object.objectKey] = current.object_id;
          if (Number(current.source_row_count) !== object.sourceRowCount) await connection.execute('UPDATE dashboard_import_object SET source_row_count=?,metadata=? WHERE object_id=?', [object.sourceRowCount, JSON.stringify(object.metadata ?? { period: object.sourcePeriod, type: object.sourceType, sheetName: object.sourceSheet, sourceRange: object.sourceRange, valueRenderOption: 'UNFORMATTED_VALUE' }), current.object_id]);
        } else {
          const [insertObject] = await connection.execute(
            'INSERT INTO dashboard_import_object (batch_id,object_name,object_type,source_checksum,source_row_count,metadata) VALUES (?,?,?,?,?,?)',
            [batchId, object.objectName, object.objectType, object.sourceChecksum, object.sourceRowCount, JSON.stringify(object.metadata ?? { period: object.sourcePeriod, type: object.sourceType, sheetName: object.sourceSheet, sourceRange: object.sourceRange, valueRenderOption: 'UNFORMATTED_VALUE' })],
          );
          objectIds[object.objectKey] = insertObject.insertId;
          await connection.execute('INSERT INTO dashboard_import_object_identity (object_id,batch_id,object_key) VALUES (?,?,?)', [insertObject.insertId, batchId, object.objectKey]);
        }
      }
      if (!idemRows.length) await connection.execute('INSERT INTO dashboard_import_idempotency (source_id,source_checksum,parser_version,batch_id) VALUES (?,?,?,?)', [sourceId, checksum, parserVersion, batchId]);

      if (status === 'completed') {
        for (const object of objects) {
          const [countRows] = await connection.execute('SELECT COUNT(*) AS total FROM dashboard_stg_appraisal_row WHERE object_id=?', [objectIds[object.objectKey]]);
          if (Number(countRows[0]?.total) !== object.sourceRowCount) throw new Error(`Batch Appraisal selesai tetapi jumlah staging ${object.objectKey} tidak cocok.`);
        }
        await connection.commit(); return { batchId, objectIds, observedAt, alreadyStaged: true };
      }
      await connection.execute(`UPDATE dashboard_import_batch SET status='loading',finished_at=NULL,rows_read=0,rows_staged=0,rows_rejected=0 WHERE batch_id=?`, [batchId]);
      await connection.commit(); return { batchId, objectIds, observedAt, alreadyStaged: false };
    } catch (error) { await connection.rollback(); throw error; }
  }

  async stageSnapshot({ batch, snapshot }) {
    const connection = this.connection; await connection.beginTransaction();
    try {
      const rows = snapshot.objects.flatMap((object) => object.rows.map((row) => ({
        batch_id: batch.batchId, object_id: batch.objectIds[object.objectKey], source_type: row.sourceType,
        source_sheet: row.sourceSheet, source_period: row.sourcePeriod, source_row_number: row.sourceRowNumber,
        header_fingerprint: row.headerFingerprint, raw_record: row.rawRecord, schema_status: row.schemaStatus,
      })));
      const columns = ['batch_id','object_id','source_type','source_sheet','source_period','source_row_number','header_fingerprint','raw_record','schema_status'];
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100); const values = buildValues(chunk, columns);
        await connection.execute(
          `INSERT INTO dashboard_stg_appraisal_row (${columns.join(',')}) VALUES ${values.placeholders}
           ON DUPLICATE KEY UPDATE source_type=VALUES(source_type),source_sheet=VALUES(source_sheet),source_period=VALUES(source_period),header_fingerprint=VALUES(header_fingerprint),raw_record=VALUES(raw_record),schema_status=VALUES(schema_status)`, values.values,
        );
      }
      const unresolvedRows = snapshot.sheets.flatMap((sheet) => sheet.rows.filter((row) => row.officeMapping === 'unresolved').map((row) => ({ period: sheet.period, type: sheet.type, sourceRowNumber: row.sourceRowNumber })));
      const issues = [
        ...snapshot.errors.map((error) => ({ code: 'APPRAISAL_SOURCE_VALIDATION', period: error.period ?? null, type: error.type ?? null, row: error.sourceRowNumber, field: error.missingHeaders?.length ? 'headers' : 'source_row', context: { codes: error.codes, missingHeaderCount: error.missingHeaders?.length ?? 0 } })),
        ...unresolvedRows.map((row) => ({ code: 'APPRAISAL_KC_UNRESOLVED', period: row.period, type: row.type, row: row.sourceRowNumber, field: 'Kode KC', context: { period: row.period, type: row.type } })),
      ];
      for (const issue of issues) {
        const object = snapshot.objects.find((candidate) => candidate.sourcePeriod === issue.period && candidate.sourceType === issue.type);
        const objectName = object?.objectName ?? 'appraisal-google-sheets';
        const issueCode = issue.code;
        const [known] = await connection.execute(
          `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code=? AND object_name=? AND source_row_number <=> ? AND field_name <=> ? LIMIT 1 FOR UPDATE`,
          [batch.batchId, issueCode, objectName, issue.row ?? null, issue.field ?? null],
        );
        if (!known.length) await connection.execute(
          `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,source_row_number,field_name,safe_message,context)
           VALUES (?,'warning',?,?,?,?,?,?)`,
          [batch.batchId, issueCode, objectName, issue.row ?? null, issue.field ?? null,
            issueCode === 'APPRAISAL_KC_UNRESOLVED' ? 'Kode KC tidak cocok dengan master kantor KC; baris dipertahankan tanpa pemetaan.' : 'Validasi sumber Appraisal memerlukan pemeriksaan; baris mentah dipertahankan.',
            JSON.stringify(issue.context)],
        );
      }
      let staged = 0; let invalid = 0; const perObject = {};
      for (const object of snapshot.objects) {
        const objectId = batch.objectIds[object.objectKey];
        const [counts] = await connection.execute(`SELECT COUNT(*) AS total,SUM(schema_status='valid') AS valid_rows FROM dashboard_stg_appraisal_row WHERE object_id=?`, [objectId]);
        const total = Number(counts[0]?.total ?? 0); const valid = Number(counts[0]?.valid_rows ?? 0);
        perObject[object.objectKey] = total; staged += total; invalid += total - valid;
        if (total !== object.sourceRowCount) throw new Error(`Jumlah staging Appraisal untuk ${object.objectKey} tidak cocok.`);
      }
      const failed = snapshot.errors.length > 0 || invalid > 0 || staged !== snapshot.totalRows;
      await connection.execute(
        'UPDATE dashboard_import_batch SET status=?,finished_at=CURRENT_TIMESTAMP(3),rows_read=?,rows_staged=?,rows_rejected=? WHERE batch_id=?',
        [failed ? 'failed' : 'completed', snapshot.totalRows, staged, invalid + snapshot.errors.length, batch.batchId],
      );
      await connection.execute('UPDATE dashboard_import_batch_detail SET validation_summary=? WHERE batch_id=?', [JSON.stringify({ sourceCount: snapshot.metadata.sourceCount, sources: snapshot.metadata.sources, perObject, rowsRead: snapshot.totalRows, rowsStaged: staged, invalidRows: invalid, validationErrors: snapshot.errors.length, officeMapping: snapshot.officeMapping, headerFingerprint: null, headerValidation: snapshot.metadata.headerValidation, facts: 'not written', publication: 'none' }), batch.batchId]);
      await connection.commit();
      return { status: failed ? 'validation_failed' : 'staged', batchId: batch.batchId, rows: staged, perObject, unresolvedOfficeRows: snapshot.officeMapping.unresolved };
    } catch (error) { await connection.rollback(); throw error; }
  }

  async markFailed(batchId) {
    const connection = this.connection; await connection.beginTransaction();
    try {
      const [batchRows] = await connection.execute('SELECT status FROM dashboard_import_batch WHERE batch_id=? FOR UPDATE', [batchId]);
      if (!batchRows.length || batchRows[0].status === 'completed') { await connection.commit(); return; }
      await connection.execute(`UPDATE dashboard_import_batch SET status='failed',finished_at=CURRENT_TIMESTAMP(3) WHERE batch_id=?`, [batchId]);
      const [issues] = await connection.execute(`SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='APPRAISAL_IMPORT_FAILED' LIMIT 1 FOR UPDATE`, [batchId]);
      if (!issues.length) await connection.execute(
        `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context) VALUES (?,'error','APPRAISAL_IMPORT_FAILED','appraisal-google-sheets','Impor Appraisal gagal sebelum staging selesai.',?)`,
        [batchId, JSON.stringify({ phase: 'staging' })],
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}
