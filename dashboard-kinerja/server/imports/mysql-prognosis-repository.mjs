import { randomUUID } from 'node:crypto';
import { assertExpectedImportTarget } from './mysql-uker-repository.mjs';
import { PROGNOSIS_OBJECT_KEY_PREFIX } from './prognosis-importer.mjs';

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type', 'display_name', 'source_location'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'finished_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'source_size_bytes', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count', 'metadata'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['batch_id', 'severity', 'issue_code', 'object_name', 'source_row_number', 'field_name', 'safe_message', 'context'],
  dashboard_stg_prognosis_row: ['batch_id', 'object_id', 'sheet_name', 'source_row_number', 'source_range', 'header_levels', 'raw_row', 'row_status'],
});
const REQUIRED_TYPES = Object.freeze({
  'dashboard_import_batch.source_checksum': 'char(64)',
  'dashboard_import_batch_detail.parser_version': 'varchar(64)',
  'dashboard_import_object_identity.object_key': 'varchar(255)',
  'dashboard_import_idempotency.parser_version': 'varchar(64)',
  'dashboard_stg_prognosis_row.sheet_name': 'varchar(128)',
  'dashboard_stg_prognosis_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_prognosis_row.source_range': 'varchar(64)',
  'dashboard_stg_prognosis_row.header_levels': 'json',
  'dashboard_stg_prognosis_row.raw_row': 'longtext',
  'dashboard_stg_prognosis_row.row_status': 'varchar(24)',
});

function valuesFor(records, columns) {
  return { placeholders: records.map(() => `(${columns.map(() => '?').join(',')})`).join(','), values: records.flatMap((row) => columns.map((column) => row[column])) };
}

export function assertPrognosisTestTarget(config) {
  assertExpectedImportTarget(config);
  if (config.database !== 'dashboard_funding_test') {
    const error = new Error('Importer Prognosa tahap ini hanya diizinkan ke dashboard_funding_test.');
    error.name = 'ImportTargetMismatchError'; throw error;
  }
}

export class MysqlPrognosisRepository {
  constructor(pool, config) {
    assertPrognosisTestTarget(config);
    this.pool = pool; this.database = config.database; this.connection = null;
  }

  async withSourceLock(sourceKey, callback) {
    const connection = await this.pool.getConnection(); this.connection = connection; let acquired = false;
    try {
      const [databaseRows] = await connection.execute('SELECT DATABASE() AS database_name');
      if (databaseRows[0]?.database_name !== this.database) throw new Error('Database aktif tidak sesuai target impor yang diizinkan.');
      const lockName = `dashboard_import:${sourceKey}`;
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?,15) AS acquired', [lockName]);
      acquired = Number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new Error('Tidak berhasil memperoleh lock impor Prognosa.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (acquired) { try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* released with connection */ } }
      this.connection = null; connection.release();
    }
  }

