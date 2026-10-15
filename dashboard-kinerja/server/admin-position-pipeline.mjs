import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { materializePositionWorkbook } from './imports/position-xlsx-adapter.mjs';
import { importPositionFile, scanPositionFile, POSITION_OBJECT_KEY } from './imports/position-importer.mjs';
import { MysqlPositionRepository } from './imports/mysql-position-repository.mjs';
import { factFromStaging, inFactChunkTransaction, planFactChunk } from './imports/position-fact-builder.mjs';
import { invalidatePositionRowsCache } from './funding-position-api.mjs';
import { getDatabaseConfig } from './db.js';
import { resolveRuntimeTarget, assertActualRuntimeTarget, RuntimeTargetError } from './runtime-target.mjs';

export const ADMIN_POSITION_TARGET = Object.freeze({ database: 'dashboard_funding_test', port: 3308 });
export const ADMIN_POSITION_DOMAIN = 'position_daily';
const CHUNK_SIZE = 500;
const FACT_COLUMNS = Object.freeze([
  'batch_id', 'object_id', 'source_row_number', 'position_date', 'office_id', 'segment_id', 'product_id',
  'source_segment_label', 'source_product_label', 'source_branch_label', 'source_office_label',
  'source_account_count_text', 'account_count', 'source_balance_text', 'balance', 'amount_unit_code',
  'parse_status', 'mapping_status',
]);

export function assertAdminPositionTarget(config, env = process.env) {
  try { return resolveRuntimeTarget(config, env); }
  catch {
    const error = new Error('Upload Admin hanya diizinkan pada target database runtime yang dikonfigurasi.');
    error.name = 'AdminTargetError';
    throw error;
  }
}

export async function assertActualAdminTarget(connection, config = getDatabaseConfig(), env = process.env) {
  try { return await assertActualRuntimeTarget(connection, config, env); }
  catch (error) { if (error instanceof RuntimeTargetError) throw new Error('Identitas database aktif tidak sesuai target upload Admin.'); throw error; }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function validatePeriodDecisions(sourcePeriods, existingPeriods, decisions, confirmation) {
  const source = Object.keys(sourcePeriods).sort();
  if (!source.length || source.some(period => !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))) {
    throw new Error('Periode sumber tidak dapat ditentukan secara andal.');
  }
  if (Object.keys(decisions ?? {}).some(period => !source.includes(period))) throw new Error('Pilihan periode di luar preview ditolak.');
  const selected = [];
  for (const period of source) {
    const action = decisions?.[period];
    const exists = Number(existingPeriods?.[period]?.rows ?? 0) > 0;
    if (action === 'cancel') continue;
    if (exists && action !== 'replace') throw new Error(`Periode ${period} sudah tersedia; pilih Batalkan atau Ganti Data Periode.`);
    if (!exists && action !== 'add') throw new Error(`Periode ${period} belum tersedia; pilih Tambahkan atau Batalkan.`);
    selected.push({ period, action, sourceRows: sourcePeriods[period], previousRows: existingPeriods?.[period]?.rows ?? 0 });
  }
  if (!selected.length) throw new Error('Tidak ada periode yang dipilih untuk disimpan.');
  if (selected.some(item => item.action === 'replace') && confirmation !== 'GANTI DATA PERIODE') {
    throw new Error('Ketik GANTI DATA PERIODE untuk mengonfirmasi penggantian periode lama.');
  }
  return selected;
}

