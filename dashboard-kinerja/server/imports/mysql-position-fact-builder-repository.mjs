import {
  assertFactSnapshotCounts,
  assertProgressWithinTotal,
  factFromStaging,
  inFactChunkTransaction,
  keysetPages,
  planFactChunk,
  POSITION_FACT_EXPECTED,
} from './position-fact-builder.mjs';

const REQUIRED = {
  dashboard_domain_publication: ['domain_key', 'scope_key', 'batch_id', 'publication_version'],
  dashboard_import_batch: ['batch_id', 'source_id', 'status', 'source_checksum', 'finished_at', 'rows_staged'],
  dashboard_source_registry: ['source_id', 'source_key'],
  dashboard_import_object_identity: ['object_id', 'batch_id', 'object_key'],
  dashboard_import_object: ['object_id', 'source_checksum', 'source_row_count'],
  dashboard_stg_position_row: [
    'stg_position_id', 'batch_id', 'object_id', 'source_row_number', 'parsed_position_date', 'source_segment',
    'source_product', 'source_branch_label', 'source_office_label', 'source_account_count_text',
    'parsed_account_count', 'source_balance_text', 'parsed_balance', 'parse_status',
  ],
  dashboard_stg_position_office_mapping: ['stg_position_id', 'master_source_object_id', 'office_id', 'office_version_id', 'mapping_status'],
  dashboard_dim_office_version: ['office_version_id', 'office_id', 'source_object_id'],
  dashboard_dim_date: ['calendar_date', 'calendar_year', 'calendar_month', 'calendar_day', 'month_start', 'month_end'],
  dashboard_dim_segment: ['segment_id', 'source_label'],
  dashboard_dim_product: ['product_id', 'source_label'],
  dashboard_fact_position_daily: [
    'position_id', 'batch_id', 'object_id', 'source_row_number', 'position_date', 'office_id', 'segment_id', 'product_id',
    'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label',
    'source_account_count_text', 'account_count', 'source_balance_text', 'balance', 'amount_unit_code', 'parse_status', 'mapping_status',
  ],
};

const FACT_COLUMNS = [
  'batch_id', 'object_id', 'source_row_number', 'position_date', 'office_id', 'segment_id', 'product_id',
  'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label',
  'source_account_count_text', 'account_count', 'source_balance_text', 'balance', 'amount_unit_code',
  'parse_status', 'mapping_status',
];

function valuesFor(rows, columns) {
  return {
    placeholders: rows.map(() => `(${columns.map(() => '?').join(',')})`).join(','),
    values: rows.flatMap((row) => columns.map((column) => row[column])),
  };
}