  async verifySchema() {
    const tables = Object.keys(REQUIRED_COLUMNS);
    const [columnRows] = await this.connection.execute(
      `SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables,
    );
    const columns = new Map(); const types = new Map();
    for (const row of columnRows) {
      if (!columns.has(row.TABLE_NAME)) columns.set(row.TABLE_NAME, new Set());
      columns.get(row.TABLE_NAME).add(row.COLUMN_NAME); types.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE).toLowerCase());
    }
    const missing = [];
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) for (const column of required) if (!columns.get(table)?.has(column)) missing.push(`${table}.${column}`);
    if (missing.length) throw new Error(`Skema impor Prognosa tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(REQUIRED_TYPES).filter(([column, expected]) => types.get(column) !== expected).map(([column]) => column);
    if (wrongTypes.length) throw new Error(`Tipe kolom impor Prognosa tidak sesuai: ${wrongTypes.join(', ')}.`);

    const [uniqueRows] = await this.connection.execute(
      `SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_stg_prognosis_row' AND NON_UNIQUE=0
       ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    );
    const unique = new Map();
    for (const row of uniqueRows) { if (!unique.has(row.INDEX_NAME)) unique.set(row.INDEX_NAME, []); unique.get(row.INDEX_NAME).push(row.COLUMN_NAME); }
    if (JSON.stringify(unique.get('uq_stg_prognosis_source_row') ?? []) !== JSON.stringify(['object_id', 'source_row_number'])) throw new Error('Unique key staging Prognosa tidak sesuai DDL migration.');

    const [fkRows] = await this.connection.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       AND CONSTRAINT_NAME IN ('fk_dashboard_import_batch_source','fk_batch_detail_batch','fk_dashboard_import_object_batch',
       'fk_object_identity_object','fk_object_identity_batch','fk_idempotency_source','fk_idempotency_batch',
       'fk_dashboard_import_issue_batch','fk_stg_prognosis_batch','fk_stg_prognosis_object')`,
    );
    const found = new Set(fkRows.map((row) => row.CONSTRAINT_NAME));
    const expected = ['fk_dashboard_import_batch_source','fk_batch_detail_batch','fk_dashboard_import_object_batch',
      'fk_object_identity_object','fk_object_identity_batch','fk_idempotency_source','fk_idempotency_batch',
      'fk_dashboard_import_issue_batch','fk_stg_prognosis_batch','fk_stg_prognosis_object'];
    const absent = expected.filter((name) => !found.has(name));
    if (absent.length) throw new Error(`Foreign key impor Prognosa tidak tersedia: ${absent.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, objectKeyPrefix, parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary, sourceSystem, sheets,
    registryType = 'xlsx_file', sourceLocation = 'data/import/prognosa.xlsx', objectName = 'prognosa.xlsx', objectType = 'xlsx_sheet' }) {
    const connection = this.connection; await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute('SELECT source_id,source_type FROM dashboard_source_registry WHERE source_key=? FOR UPDATE', [sourceKey]);
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [inserted] = await connection.execute(
          `INSERT INTO dashboard_source_registry (source_key,source_type,display_name,source_location) VALUES (?,?,?,?)`,
          [sourceKey, registryType, 'Prognosa (staging)', sourceLocation],
        ); sourceId = inserted.insertId;
      } else if (!['json_file', 'xlsx_file'].includes(sourceRows[0].source_type)) throw new Error('Registry sumber Prognosa memiliki source_type berbeda.');
      else if (sourceRows[0].source_type !== registryType) await connection.execute(
        'UPDATE dashboard_source_registry SET source_type=?,source_location=? WHERE source_id=?', [registryType, sourceLocation, sourceId],
      );
      else await connection.execute('UPDATE dashboard_source_registry SET source_location=? WHERE source_id=?', [sourceLocation, sourceId]);

      const [idemRows] = await connection.execute(
        `SELECT batch_id FROM dashboard_import_idempotency WHERE source_id=? AND source_checksum=? AND parser_version=? FOR UPDATE`,
        [sourceId, checksum, parserVersion],
      );
      let batchId = idemRows[0]?.batch_id; let status; let observedAt;
      if (batchId) {
        const [rows] = await connection.execute(
          `SELECT status,source_checksum,DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_import_batch WHERE batch_id=? AND source_id=? FOR UPDATE`, [batchId, sourceId],
        );
        if (!rows.length || rows[0].source_checksum !== checksum) throw new Error('Idempotency batch Prognosa tidak konsisten.');
        status = rows[0].status; observedAt = rows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(`INSERT INTO dashboard_import_batch (batch_id,source_id,status,source_checksum,rows_read,rows_staged,rows_rejected) VALUES (?,?,'loading',?,0,0,0)`, [batchId, sourceId, checksum]);
        const [timeRows] = await connection.execute(`SELECT DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_import_batch WHERE batch_id=?`, [batchId]);
        observedAt = timeRows[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan waktu batch Prognosa.');
        await connection.execute(
          'INSERT INTO dashboard_import_batch_detail (batch_id,parser_version,source_size_bytes,validation_summary) VALUES (?,?,?,?)',
          [batchId, parserVersion, sourceSizeBytes, JSON.stringify(validationSummary)],
        ); status = 'loading';
      }

      const objectIds = {};
      for (const sheet of sheets) {
        const objectKey = `${objectKeyPrefix}${sheet.sheetName}`;
        const [identityRows] = await connection.execute(
          `SELECT oi.object_id,o.object_name,o.object_type,o.source_checksum,o.source_row_count
           FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id=oi.object_id
           WHERE oi.batch_id=? AND oi.object_key=? FOR UPDATE`, [batchId, objectKey],
        );
        if (identityRows.length) {
          const row = identityRows[0];
          if (row.object_name !== objectName || row.object_type !== objectType || row.source_checksum !== checksum) throw new Error(`Object identity sheet ${sheet.sheetName} tidak konsisten.`);
          objectIds[sheet.sheetName] = row.object_id;
          if (Number(row.source_row_count) !== sheet.sourceRowCount) await connection.execute('UPDATE dashboard_import_object SET source_row_count=? WHERE object_id=?', [sheet.sourceRowCount, row.object_id]);
        } else {
          const [object] = await connection.execute(
            `INSERT INTO dashboard_import_object (batch_id,object_name,object_type,source_checksum,source_row_count,metadata) VALUES (?,?,?,?,?,?)`,
            [batchId, objectName, objectType, checksum, sheet.sourceRowCount, JSON.stringify({ sourceSystem, sourceFormat: 'xlsx', sourceLocation, sheetName: sheet.sheetName, sourceRange: sheet.sourceRange })],
          );
          objectIds[sheet.sheetName] = object.insertId;
          await connection.execute('INSERT INTO dashboard_import_object_identity (object_id,batch_id,object_key) VALUES (?,?,?)', [object.insertId, batchId, objectKey]);
        }
      }
      if (!idemRows.length) await connection.execute(
        'INSERT INTO dashboard_import_idempotency (source_id,source_checksum,parser_version,batch_id) VALUES (?,?,?,?)', [sourceId, checksum, parserVersion, batchId],
      );

      if (status === 'completed') {
        for (const sheet of sheets) {
          const [countRows] = await connection.execute('SELECT COUNT(*) AS total FROM dashboard_stg_prognosis_row WHERE object_id=?', [objectIds[sheet.sheetName]]);
          if (Number(countRows[0]?.total) !== sheet.sourceRowCount) throw new Error(`Batch Prognosa selesai tetapi jumlah staging ${sheet.sheetName} tidak cocok.`);
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
      const stageRows = snapshot.sheets.flatMap((sheet) => sheet.rows.map((row) => ({
        batch_id: batch.batchId, object_id: batch.objectIds[sheet.sheetName], sheet_name: row.sheetName,
        source_row_number: row.sourceRowNumber, source_range: row.sourceRange, header_levels: row.headerLevels,
        raw_row: row.rawRow, row_status: row.rowStatus,
      })));
      const columns = ['batch_id','object_id','sheet_name','source_row_number','source_range','header_levels','raw_row','row_status'];
      for (let offset = 0; offset < stageRows.length; offset += 100) {
        const chunk = stageRows.slice(offset, offset + 100); const values = valuesFor(chunk, columns);
        await connection.execute(
          `INSERT INTO dashboard_stg_prognosis_row (${columns.join(',')}) VALUES ${values.placeholders}
           ON DUPLICATE KEY UPDATE sheet_name=VALUES(sheet_name),source_range=VALUES(source_range),header_levels=VALUES(header_levels),raw_row=VALUES(raw_row),row_status=VALUES(row_status)`, values.values,
        );
      }
      for (const issue of snapshot.errors) {
        const issueCode = `PROGNOSIS_${issue.code.toUpperCase()}`.slice(0, 100);
        const [existing] = await connection.execute(
          `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code=? AND object_name='prognosa.xlsx'
           AND source_row_number <=> ? AND field_name <=> ? LIMIT 1 FOR UPDATE`,
          [batch.batchId, issueCode, issue.sourceRowNumber ?? null, issue.sheetName ?? null],
        );
        if (!existing.length) await connection.execute(
          `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,source_row_number,field_name,safe_message,context)
           VALUES (?,'error',?,'prognosa.xlsx',?,?,?,?)`,
          [batch.batchId, issueCode, issue.sourceRowNumber ?? null, issue.sheetName ?? null, 'Validasi struktur staging Prognosa gagal; nilai sumber tetap disimpan.', JSON.stringify({ sheetName: issue.sheetName ?? null, code: issue.code })],
        );
      }

      let storedTotal = 0; let invalidRows = 0; const perSheet = {};
      for (const sheet of snapshot.sheets) {
        const objectId = batch.objectIds[sheet.sheetName];
        const [counts] = await connection.execute('SELECT COUNT(*) AS total,SUM(row_status=\'valid\') AS valid_rows FROM dashboard_stg_prognosis_row WHERE object_id=?', [objectId]);
        perSheet[sheet.sheetName] = Number(counts[0]?.total ?? 0); storedTotal += perSheet[sheet.sheetName];
        invalidRows += perSheet[sheet.sheetName] - Number(counts[0]?.valid_rows ?? 0);
        if (perSheet[sheet.sheetName] !== sheet.sourceRowCount) throw new Error(`Jumlah staging sheet ${sheet.sheetName} tidak cocok.`);
      }
      const failed = snapshot.errors.length > 0 || invalidRows > 0 || storedTotal !== snapshot.totalRows;
      await connection.execute(
        `UPDATE dashboard_import_batch SET status=?,finished_at=CURRENT_TIMESTAMP(3),rows_read=?,rows_staged=?,rows_rejected=? WHERE batch_id=?`,
        [failed ? 'failed' : 'completed', snapshot.totalRows, storedTotal, failed ? snapshot.errors.length : 0, batch.batchId],
      );
      await connection.execute(
        'UPDATE dashboard_import_batch_detail SET validation_summary=? WHERE batch_id=?',
        [JSON.stringify({ totalRows: snapshot.totalRows, perSheet, invalidRows, errorCount: snapshot.errors.length, currencyUnit: snapshot.metadata.currencyUnit, pipelineWeekDateRanges: snapshot.metadata.pipelineWeekDateRanges, stagingValidated: !failed, publication: 'none', classification: 'unresolved; raw rows preserved' }), batch.batchId],
      );
      await connection.commit(); return { status: failed ? 'validation_failed' : 'staged', batchId: batch.batchId, rows: storedTotal, perSheet };
    } catch (error) { await connection.rollback(); throw error; }
  }

  async markFailed(batchId) {
    const connection = this.connection; await connection.beginTransaction();
    try {
      const [rows] = await connection.execute('SELECT status FROM dashboard_import_batch WHERE batch_id=? FOR UPDATE', [batchId]);
      if (!rows.length || rows[0].status === 'completed') { await connection.commit(); return; }
      await connection.execute(`UPDATE dashboard_import_batch SET status='failed',finished_at=CURRENT_TIMESTAMP(3) WHERE batch_id=?`, [batchId]);
      const [issues] = await connection.execute(`SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='PROGNOSIS_IMPORT_FAILED' LIMIT 1 FOR UPDATE`, [batchId]);
      if (!issues.length) await connection.execute(
        `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context) VALUES (?,'error','PROGNOSIS_IMPORT_FAILED','prognosa.xlsx','Impor Prognosa gagal sebelum staging selesai.',?)`,
        [batchId, JSON.stringify({ phase: 'staging' })],
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}