export async function currentPositionPeriods(connection) {
  const [baseObjects] = await connection.execute(
    `SELECT o.object_id,b.batch_id FROM dashboard_source_registry s
     JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
     JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key=?
     JOIN dashboard_import_object o ON o.object_id=i.object_id
     WHERE s.source_key='segmen_data_json' AND o.source_row_count=1039742
     ORDER BY b.finished_at ASC,o.object_id ASC LIMIT 1`, [POSITION_OBJECT_KEY],
  );
  if (baseObjects.length !== 1) throw new Error('Snapshot dasar Posisi Dana yang tervalidasi tidak tersedia.');
  const baseObjectId = String(baseObjects[0].object_id);
  const [baseMonths] = await connection.execute(
    `SELECT DATE_FORMAT(position_date,'%Y-%m') AS period,COUNT(*) AS row_count,COUNT(DISTINCT position_date) AS date_count
     FROM dashboard_fact_position_daily WHERE object_id=? GROUP BY DATE_FORMAT(position_date,'%Y-%m')`, [baseObjectId],
  );
  const periods = Object.fromEntries(baseMonths.map(row => [row.period, { rows: Number(row.row_count), dates: Number(row.date_count), source: 'base' }]));
  const [published] = await connection.execute(
    `SELECT p.scope_key AS period,p.batch_id,p.publication_version,o.object_id
     FROM dashboard_domain_publication p
     JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
     JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key=?
     JOIN dashboard_import_object o ON o.object_id=i.object_id
     WHERE p.domain_key=? AND p.batch_id IS NOT NULL`, [POSITION_OBJECT_KEY, ADMIN_POSITION_DOMAIN],
  );
  for (const row of published) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period)) throw new Error('Publikasi Posisi Dana memiliki scope periode tidak valid.');
    const [counts] = await connection.execute(
      `SELECT COUNT(*) AS row_count,COUNT(DISTINCT position_date) AS date_count FROM dashboard_fact_position_daily
       WHERE object_id=? AND position_date>=? AND position_date<?`,
      [row.object_id, `${row.period}-01`, nextMonth(row.period)],
    );
    const count = Number(counts[0]?.row_count ?? 0);
    if (!count) throw new Error(`Publikasi periode ${row.period} tidak memiliki fakta.`);
    periods[row.period] = { rows: count, dates: Number(counts[0].date_count), source: 'published',
      version: Number(row.publication_version), batchId: row.batch_id };
  }
  return { baseObjectId, baseBatchId: baseObjects[0].batch_id, periods };
}

function nextMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
}

export async function previewPositionWorkbook(filePath, connection, { maxPreviewRows = 5, config = getDatabaseConfig(), env = process.env } = {}) {
  await assertActualAdminTarget(connection, config, env);
  const workbook = await materializePositionWorkbook(filePath);
  try {
    const previewRows = [];
    const datesByPeriod = new Map();
    const summary = await scanPositionFile(workbook.path, {
      strictSnapshot: false, expectedRows: workbook.rowCount,
      sourceChecksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes,
      onRecord: async row => {
        if (row.parsedPositionDate) {
          const period = row.parsedPositionDate.slice(0, 7);
          if (!datesByPeriod.has(period)) datesByPeriod.set(period, new Set());
          datesByPeriod.get(period).add(row.parsedPositionDate);
        }
        if (previewRows.length < maxPreviewRows) previewRows.push({
          sourceRowNumber: row.rowNumber, positionDate: row.parsedPositionDate,
          segment: row.sourceSegment, product: row.sourceProduct,
          office: row.sourceOfficeLabel, accountCount: row.parsedAccountCount,
          balance: row.parsedBalance, valid: row.parseStatus === 'valid',
          errors: row.errors.map(error => error.code),
        });
      },
    });
    const current = await currentPositionPeriods(connection);
    return {
      sheet: 'segmen_data', headers: workbook.headers, checksum: workbook.checksum,
      sourceSizeBytes: workbook.sourceSizeBytes, totalRows: summary.total,
      validRows: summary.validRows, invalidRows: summary.invalidRows,
      validationErrors: summary.validationErrors, previewRows,
      periods: Object.fromEntries(Object.entries(summary.periods).sort(([a], [b]) => a.localeCompare(b)).map(([period, rows]) => [period, {
        rows, dates: datesByPeriod.get(period)?.size ?? 0,
        existing: current.periods[period] ?? null,
      }])),
    };
  } finally { await workbook.cleanup(); }
}

