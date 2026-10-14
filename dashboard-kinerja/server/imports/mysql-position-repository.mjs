import { randomUUID } from 'node:crypto';
import { assertExpectedImportTarget } from './mysql-uker-repository.mjs';

const REQUIRED_COLUMNS = Object.freeze({
  dashboard_source_registry: ['source_id', 'source_key', 'source_type', 'display_name', 'source_location'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'started_at', 'finished_at', 'rows_read', 'rows_staged', 'rows_rejected'],
  dashboard_import_batch_detail: ['batch_id', 'parser_version', 'source_size_bytes', 'validation_summary'],
  dashboard_import_object: ['object_id', 'batch_id', 'object_name', 'object_type', 'source_checksum', 'source_row_count', 'metadata'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_idempotency: ['source_id', 'source_checksum', 'parser_version', 'batch_id'],
  dashboard_import_issue: ['batch_id', 'severity', 'issue_code', 'object_name', 'source_row_number', 'field_name', 'safe_message', 'context'],
  dashboard_stg_position_row: [
    'batch_id', 'object_id', 'source_row_number', 'raw_record', 'source_position_text', 'parsed_position_date',
    'source_segment', 'source_product', 'source_branch_label', 'source_office_label', 'source_account_count_text',
    'parsed_account_count', 'source_balance_text', 'parsed_balance', 'amount_unit_code', 'parse_status', 'mapping_status',
  ],
});
const REQUIRED_TYPES = Object.freeze({
  'dashboard_import_batch.source_checksum': 'char(64)',
  'dashboard_import_batch_detail.parser_version': 'varchar(64)',
  'dashboard_import_object_identity.object_key': 'varchar(255)',
  'dashboard_import_idempotency.parser_version': 'varchar(64)',
  'dashboard_stg_position_row.source_row_number': 'bigint unsigned',
  'dashboard_stg_position_row.raw_record': 'longtext',
  'dashboard_stg_position_row.source_position_text': 'varchar(32)',
  'dashboard_stg_position_row.parsed_position_date': 'date',
  'dashboard_stg_position_row.source_segment': 'varchar(128)',
  'dashboard_stg_position_row.source_product': 'varchar(128)',
  'dashboard_stg_position_row.source_branch_label': 'varchar(255)',
  'dashboard_stg_position_row.source_office_label': 'varchar(255)',
  'dashboard_stg_position_row.source_account_count_text': 'varchar(64)',
  'dashboard_stg_position_row.parsed_account_count': 'bigint',
  'dashboard_stg_position_row.source_balance_text': 'varchar(128)',
  'dashboard_stg_position_row.parsed_balance': 'decimal(38,15)',
  'dashboard_stg_position_row.amount_unit_code': 'varchar(24)',
  'dashboard_stg_position_row.parse_status': 'varchar(24)',
  'dashboard_stg_position_row.mapping_status': 'varchar(24)',
});

function valuesFor(rows, columns) {
  return {
    placeholders: rows.map(() => `(${columns.map(() => '?').join(',')})`).join(','),
    values: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

export function assertPositionTestTarget(config) {
  assertExpectedImportTarget(config);
  if (config.database !== 'dashboard_funding_test') {
    const error = new Error('Importer Posisi Dana tahap ini hanya diizinkan ke dashboard_funding_test.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}

export class MysqlPositionRepository {
  constructor(pool, config) {
    assertPositionTestTarget(config);
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
      if (databaseRows[0]?.database_name !== this.database) throw new Error('Database aktif tidak sesuai target impor yang diizinkan.');
      const lockName = `dashboard_import:${sourceKey}`;
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
      acquired = Number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new Error('Tidak berhasil memperoleh lock impor Posisi Dana.');
      await this.verifySchema();
      return await callback(this);
    } finally {
      if (acquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [`dashboard_import:${sourceKey}`]); } catch { /* released with connection */ }
      }
      this.connection = null;
      connection.release();
    }
  }

  async verifySchema() {
    const names = Object.keys(REQUIRED_COLUMNS);
    const [columnRows] = await this.connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')})`, names,
    );
    const columns = new Map(); const types = new Map();
    for (const row of columnRows) {
      if (!columns.has(row.TABLE_NAME)) columns.set(row.TABLE_NAME, new Set());
      columns.get(row.TABLE_NAME).add(row.COLUMN_NAME);
      types.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE).toLowerCase());
    }
    const missing = [];
    for (const [table, namesForTable] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of namesForTable) if (!columns.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`Skema impor Posisi Dana tidak lengkap: ${missing.join(', ')}.`);
    const wrongTypes = Object.entries(REQUIRED_TYPES).filter(([column, type]) => types.get(column) !== type).map(([column]) => column);
    if (wrongTypes.length) throw new Error(`Tipe kolom impor Posisi Dana tidak sesuai: ${wrongTypes.join(', ')}.`);

    const [uniqueRows] = await this.connection.execute(
      `SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_stg_position_row' AND NON_UNIQUE=0
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    );
    const unique = new Map();
    for (const row of uniqueRows) {
      if (!unique.has(row.INDEX_NAME)) unique.set(row.INDEX_NAME, []);
      unique.get(row.INDEX_NAME).push(row.COLUMN_NAME);
    }
    if (JSON.stringify(unique.get('uq_stg_position_source_row') ?? []) !== JSON.stringify(['object_id', 'source_row_number'])) {
      throw new Error('Unique key staging Posisi Dana tidak sesuai DDL migration.');
    }
    const [foreignRows] = await this.connection.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE()
       AND REFERENCED_TABLE_NAME IS NOT NULL AND CONSTRAINT_NAME IN
       ('fk_dashboard_import_batch_source','fk_batch_detail_batch','fk_dashboard_import_object_batch',
        'fk_object_identity_object','fk_object_identity_batch','fk_idempotency_source','fk_idempotency_batch',
        'fk_dashboard_import_issue_batch','fk_stg_position_batch','fk_stg_position_object')`,
    );
    const foreign = new Set(foreignRows.map((row) => row.CONSTRAINT_NAME));
    const expected = [
      'fk_dashboard_import_batch_source', 'fk_batch_detail_batch', 'fk_dashboard_import_object_batch',
      'fk_object_identity_object', 'fk_object_identity_batch', 'fk_idempotency_source', 'fk_idempotency_batch',
      'fk_dashboard_import_issue_batch', 'fk_stg_position_batch', 'fk_stg_position_object',
    ];
    const absent = expected.filter((name) => !foreign.has(name));
    if (absent.length) throw new Error(`Foreign key impor Posisi Dana tidak tersedia: ${absent.join(', ')}.`);
  }

  async reserveBatch({ sourceKey, objectKey, parserVersion, checksum, sourceSizeBytes, sourceRowCount, validationSummary, sourceSystem }) {
    const connection = this.connection;
    await connection.beginTransaction();
    try {
      const [sourceRows] = await connection.execute('SELECT source_id,source_type FROM dashboard_source_registry WHERE source_key=? FOR UPDATE', [sourceKey]);
      let sourceId = sourceRows[0]?.source_id;
      if (sourceId === undefined) {
        const [insertSource] = await connection.execute(
          'INSERT INTO dashboard_source_registry (source_key,source_type,display_name,source_location) VALUES (?,\'xlsx_file\',?,?)',
          [sourceKey, 'Posisi Dana (staging)', 'data/import/dashboard_funding.xlsx'],
        );
        sourceId = insertSource.insertId;
      } else if (!['json_file', 'xlsx_file'].includes(sourceRows[0].source_type)) throw new Error('Registry sumber Posisi Dana memiliki source_type berbeda.');
      else if (sourceRows[0].source_type !== 'xlsx_file') {
        await connection.execute('UPDATE dashboard_source_registry SET source_type=\'xlsx_file\',source_location=? WHERE source_id=?', ['data/import/dashboard_funding.xlsx', sourceId]);
      } else {
        await connection.execute('UPDATE dashboard_source_registry SET source_location=? WHERE source_id=?', ['data/import/dashboard_funding.xlsx', sourceId]);
      }

      const [idempotencyRows] = await connection.execute(
        `SELECT batch_id FROM dashboard_import_idempotency WHERE source_id=? AND source_checksum=? AND parser_version=? FOR UPDATE`,
        [sourceId, checksum, parserVersion],
      );
      let batchId = idempotencyRows[0]?.batch_id;
      let status; let observedAt;
      if (batchId) {
        const [batchRows] = await connection.execute(
          `SELECT status,source_checksum,DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at
           FROM dashboard_import_batch WHERE batch_id=? AND source_id=? FOR UPDATE`, [batchId, sourceId],
        );
        if (!batchRows.length || batchRows[0].source_checksum !== checksum) throw new Error('Idempotency batch Posisi Dana tidak konsisten.');
        status = batchRows[0].status; observedAt = batchRows[0].observed_at;
      } else {
        batchId = randomUUID();
        await connection.execute(
          `INSERT INTO dashboard_import_batch (batch_id,source_id,status,source_checksum,rows_read,rows_staged,rows_rejected)
           VALUES (?,?,'loading',?,0,0,0)`, [batchId, sourceId, checksum],
        );
        const [startedRows] = await connection.execute(
          `SELECT DATE_FORMAT(started_at,'%Y-%m-%d %H:%i:%s.%f') AS observed_at FROM dashboard_import_batch WHERE batch_id=?`, [batchId],
        );
        observedAt = startedRows[0]?.observed_at;
        if (!observedAt) throw new Error('Tidak dapat menetapkan waktu batch Posisi Dana.');
        await connection.execute(
          'INSERT INTO dashboard_import_batch_detail (batch_id,parser_version,source_size_bytes,validation_summary) VALUES (?,?,?,?)',
          [batchId, parserVersion, sourceSizeBytes, JSON.stringify(validationSummary)],
        );
        status = 'loading';
      }

      const [identityRows] = await connection.execute(
        `SELECT oi.object_id,o.object_name,o.object_type,o.source_checksum,o.source_row_count
         FROM dashboard_import_object_identity oi JOIN dashboard_import_object o ON o.object_id=oi.object_id
         WHERE oi.batch_id=? AND oi.object_key=? FOR UPDATE`, [batchId, objectKey],
      );
      let objectId;
      if (identityRows.length) {
        const identity = identityRows[0];
        if (identity.object_name !== objectKey || identity.object_type !== 'xlsx_sheet_snapshot' || identity.source_checksum !== checksum) throw new Error('Object identity Posisi Dana tidak konsisten.');
        objectId = identity.object_id;
        if (Number(identity.source_row_count) !== sourceRowCount) await connection.execute('UPDATE dashboard_import_object SET source_row_count=? WHERE object_id=?', [sourceRowCount, objectId]);
      } else {
        const [insertObject] = await connection.execute(
          `INSERT INTO dashboard_import_object (batch_id,object_name,object_type,source_checksum,source_row_count,metadata)
           VALUES (?,?,'xlsx_sheet_snapshot',?,?,?)`, [batchId, objectKey, checksum, sourceRowCount, JSON.stringify({ sourceSystem, sourceFormat: 'xlsx', sheetName: 'segmen_data', stagingOnly: true })],
        );
        objectId = insertObject.insertId;
        await connection.execute('INSERT INTO dashboard_import_object_identity (object_id,batch_id,object_key) VALUES (?,?,?)', [objectId, batchId, objectKey]);
      }
      if (!idempotencyRows.length) await connection.execute(
        'INSERT INTO dashboard_import_idempotency (source_id,source_checksum,parser_version,batch_id) VALUES (?,?,?,?)',
        [sourceId, checksum, parserVersion, batchId],
      );

      if (status === 'completed') {
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM dashboard_stg_position_row WHERE object_id=?', [objectId]);
        if (Number(counts[0]?.total) !== sourceRowCount) throw new Error('Batch Posisi Dana completed tidak cocok dengan jumlah staging.');
        await connection.commit();
        return { batchId, objectId, observedAt, alreadyStaged: true };
      }
      await connection.execute(
        `UPDATE dashboard_import_batch SET status='loading',finished_at=NULL,rows_read=0,rows_staged=0,rows_rejected=0 WHERE batch_id=?`, [batchId],
      );
      await connection.commit();
      return { batchId, objectId, observedAt, alreadyStaged: false };
    } catch (error) { await connection.rollback(); throw error; }
  }

  async stageChunk(batch, records, { rowsRead, rowsRejected }) {
    const connection = this.connection;
    const columns = [
      'batch_id','object_id','source_row_number','raw_record','source_position_text','parsed_position_date','source_segment','source_product',
      'source_branch_label','source_office_label','source_account_count_text','parsed_account_count','source_balance_text','parsed_balance',
      'amount_unit_code','parse_status','mapping_status',
    ];
    const rows = records.map((row) => ({
      batch_id: batch.batchId, object_id: batch.objectId, source_row_number: row.rowNumber, raw_record: row.rawRecord,
      source_position_text: row.sourcePositionText, parsed_position_date: row.parsedPositionDate,
      source_segment: row.sourceSegment, source_product: row.sourceProduct, source_branch_label: row.sourceBranchLabel,
      source_office_label: row.sourceOfficeLabel, source_account_count_text: row.sourceAccountCountText,
      parsed_account_count: row.parsedAccountCount, source_balance_text: row.sourceBalanceText,
      parsed_balance: row.parsedBalance, amount_unit_code: null, parse_status: row.parseStatus, mapping_status: row.mappingStatus,
    }));
    await connection.beginTransaction();
    try {
      const values = valuesFor(rows, columns);
      await connection.execute(
        `INSERT INTO dashboard_stg_position_row (${columns.join(',')}) VALUES ${values.placeholders}
         ON DUPLICATE KEY UPDATE raw_record=VALUES(raw_record),source_position_text=VALUES(source_position_text),
         parsed_position_date=VALUES(parsed_position_date),source_segment=VALUES(source_segment),source_product=VALUES(source_product),
         source_branch_label=VALUES(source_branch_label),source_office_label=VALUES(source_office_label),
         source_account_count_text=VALUES(source_account_count_text),parsed_account_count=VALUES(parsed_account_count),
         source_balance_text=VALUES(source_balance_text),parsed_balance=VALUES(parsed_balance),amount_unit_code=NULL,
         parse_status=VALUES(parse_status),mapping_status=VALUES(mapping_status)`, values.values,
      );
      const invalid = records.filter((row) => row.parseStatus !== 'valid');
      if (invalid.length) {
        const rowNumbers = invalid.map((row) => row.rowNumber);
        const [existingRows] = await connection.execute(
          `SELECT source_row_number FROM dashboard_import_issue WHERE batch_id=? AND issue_code='POSITION_ROW_VALIDATION_FAILED'
           AND source_row_number IN (${rowNumbers.map(() => '?').join(',')})`, [batch.batchId, ...rowNumbers],
        );
        const existing = new Set(existingRows.map((row) => Number(row.source_row_number)));
        const newIssues = invalid.filter((row) => !existing.has(row.rowNumber)).map((row) => ({
          batch_id: batch.batchId, source_row_number: row.rowNumber, context: JSON.stringify({ fields: row.errors.map((error) => ({ field: error.field, code: error.code })) }),
        }));
        if (newIssues.length) {
          const issueValues = valuesFor(newIssues, ['batch_id','source_row_number','context']);
          await connection.execute(
            `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,source_row_number,safe_message,context)
             VALUES ${newIssues.map(() => "(?,'error','POSITION_ROW_VALIDATION_FAILED','segmen_data.json',?,'Record Posisi Dana gagal validasi; raw record tersimpan di staging.',?)").join(',')}`,
            issueValues.values,
          );
        }
      }
      await connection.execute(
        `UPDATE dashboard_import_batch SET rows_read=?,rows_staged=?,rows_rejected=? WHERE batch_id=? AND status='loading'`,
        [rowsRead, rowsRead, rowsRejected, batch.batchId],
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }

  async finalizeBatch(batch, summary) {
    const connection = this.connection;
    await connection.beginTransaction();
    try {
      const [counts] = await connection.execute(
        `SELECT COUNT(*) AS total,SUM(parse_status='valid') AS valid_rows,SUM(parse_status<>'valid') AS invalid_rows,
         SUM(mapping_status='unresolved') AS unresolved_rows FROM dashboard_stg_position_row WHERE object_id=?`, [batch.objectId],
      );
      const total = Number(counts[0]?.total ?? 0); const valid = Number(counts[0]?.valid_rows ?? 0);
      const invalid = Number(counts[0]?.invalid_rows ?? 0); const unresolved = Number(counts[0]?.unresolved_rows ?? 0);
      const validated = total === summary.total && valid === summary.validRows && invalid === summary.invalidRows
        && unresolved === summary.total && Object.keys(summary.validationErrors).length === 0;
      if (!validated) {
        const [issues] = await connection.execute(
          `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='POSITION_STAGING_VALIDATION_FAILED'
           AND source_row_number IS NULL LIMIT 1 FOR UPDATE`, [batch.batchId],
        );
        if (!issues.length) await connection.execute(
          `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context)
           VALUES (?,'error','POSITION_STAGING_VALIDATION_FAILED',?,'Validasi keseluruhan staging Posisi Dana tidak lulus.',?)`,
          [batch.batchId, 'segmen_data.json', JSON.stringify({ expectedRows: summary.total, stagedRows: total, validRows: valid, invalidRows: invalid, unresolvedMappingRows: unresolved, validationErrors: summary.validationErrors })],
        );
      }
      const status = validated ? 'completed' : 'failed';
      await connection.execute(
        'UPDATE dashboard_import_batch SET status=?,finished_at=CURRENT_TIMESTAMP(3),rows_read=?,rows_staged=?,rows_rejected=? WHERE batch_id=?',
        [status, summary.total, total, invalid, batch.batchId],
      );
      await connection.execute(
        'UPDATE dashboard_import_batch_detail SET validation_summary=? WHERE batch_id=?',
        [JSON.stringify({ ...summary, stagingValidated: validated, publication: 'none', mapping: 'unresolved' }), batch.batchId],
      );
      await connection.commit();
      return validated ? 'staged' : 'validation_failed';
    } catch (error) { await connection.rollback(); throw error; }
  }

  async markFailed(batchId) {
    const connection = this.connection;
    await connection.beginTransaction();
    try {
      const [rows] = await connection.execute('SELECT status FROM dashboard_import_batch WHERE batch_id=? FOR UPDATE', [batchId]);
      if (!rows.length || rows[0].status === 'completed') { await connection.commit(); return; }
      await connection.execute("UPDATE dashboard_import_batch SET status='failed',finished_at=CURRENT_TIMESTAMP(3) WHERE batch_id=?", [batchId]);
      const [issues] = await connection.execute(
        `SELECT issue_id FROM dashboard_import_issue WHERE batch_id=? AND issue_code='POSITION_IMPORT_FAILED' LIMIT 1 FOR UPDATE`, [batchId],
      );
      if (!issues.length) await connection.execute(
        `INSERT INTO dashboard_import_issue (batch_id,severity,issue_code,object_name,safe_message,context)
         VALUES (?,'error','POSITION_IMPORT_FAILED','segmen_data.json','Impor Posisi Dana gagal sebelum staging selesai.',?)`,
        [batchId, JSON.stringify({ phase: 'staging' })],
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}