export class MysqlPositionFactBuilderRepository {
  constructor(pool, config, { chunkSize = 2000, onProgress = null } = {}) {
    this.pool = pool;
    this.config = config;
    this.chunkSize = chunkSize;
    this.onProgress = onProgress;
    this.database = config.database;
    if (config.database !== 'dashboard_funding_test'
      || !['127.0.0.1', 'localhost'].includes(String(config.host).toLowerCase())
      || Number(config.port) !== 3308) throw new Error('Target builder fakta tidak diizinkan.');
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 5000) throw new Error('Ukuran chunk harus 1 sampai 5000.');
  }

  async run({ apply = false } = {}) {
    const connection = await this.pool.getConnection();
    let locked = false;
    try {
      await this.assertConnectionTarget(connection);
      await this.verifySchema(connection);
      if (apply) {
        const [locks] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', ['position-candidate-fact-builder']);
        locked = Number(locks[0]?.acquired) === 1;
        if (!locked) throw new Error('Tidak berhasil memperoleh lock builder candidate fact.');
      }
      const snapshot = await this.readSnapshots(connection);
      const preflight = await this.preflight(connection, snapshot);
      if (apply && preflight.blockers.length) throw new Error(`Preflight candidate fact belum siap: ${preflight.blockers.join('; ')}.`);
      const result = apply
        ? await this.writeFacts(connection, snapshot, preflight)
        : { inserted: 0, existingValidated: preflight.existingFacts, completed: false };
      return { snapshot, preflight, result };
    } finally {
      if (locked) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', ['position-candidate-fact-builder']); } catch { /* released with connection */ }
      }
      connection.release();
    }
  }

  async assertConnectionTarget(connection) {
    const [rows] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
    if (rows[0]?.database_name !== this.database || rows[0]?.database_name !== 'dashboard_funding_test'
      || Number(rows[0]?.server_port) !== 3308) throw new Error('Koneksi aktual bukan dashboard_funding_test pada port MySQL 3308.');
  }

  async verifySchema(connection) {
    const tables = Object.keys(REQUIRED);
    const [rows] = await connection.execute(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables,
    );
    const found = new Map();
    for (const row of rows) {
      if (!found.has(row.TABLE_NAME)) found.set(row.TABLE_NAME, new Set());
      found.get(row.TABLE_NAME).add(row.COLUMN_NAME);
    }
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED)) for (const column of columns) {
      if (!found.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`Skema candidate fact tidak lengkap: ${missing.join(', ')}.`);

    const [indexes] = await connection.execute(
      `SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_fact_position_daily' AND NON_UNIQUE=0
       ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    );
    const uniqueSource = indexes.filter((row) => row.INDEX_NAME === 'uq_position_source_row').map((row) => row.COLUMN_NAME);
    if (JSON.stringify(uniqueSource) !== JSON.stringify(['object_id', 'source_row_number'])) throw new Error('Unique key fakta sumber tidak sesuai DDL.');
  }

  async readSnapshots(connection) {
    const [masters] = await connection.execute(
      `SELECT p.batch_id,p.publication_version,b.status,s.source_key,oi.object_id,o.source_checksum,o.source_row_count
       FROM dashboard_domain_publication p
       JOIN dashboard_import_batch b ON b.batch_id=p.batch_id
       JOIN dashboard_source_registry s ON s.source_id=b.source_id
       JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='uker_list.json'
       JOIN dashboard_import_object o ON o.object_id=oi.object_id
       WHERE p.domain_key='office_master' AND p.scope_key='default'`,
    );
    if (masters.length !== 1 || masters[0].status !== 'completed' || masters[0].source_key !== 'uker_list_json'
      || Number(masters[0].source_row_count) !== 611) throw new Error('Snapshot master kantor aktif tidak valid.');
    const masterObjectId = String(masters[0].object_id);

    const [positions] = await connection.execute(
      `SELECT b.batch_id,b.status,s.source_key,oi.object_id,o.source_checksum,o.source_row_count
       FROM dashboard_source_registry s JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
       JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='segmen_data.json'
       JOIN dashboard_import_object o ON o.object_id=oi.object_id
       WHERE s.source_key='segmen_data_json' ORDER BY b.finished_at DESC,oi.object_id DESC LIMIT 1`,
    );
    if (positions.length !== 1 || Number(positions[0].source_row_count) !== POSITION_FACT_EXPECTED.rows) throw new Error('Snapshot staging Posisi Dana tidak sesuai audit.');
    return {
      officeMaster: { sourceObjectId: masterObjectId, batchId: String(masters[0].batch_id), publicationVersion: String(masters[0].publication_version), checksum: masters[0].source_checksum },
      position: { sourceObjectId: String(positions[0].object_id), batchId: String(positions[0].batch_id), checksum: positions[0].source_checksum, rowCount: Number(positions[0].source_row_count) },
    };
  }

  async preflight(connection, snapshot) {
    const [staging] = await connection.execute(
      `SELECT COUNT(*) AS total,COUNT(DISTINCT source_row_number) AS unique_rows,
       SUM(parse_status='valid') AS valid_rows,SUM(parse_status<>'valid') AS invalid_rows,
       SUM(parsed_balance IS NULL) AS balance_null,SUM(parsed_balance=0) AS balance_zero,
       SUM(parsed_account_count IS NULL) AS account_null,SUM(parsed_account_count=0) AS account_zero
       FROM dashboard_stg_position_row WHERE object_id=?`, [snapshot.position.sourceObjectId],
    );
    const [mapping] = await connection.execute(
      `SELECT COUNT(*) AS total,COUNT(DISTINCT m.stg_position_id) AS unique_rows,
       SUM(m.office_id IS NOT NULL AND m.office_version_id IS NOT NULL AND m.mapping_status='resolved') AS resolved,
       SUM(m.office_id IS NULL AND m.office_version_id IS NULL AND m.mapping_status='unresolved') AS unresolved,
       SUM(NOT ((m.office_id IS NOT NULL AND m.office_version_id IS NOT NULL AND m.mapping_status='resolved')
         OR (m.office_id IS NULL AND m.office_version_id IS NULL AND m.mapping_status='unresolved'))) AS inconsistent,
       SUM(m.office_id IS NOT NULL AND (v.office_id IS NULL OR v.office_id<>m.office_id)) AS office_version_mismatch
       FROM dashboard_stg_position_row p JOIN dashboard_stg_position_office_mapping m ON m.stg_position_id=p.stg_position_id
       LEFT JOIN dashboard_dim_office_version v ON v.office_version_id=m.office_version_id
       WHERE p.object_id=? AND m.master_source_object_id=?`, [snapshot.position.sourceObjectId, snapshot.officeMaster.sourceObjectId],
    );
    assertFactSnapshotCounts({
      rows: staging[0].total,
      resolved: mapping[0].resolved,
      unresolved: mapping[0].unresolved,
      inconsistent: Number(mapping[0].inconsistent) + Number(mapping[0].office_version_mismatch),
    });
    if (Number(staging[0].unique_rows) !== POSITION_FACT_EXPECTED.rows || Number(staging[0].valid_rows) !== POSITION_FACT_EXPECTED.rows
      || Number(staging[0].invalid_rows) !== 0 || Number(mapping[0].total) !== POSITION_FACT_EXPECTED.rows
      || Number(mapping[0].unique_rows) !== POSITION_FACT_EXPECTED.rows) throw new Error('Preflight staging/mapping tidak lengkap atau tidak valid.');

    const [dateStats] = await connection.execute(
      `SELECT COUNT(DISTINCT p.parsed_position_date) AS source_dates,
       COUNT(DISTINCT d.calendar_date) AS available_dates
       FROM dashboard_stg_position_row p LEFT JOIN dashboard_dim_date d ON d.calendar_date=p.parsed_position_date
       WHERE p.object_id=?`, [snapshot.position.sourceObjectId],
    );
    const missingDateCount = Number(dateStats[0].source_dates) - Number(dateStats[0].available_dates);

    const [dimensionCoverage] = await connection.execute(
      `SELECT SUM(s.segment_id IS NULL) AS segment_id_unmapped,SUM(pr.product_id IS NULL) AS product_id_unmapped,
       SUM(p.source_branch_label IS NULL) AS missing_branch_label,SUM(p.source_office_label IS NULL) AS missing_office_label
       FROM dashboard_stg_position_row p
       LEFT JOIN dashboard_dim_segment s ON s.source_label=p.source_segment
       LEFT JOIN dashboard_dim_product pr ON pr.source_label=p.source_product
       WHERE p.object_id=?`, [snapshot.position.sourceObjectId],
    );

    const [facts] = await connection.execute(
      `SELECT COUNT(*) AS existing_count,COUNT(DISTINCT CONCAT(f.object_id,':',f.source_row_number)) AS unique_count,
       SUM(p.stg_position_id IS NULL) AS orphan_count
       FROM dashboard_fact_position_daily f LEFT JOIN dashboard_stg_position_row p
         ON p.object_id=f.object_id AND p.source_row_number=f.source_row_number
       WHERE f.object_id=?`, [snapshot.position.sourceObjectId],
    );
    const discrepancies = await this.countFactDiscrepancies(connection, snapshot);
    if (discrepancies) throw new Error('Candidate fact yang sudah ada berbeda dari snapshot staging/mapping saat ini.');
    const blockers = [];
    if (missingDateCount) blockers.push(`dim_date_missing:${missingDateCount}`);
    if (Number(facts[0].orphan_count)) blockers.push(`orphan_facts:${Number(facts[0].orphan_count)}`);
    if (Number(dimensionCoverage[0]?.missing_branch_label)) blockers.push(`missing_source_branch_label:${Number(dimensionCoverage[0].missing_branch_label)}`);
    if (Number(dimensionCoverage[0]?.missing_office_label)) blockers.push(`missing_source_office_label:${Number(dimensionCoverage[0].missing_office_label)}`);
    return {
      staging: { ...staging[0], total: Number(staging[0].total), uniqueRows: Number(staging[0].unique_rows), validRows: Number(staging[0].valid_rows), invalidRows: Number(staging[0].invalid_rows) },
      mapping: { total: Number(mapping[0].total), uniqueRows: Number(mapping[0].unique_rows), resolved: Number(mapping[0].resolved), unresolved: Number(mapping[0].unresolved), inconsistent: Number(mapping[0].inconsistent), officeVersionMismatch: Number(mapping[0].office_version_mismatch) },
      dates: { sourceDates: Number(dateStats[0].source_dates), availableDates: Number(dateStats[0].available_dates), missingDateCount },
      dimensions: Object.fromEntries(Object.entries(dimensionCoverage[0] ?? {}).map(([key, value]) => [key, Number(value)])),
      existingFacts: Number(facts[0].existing_count), existingUnique: Number(facts[0].unique_count), orphanFacts: Number(facts[0].orphan_count),
      missingFacts: POSITION_FACT_EXPECTED.rows - Number(facts[0].existing_count),
      factDiscrepancies: discrepancies,
      blockers,
    };
  }

  async countFactDiscrepancies(connection, snapshot) {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS mismatch_count FROM dashboard_fact_position_daily f
       JOIN dashboard_stg_position_row p ON p.object_id=f.object_id AND p.source_row_number=f.source_row_number
       JOIN dashboard_stg_position_office_mapping m ON m.stg_position_id=p.stg_position_id AND m.master_source_object_id=?
       LEFT JOIN dashboard_dim_date d ON d.calendar_date=p.parsed_position_date
       LEFT JOIN dashboard_dim_segment s ON s.source_label=p.source_segment
       LEFT JOIN dashboard_dim_product pr ON pr.source_label=p.source_product
       WHERE f.object_id=? AND (f.batch_id<>p.batch_id OR f.position_date<>p.parsed_position_date
         OR NOT (f.office_id <=> m.office_id) OR NOT (f.segment_id <=> s.segment_id) OR NOT (f.product_id <=> pr.product_id)
         OR NOT (f.source_segment_label <=> p.source_segment) OR NOT (f.source_product_label <=> p.source_product)
         OR NOT (f.source_branch_label <=> p.source_branch_label) OR NOT (f.source_office_label <=> p.source_office_label)
         OR NOT (f.source_account_count_text <=> p.source_account_count_text) OR NOT (f.account_count <=> p.parsed_account_count)
         OR NOT (f.source_balance_text <=> p.source_balance_text) OR NOT (f.balance <=> p.parsed_balance)
         OR f.amount_unit_code IS NOT NULL OR f.parse_status<>p.parse_status OR f.mapping_status<>m.mapping_status OR d.calendar_date IS NULL)`,
      [snapshot.officeMaster.sourceObjectId, snapshot.position.sourceObjectId],
    );
    return Number(rows[0]?.mismatch_count ?? 0);
  }

  async *stagingChunks(connection, snapshot, cursor = '0') {
    yield* keysetPages(async (after, limit) => {
      const [rows] = await connection.execute(
        `SELECT p.batch_id,p.object_id,p.source_row_number,p.parsed_position_date,p.source_segment,p.source_product,
          p.stg_position_id,
          p.source_branch_label,p.source_office_label,p.source_account_count_text,p.parsed_account_count,
          p.source_balance_text,p.parsed_balance,p.parse_status,m.office_id,m.office_version_id,m.mapping_status,
          v.office_id AS office_version_office_id,s.segment_id,pr.product_id
         FROM dashboard_stg_position_row p
         JOIN dashboard_stg_position_office_mapping m ON m.stg_position_id=p.stg_position_id AND m.master_source_object_id=?
         LEFT JOIN dashboard_dim_office_version v ON v.office_version_id=m.office_version_id
         LEFT JOIN dashboard_dim_segment s ON s.source_label=p.source_segment
         LEFT JOIN dashboard_dim_product pr ON pr.source_label=p.source_product
         WHERE p.object_id=? AND p.stg_position_id>? ORDER BY p.stg_position_id LIMIT ${limit}`,
        [snapshot.officeMaster.sourceObjectId, snapshot.position.sourceObjectId, after],
      );
      return rows;
    }, { chunkSize: this.chunkSize, initialCursor: cursor });
  }

  async writeFacts(connection, snapshot, preflight) {
    let inserted = 0;
    let validatedExisting = 0;
    let processed = 0;
    for await (const chunk of this.stagingChunks(connection, snapshot)) {
      assertProgressWithinTotal(processed + chunk.length, snapshot.position.rowCount);
      const expected = chunk.map(factFromStaging);
      const chunkInserted = await inFactChunkTransaction(connection, async () => {
        await this.assertConnectionTarget(connection);
        const keys = expected.map((row) => [row.object_id, row.source_row_number]);
        const existing = await this.readExistingFacts(connection, keys);
        const plan = planFactChunk(expected, existing);
        const missing = plan.missing;
        validatedExisting += plan.validatedExisting;
        if (missing.length) {
          const values = valuesFor(missing, FACT_COLUMNS);
          await connection.execute(`INSERT INTO dashboard_fact_position_daily (${FACT_COLUMNS.join(',')}) VALUES ${values.placeholders}`, values.values);
        }
        return missing.length;
      });
      inserted += chunkInserted;
      processed += chunk.length;
      this.onProgress?.({ processed, totalRows: snapshot.position.rowCount, inserted, validatedExisting });
    }
    if (processed !== snapshot.position.rowCount) throw new Error('Keyset selesai sebelum seluruh staging diproses; fakta tidak dinyatakan selesai.');
    await this.assertConnectionTarget(connection);
    const [finalRows] = await connection.execute(
      `SELECT COUNT(*) AS total,COUNT(DISTINCT CONCAT(object_id,':',source_row_number)) AS unique_rows,
       SUM(office_id IS NOT NULL) AS resolved,SUM(office_id IS NULL) AS unresolved,
       SUM(balance IS NULL) AS balance_null,SUM(balance=0) AS balance_zero,
       SUM(account_count IS NULL) AS account_null,SUM(account_count=0) AS account_zero,
       SUM(source_office_label IS NULL) AS missing_office_label,SUM(amount_unit_code IS NOT NULL) AS unit_code_nonnull
       FROM dashboard_fact_position_daily WHERE object_id=?`, [snapshot.position.sourceObjectId],
    );
    const final = finalRows[0] ?? {};
    const finalMismatch = await this.countFactDiscrepancies(connection, snapshot);
    if (Number(final.total) !== POSITION_FACT_EXPECTED.rows || Number(final.unique_rows) !== POSITION_FACT_EXPECTED.rows
      || Number(final.resolved) !== POSITION_FACT_EXPECTED.resolved || Number(final.unresolved) !== POSITION_FACT_EXPECTED.unresolved
      || Number(final.missing_office_label) !== 0 || Number(final.unit_code_nonnull) !== 0 || finalMismatch !== 0
      || Number(final.balance_null) !== Number(preflight.staging.balance_null)
      || Number(final.balance_zero) !== Number(preflight.staging.balance_zero)
      || Number(final.account_null) !== Number(preflight.staging.account_null)
      || Number(final.account_zero) !== Number(preflight.staging.account_zero)) {
      throw new Error('Verifikasi akhir candidate fact gagal; domain tetap tidak dipublikasikan.');
    }
    return { processed, inserted, existingValidated: validatedExisting, completed: true, final: { ...Object.fromEntries(Object.entries(final).map(([key, value]) => [key, Number(value)])), factDiscrepancies: finalMismatch }, publication: 'none' };
  }

  async readExistingFacts(connection, keys) {
    const rows = [];
    for (let start = 0; start < keys.length; start += 250) {
      const part = keys.slice(start, start + 250);
      const predicates = part.map(() => '(object_id=? AND source_row_number=?)').join(' OR ');
      const params = part.flatMap(([objectId, rowNumber]) => [objectId, rowNumber]);
      const [chunk] = await connection.execute(
        `SELECT ${FACT_COLUMNS.join(',')} FROM dashboard_fact_position_daily WHERE ${predicates}`, params,
      );
      rows.push(...chunk);
    }
    return rows;
  }
}