async function activeOfficeLookup(connection) {
  const [objects] = await connection.execute(
    `SELECT i.object_id FROM dashboard_domain_publication p
     JOIN dashboard_import_batch b ON b.batch_id=p.batch_id AND b.status='completed'
     JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key='uker_list.json'
     WHERE p.domain_key='office_master' AND p.scope_key='default'`,
  );
  if (objects.length !== 1) throw new Error('Snapshot master kantor aktif tidak tunggal.');
  const masterObjectId = String(objects[0].object_id);
  const [offices] = await connection.execute(
    `SELECT v.office_id,v.office_version_id,v.office_name
     FROM dashboard_dim_office_version v JOIN dashboard_dim_office d ON d.office_id=v.office_id
     WHERE v.source_object_id=? AND d.source_system='uker_list_json'`, [masterObjectId],
  );
  if (!offices.length) throw new Error('Master kantor aktif kosong.');
  const names = new Map();
  for (const office of offices) {
    const name = String(office.office_name ?? '');
    if (!name || names.has(name)) throw new Error('Nama kantor pada snapshot aktif kosong atau ambigu.');
    names.set(name, { office_id: String(office.office_id), office_version_id: String(office.office_version_id) });
  }
  return { masterObjectId, names };
}

function placeholders(rows, width) { return rows.map(() => `(${Array(width).fill('?').join(',')})`).join(','); }

async function ensureDates(connection, objectId, selectedPeriods, config, env) {
  const [dates] = await connection.execute(
    `SELECT DISTINCT DATE_FORMAT(parsed_position_date,'%Y-%m-%d') AS date_value
     FROM dashboard_stg_position_row WHERE object_id=? ORDER BY date_value`, [objectId],
  );
  for (const { date_value: date } of dates) {
    if (!selectedPeriods.has(date.slice(0, 7))) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Tanggal staging tidak valid.');
    const [year, month, day] = date.split('-').map(Number);
    const monthStart = `${date.slice(0, 7)}-01`;
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const [existing] = await connection.execute(
      `SELECT calendar_year,calendar_month,calendar_day,DATE_FORMAT(month_start,'%Y-%m-%d') AS month_start,
              DATE_FORMAT(month_end,'%Y-%m-%d') AS month_end FROM dashboard_dim_date WHERE calendar_date=?`, [date],
    );
    if (existing.length) {
      const current = existing[0];
      if (Number(current.calendar_year) !== year || Number(current.calendar_month) !== month
        || Number(current.calendar_day) !== day || current.month_start !== monthStart || current.month_end !== monthEnd) {
        throw new Error(`Dimensi tanggal ${date} bertentangan dengan tanggal sumber.`);
      }
      continue;
    }
    await assertActualAdminTarget(connection, config, env);
    await connection.execute(
      `INSERT INTO dashboard_dim_date (calendar_date,calendar_year,calendar_month,calendar_day,month_start,month_end)
       VALUES (?,?,?,?,?,?)`,
      [date, year, month, day, monthStart, monthEnd],
    );
  }
}

