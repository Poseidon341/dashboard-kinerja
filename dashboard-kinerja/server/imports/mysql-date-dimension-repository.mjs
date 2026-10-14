import { assertDateDimensionTarget, planDateDimensionRows } from './date-dimension.mjs';

const EXPECTED_POSITION_ROWS = 1_039_742;

export class MysqlDateDimensionRepository {
  constructor(pool, config) {
    assertDateDimensionTarget(config);
    this.pool = pool;
    this.config = config;
  }

  async run({ apply = false } = {}) {
    const connection = await this.pool.getConnection();
    let locked = false;
    try {
      await this.verifyTarget(connection);
      await this.verifySchema(connection);
      if (apply) {
        const [locks] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', ['position-dim-date-fill']);
        locked = Number(locks[0]?.acquired) === 1;
        if (!locked) throw new Error('Tidak berhasil memperoleh lock pengisian dimensi tanggal.');
      }
      let plan = await this.readPlan(connection);
      if (plan.invalidRows) throw new Error('Snapshot staging memiliki tanggal NULL/invalid; tidak ada tanggal yang diisi.');
      if (plan.conflicts.length) throw new Error(`Metadata dimensi tanggal berbeda pada ${plan.conflicts.length} tanggal; data existing tidak diubah.`);
      let applied = null;
      if (apply && plan.missing.length) {
        await connection.beginTransaction();
        try {
          await this.verifyTarget(connection);
          plan = await this.readPlan(connection);
          if (plan.invalidRows || plan.conflicts.length) throw new Error('Snapshot/tanggal berubah atau memiliki konflik; transaksi dibatalkan.');
          if (plan.missing.length) {
            const values = plan.missing.flatMap((row) => [row.calendar_date, row.calendar_year, row.calendar_month, row.calendar_day, row.month_start, row.month_end]);
            const placeholders = plan.missing.map(() => '(?,?,?,?,?,?)').join(',');
            await connection.execute(
              `INSERT IGNORE INTO dashboard_dim_date (calendar_date,calendar_year,calendar_month,calendar_day,month_start,month_end) VALUES ${placeholders}`,
              values,
            );
          }
          const verified = await this.readPlan(connection);
          if (verified.invalidRows || verified.conflicts.length || verified.missing.length) throw new Error('Verifikasi tanggal gagal; transaksi dimensi tanggal dibatalkan.');
          applied = { insertedCandidates: plan.missing.length, remainingMissing: verified.missing.length };
          await connection.commit();
          plan = verified;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      }
      return {
        snapshot: plan.snapshot,
        totalRows: plan.totalRows,
        invalidRows: plan.invalidRows,
        dates: { required: plan.requiredDates, present: plan.present, missing: plan.missing, conflicts: plan.conflicts },
        applyResult: applied,
      };
    } finally {
      if (locked) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', ['position-dim-date-fill']); } catch { /* released with connection */ }
      }
      connection.release();
    }
  }

  async verifyTarget(connection) {
    const [rows] = await connection.execute('SELECT DATABASE() AS database_name,@@port AS server_port');
    if (rows[0]?.database_name !== 'dashboard_funding_test' || rows[0]?.database_name !== this.config.database
      || Number(rows[0]?.server_port) !== 3308) throw new Error('Koneksi aktual bukan dashboard_funding_test pada port MySQL 3308.');
  }