async function buildCandidateFacts(connection, objectId, selectedPeriods, progress, config, env) {
  const master = await activeOfficeLookup(connection);
  const [segments] = await connection.execute('SELECT segment_id,source_label FROM dashboard_dim_segment');
  const [products] = await connection.execute('SELECT product_id,source_label FROM dashboard_dim_product');
  const segmentIds = new Map(segments.map(row => [String(row.source_label), String(row.segment_id)]));
  const productIds = new Map(products.map(row => [String(row.source_label), String(row.product_id)]));
  await ensureDates(connection, objectId, selectedPeriods, config, env);
  const [totalRows] = await connection.execute(
    `SELECT COUNT(*) AS total,SUM(parse_status='valid') AS valid_rows FROM dashboard_stg_position_row WHERE object_id=?`, [objectId],
  );
  const total = Number(totalRows[0]?.total ?? 0);
  if (!total || Number(totalRows[0].valid_rows) !== total) throw new Error('Staging mengandung baris tidak valid.');
  let cursor = '0'; let processed = 0; let selectedProcessed = 0; let resolved = 0; let unresolved = 0;
  while (true) {
    const [rows] = await connection.execute(
      `SELECT stg_position_id,batch_id,object_id,source_row_number,DATE_FORMAT(parsed_position_date,'%Y-%m-%d') AS parsed_position_date,
              source_segment,source_product,source_branch_label,source_office_label,source_account_count_text,
              parsed_account_count,source_balance_text,parsed_balance,parse_status
       FROM dashboard_stg_position_row WHERE object_id=? AND stg_position_id>? ORDER BY stg_position_id LIMIT ${CHUNK_SIZE}`,
      [objectId, cursor],
    );
    if (!rows.length) break;
    if (BigInt(rows[0].stg_position_id) <= BigInt(cursor)) throw new Error('Cursor staging tidak maju.');
    const selectedRows = rows.filter(row => selectedPeriods.has(String(row.parsed_position_date).slice(0, 7)));
    if (selectedRows.length) {
    await assertActualAdminTarget(connection, config, env);
    await inFactChunkTransaction(connection, async () => {
      const ids = selectedRows.map(row => String(row.stg_position_id));
      const [existingMapping] = await connection.execute(
        `SELECT stg_position_id,office_id,office_version_id,mapping_status FROM dashboard_stg_position_office_mapping
         WHERE master_source_object_id=? AND stg_position_id IN (${ids.map(() => '?').join(',')})`, [master.masterObjectId, ...ids],
      );
      const mappingById = new Map(existingMapping.map(row => [String(row.stg_position_id), row]));
      const newMappings = []; const expectedFacts = [];
      for (const row of selectedRows) {
        const office = master.names.get(String(row.source_office_label ?? '')) ?? null;
        const mapping = { office_id: office?.office_id ?? null, office_version_id: office?.office_version_id ?? null,
          mapping_status: office ? 'resolved' : 'unresolved' };
        const old = mappingById.get(String(row.stg_position_id));
        if (old) {
          if ((old.office_id == null ? null : String(old.office_id)) !== mapping.office_id
            || (old.office_version_id == null ? null : String(old.office_version_id)) !== mapping.office_version_id
            || old.mapping_status !== mapping.mapping_status) throw new Error('Mapping staging lama berbeda dari master aktif.');
        } else newMappings.push([row.stg_position_id, master.masterObjectId, mapping.office_id, mapping.office_version_id, mapping.mapping_status]);
        const fact = factFromStaging({ ...row, ...mapping, office_version_office_id: mapping.office_id,
          segment_id: segmentIds.get(String(row.source_segment)) ?? null,
          product_id: productIds.get(String(row.source_product)) ?? null });
        expectedFacts.push(fact);
        if (mapping.office_id === null) unresolved += 1; else resolved += 1;
      }
      if (newMappings.length) await connection.execute(
        `INSERT INTO dashboard_stg_position_office_mapping
         (stg_position_id,master_source_object_id,office_id,office_version_id,mapping_status)
         VALUES ${placeholders(newMappings, 5)}`, newMappings.flat(),
      );
      const sourceRows = rows.map(row => String(row.source_row_number));
      const [existingFacts] = await connection.execute(
        `SELECT ${FACT_COLUMNS.map(column => column === 'position_date' ? "DATE_FORMAT(position_date,'%Y-%m-%d') AS position_date" : column).join(',')}
         FROM dashboard_fact_position_daily
         WHERE object_id=? AND source_row_number IN (${sourceRows.map(() => '?').join(',')})`, [objectId, ...sourceRows],
      );
      const { missing } = planFactChunk(expectedFacts, existingFacts);
      if (missing.length) await connection.execute(
        `INSERT INTO dashboard_fact_position_daily (${FACT_COLUMNS.join(',')}) VALUES ${placeholders(missing, FACT_COLUMNS.length)}`,
        missing.flatMap(row => FACT_COLUMNS.map(column => row[column])),
      );
    });
    }
    cursor = String(rows.at(-1).stg_position_id);
    processed += rows.length;
    selectedProcessed += selectedRows.length;
    if (processed > total) throw new Error('Progres kandidat fakta melebihi staging.');
    progress?.({ phase: 'facts', processed, total });
  }
  if (processed !== total) throw new Error('Tidak semua baris staging diproses.');
  for (const period of selectedPeriods) {
    const [facts] = await connection.execute(
      `SELECT COUNT(*) AS total,SUM(parse_status<>'valid') AS invalid_rows
       FROM dashboard_fact_position_daily WHERE object_id=? AND position_date>=? AND position_date<?`,
      [objectId, `${period}-01`, nextMonth(period)],
    );
    const [source] = await connection.execute(
      `SELECT COUNT(*) AS total FROM dashboard_stg_position_row
       WHERE object_id=? AND parsed_position_date>=? AND parsed_position_date<?`,
      [objectId, `${period}-01`, nextMonth(period)],
    );
    if (Number(facts[0]?.total) !== Number(source[0]?.total) || Number(facts[0]?.invalid_rows)) {
      throw new Error(`Rekonsiliasi fakta periode ${period} gagal.`);
    }
  }
  return { sourceRows: total, candidateRows: selectedProcessed, resolved, unresolved, masterObjectId: master.masterObjectId };
}

export async function commitPositionWorkbook({ filePath, preview, decisions, confirmation, actor, pool, config, progress, env = process.env }) {
  assertAdminPositionTarget(config, env);
  if (await sha256File(filePath) !== preview.checksum) throw new Error('File berubah setelah preview. Unggah ulang.');
  const connection = await pool.getConnection();
  let locked = false;
  let workbook;
  try {
    await assertActualAdminTarget(connection, config, env);
    const [locks] = await connection.execute('SELECT GET_LOCK(?,30) AS acquired', ['dashboard-admin-position-publication']);
    locked = Number(locks[0]?.acquired) === 1;
    if (!locked) throw new Error('Proses upload Posisi Dana lain sedang berlangsung.');
    const before = await currentPositionPeriods(connection);
    const sourcePeriods = Object.fromEntries(Object.entries(preview.periods).map(([period, data]) => [period, data.rows]));
    const selected = validatePeriodDecisions(sourcePeriods, before.periods, decisions, confirmation);
    for (const item of selected) {
      const previewExisting = preview.periods[item.period]?.existing ?? null;
      const currentExisting = before.periods[item.period] ?? null;
      if ((previewExisting?.rows ?? 0) !== (currentExisting?.rows ?? 0)
        || (previewExisting?.version ?? null) !== (currentExisting?.version ?? null)
        || (previewExisting?.batchId ?? null) !== (currentExisting?.batchId ?? null)) {
        throw new Error('Publikasi periode berubah sejak preview. Ulangi preview.');
      }
    }
    progress?.({ phase: 'read-workbook', processed: 0 });
    workbook = await materializePositionWorkbook(filePath);
    if (workbook.checksum !== preview.checksum || workbook.rowCount !== preview.totalRows) throw new Error('Isi workbook berubah sejak preview.');
    progress?.({ phase: 'staging', processed: 0, total: workbook.rowCount });
    // Existing importer owns registry, idempotency, row identity, and chunked staging transactions.
    const repository = new MysqlPositionRepository(pool, config, { allowProductionAdmin: true, env });
    const staged = await importPositionFile(workbook.path, repository, {
      expectedRows: workbook.rowCount, strictSnapshot: false,
      sourceChecksum: workbook.checksum, sourceSizeBytes: workbook.sourceSizeBytes,
      verifySourceUnchanged: workbook.verifyUnchanged, sourceLocation: 'admin-upload',
    });
    if (!['staged', 'already_staged'].includes(staged.status) || staged.summary.invalidRows) {
      throw new Error('Validasi staging belum lulus; data tidak dipublikasikan.');
    }
    const [objects] = await connection.execute(
      `SELECT i.object_id FROM dashboard_import_object_identity i WHERE i.batch_id=? AND i.object_key=?`,
      [staged.batchId, POSITION_OBJECT_KEY],
    );
    if (objects.length !== 1) throw new Error('Identitas object staging tidak tunggal.');
    const objectId = String(objects[0].object_id);
    const facts = await buildCandidateFacts(connection, objectId, new Set(selected.map(item => item.period)), progress, config, env);
    await assertActualAdminTarget(connection, config, env);
    await connection.beginTransaction();
    try {
      for (const item of selected) {
        const [rows] = await connection.execute(
          `SELECT COUNT(*) AS total FROM dashboard_fact_position_daily
           WHERE object_id=? AND position_date>=? AND position_date<?`,
          [objectId, `${item.period}-01`, nextMonth(item.period)],
        );
        if (Number(rows[0]?.total) !== item.sourceRows) throw new Error(`Fakta periode ${item.period} tidak lengkap.`);
        const [current] = await connection.execute(
          `SELECT batch_id,publication_version FROM dashboard_domain_publication
           WHERE domain_key=? AND scope_key=? FOR UPDATE`, [ADMIN_POSITION_DOMAIN, item.period],
        );
        const prior = current[0]?.batch_id ?? null;
        const baselineExists = Number(before.periods[item.period]?.rows ?? 0) > 0;
        if (baselineExists !== (item.action === 'replace')) throw new Error('Keputusan periode berubah sebelum publikasi.');
        const expectedPrior = before.periods[item.period];
        if (expectedPrior?.source === 'published'
          ? (prior !== expectedPrior.batchId || Number(current[0]?.publication_version) !== expectedPrior.version)
          : current.length !== 0) throw new Error('Publikasi periode berubah saat kandidat fakta dibangun.');
        if (current.length) {
          if (prior === staged.batchId) continue;
          const version = Number(current[0].publication_version) + 1;
          await connection.execute(
            `UPDATE dashboard_domain_publication SET batch_id=?,publication_version=?,published_at=CURRENT_TIMESTAMP(3)
             WHERE domain_key=? AND scope_key=?`, [staged.batchId, version, ADMIN_POSITION_DOMAIN, item.period],
          );
          await connection.execute(
            `INSERT INTO dashboard_domain_publication_history
             (domain_key,scope_key,previous_batch_id,new_batch_id,publication_version,action,actor,reason)
             VALUES (?,?,?,?,?,'replace',?,?)`,
            [ADMIN_POSITION_DOMAIN, item.period, prior, staged.batchId, version, actor, 'Admin upload Excel; versi sebelumnya dipertahankan'],
          );
        } else {
          await connection.execute(
            `INSERT INTO dashboard_domain_publication (domain_key,scope_key,batch_id,publication_version,published_at)
             VALUES (?,?,?,1,CURRENT_TIMESTAMP(3))`, [ADMIN_POSITION_DOMAIN, item.period, staged.batchId],
          );
          await connection.execute(
            `INSERT INTO dashboard_domain_publication_history
             (domain_key,scope_key,previous_batch_id,new_batch_id,publication_version,action,actor,reason)
             VALUES (?,?,?,?,1,?,?,?)`,
            [ADMIN_POSITION_DOMAIN, item.period, item.action === 'replace' ? before.baseBatchId : null,
              staged.batchId, item.action, actor, 'Admin upload Excel; snapshot sebelumnya dipertahankan'],
          );
        }
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    invalidatePositionRowsCache();
    progress?.({ phase: 'completed', processed: facts.sourceRows, total: facts.sourceRows });
    return { status: 'completed', batchId: staged.batchId, publishedPeriods: selected.map(item => item.period), facts };
  } finally {
    if (workbook) await workbook.cleanup();
    if (locked) {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', ['dashboard-admin-position-publication']); } catch { /* released with connection */ }
    }
    connection.release();
  }
}