  async verifySchema(connection) {
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_dim_date'`,
    );
    const expected = {
      calendar_date: ['date', 'NO'], calendar_year: ['smallint unsigned', 'NO'],
      calendar_month: ['tinyint unsigned', 'NO'], calendar_day: ['tinyint unsigned', 'NO'],
      month_start: ['date', 'NO'], month_end: ['date', 'NO'],
    };
    const found = new Map(columns.map((row) => [row.COLUMN_NAME, [String(row.COLUMN_TYPE).toLowerCase(), row.IS_NULLABLE]]));
    const mismatches = Object.entries(expected).filter(([name, value]) => JSON.stringify(found.get(name)) !== JSON.stringify(value)).map(([name]) => name);
    if (mismatches.length) throw new Error(`Struktur dashboard_dim_date tidak sesuai DDL pada: ${mismatches.join(', ')}.`);
    const [keys] = await connection.execute(
      `SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dashboard_dim_date' ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    );
    const primary = keys.filter((row) => row.INDEX_NAME === 'PRIMARY').map((row) => row.COLUMN_NAME);
    const monthIndex = keys.filter((row) => row.INDEX_NAME === 'idx_dim_date_month').map((row) => row.COLUMN_NAME);
    if (JSON.stringify(primary) !== JSON.stringify(['calendar_date'])
      || JSON.stringify(monthIndex) !== JSON.stringify(['calendar_year', 'calendar_month'])) throw new Error('Primary key atau indeks dashboard_dim_date tidak sesuai DDL.');
  }

  async readPlan(connection) {
    const [snapshotRows] = await connection.execute(
      `SELECT b.batch_id,oi.object_id,o.source_checksum,o.source_row_count,b.rows_staged,b.status
       FROM dashboard_source_registry s JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
       JOIN dashboard_import_object_identity oi ON oi.batch_id=b.batch_id AND oi.object_key='segmen_data.json'
       JOIN dashboard_import_object o ON o.object_id=oi.object_id
       WHERE s.source_key='segmen_data_json' ORDER BY b.finished_at DESC,oi.object_id DESC LIMIT 1`,
    );
    if (snapshotRows.length !== 1 || Number(snapshotRows[0].source_row_count) !== EXPECTED_POSITION_ROWS
      || Number(snapshotRows[0].rows_staged) !== EXPECTED_POSITION_ROWS || snapshotRows[0].status !== 'completed') {
      throw new Error('Snapshot staging Posisi Dana completed tidak sesuai jumlah yang diverifikasi.');
    }
    const snapshot = { batchId: String(snapshotRows[0].batch_id), sourceObjectId: String(snapshotRows[0].object_id), checksum: snapshotRows[0].source_checksum };
    const [counts] = await connection.execute(
      `SELECT COUNT(*) AS total_rows,SUM(parsed_position_date IS NULL) AS invalid_rows
       FROM dashboard_stg_position_row WHERE object_id=?`, [snapshot.sourceObjectId],
    );
    const totalRows = Number(counts[0]?.total_rows ?? 0);
    const invalidRows = Number(counts[0]?.invalid_rows ?? 0);
    if (totalRows !== EXPECTED_POSITION_ROWS) throw new Error('Jumlah staging Posisi Dana berubah; pengisian tanggal dihentikan.');
    const [distinct] = await connection.execute(
      `SELECT DISTINCT DATE_FORMAT(parsed_position_date,'%Y-%m-%d') AS calendar_date
       FROM dashboard_stg_position_row WHERE object_id=? AND parsed_position_date IS NOT NULL ORDER BY calendar_date`,
      [snapshot.sourceObjectId],
    );
    const requiredDates = distinct.map((row) => String(row.calendar_date));
    const existingRows = requiredDates.length ? await this.readExistingDates(connection, requiredDates) : [];
    const plan = planDateDimensionRows(requiredDates, existingRows);
    return { snapshot, totalRows, invalidRows, requiredDates, ...plan };
  }

  async readExistingDates(connection, dates) {
    const [rows] = await connection.execute(
      `SELECT DATE_FORMAT(calendar_date,'%Y-%m-%d') AS calendar_date,calendar_year,calendar_month,calendar_day,
       DATE_FORMAT(month_start,'%Y-%m-%d') AS month_start,DATE_FORMAT(month_end,'%Y-%m-%d') AS month_end
       FROM dashboard_dim_date WHERE calendar_date IN (${dates.map(() => '?').join(',')})`, dates,
    );
    return rows;
  }
}
