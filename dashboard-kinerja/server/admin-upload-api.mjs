import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabaseConfig, getDatabasePool } from './db.js';
import {
  assertAdminPositionTarget, assertActualAdminTarget, commitPositionWorkbook,
  currentPositionDates, previewPositionWorkbook, validateDateDecisions,
} from './admin-position-pipeline.mjs';

const MAX_UPLOAD_BYTES = 350 * 1024 * 1024;
const SESSION_MS = 8 * 60 * 60 * 1000;
const PREVIEW_MS = 60 * 60 * 1000;
const TYPES = Object.freeze([
  { key: 'position', label: 'Posisi Dana / segmen_data', available: true, template: 'sheet segmen_data; Posisi, Segmentasi BPR, Produk, Nama Cabang, Nama Uker, Jumlah Rekening, Saldo' },
  { key: 'rka', label: 'RKA', available: false, reason: 'Publikasi target RKA memerlukan tahun anggaran dan pemetaan kategori yang disahkan.' },
  { key: 'prognosis', label: 'Prognosa', available: false, reason: 'Periode, klasifikasi subtotal, dan satuan workbook belum cukup untuk publikasi otomatis.' },
  { key: 'master', label: 'RMFT / Master Unit Kerja', available: false, reason: 'Perubahan master memerlukan validasi relasi dan histori mapping Posisi Dana.' },
  { key: 'appraisal', label: 'Appraisal', available: false, reason: 'Perbedaan cached formula Excel dengan staging masih memerlukan keputusan sumber resmi.' },
]);

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 4096) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('Content-Type harus application/json.');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Payload terlalu besar.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Payload JSON harus berupa objek.');
  return result;
}

function adminConfigured(env) {
  return Boolean(env.DASHBOARD_ADMIN_USER && String(env.DASHBOARD_ADMIN_USER).length <= 128
    && /^[a-f0-9]{32,128}:[a-f0-9]{64}$/i.test(env.DASHBOARD_ADMIN_PASSWORD_SCRYPT ?? ''));
}

function assertAdminOrigin(request, env) {
  if (env.DASHBOARD_RUNTIME_ENV !== 'production' || request.method === 'GET') return;
  let publicOrigin;
  try {
    const url = new URL(env.DASHBOARD_PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
    publicOrigin = url.origin;
  } catch {
    const error = new Error('Origin HTTPS Admin production belum dikonfigurasi.');
    error.name = 'AdminOriginError';
    throw error;
  }
  if (request.headers.origin !== publicOrigin) {
    const error = new Error('Origin Admin tidak diizinkan.');
    error.name = 'AdminOriginError';
    throw error;
  }
}

export function verifyAdminCredentials(username, password, env = process.env) {
  if (!adminConfigured(env) || typeof username !== 'string' || typeof password !== 'string') return false;
  const [salt, digest] = env.DASHBOARD_ADMIN_PASSWORD_SCRYPT.split(':');
  const computed = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  const expected = Buffer.from(digest, 'hex');
  const accountValid = username === env.DASHBOARD_ADMIN_USER;
  return accountValid && expected.length === computed.length && timingSafeEqual(computed, expected);
}

function cookieId(request) {
  const cookies = String(request.headers.cookie ?? '').split(';').map(item => item.trim());
  const item = cookies.find(value => value.startsWith('funding_admin_session='));
  return item ? item.slice('funding_admin_session='.length) : null;
}

async function saveUpload(request) {
  let filename;
  try { filename = decodeURIComponent(String(request.headers['x-admin-filename'] ?? '')); }
  catch { throw new Error('Nama file tidak valid.'); }
  if (!/^[^\\/]{1,180}\.xlsx$/i.test(filename)) throw new Error('Pilih file .xlsx yang valid.');
  if (request.headers['content-type'] !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    throw new Error('Tipe file harus XLSX.');
  }
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new Error('Ukuran file melebihi 350 MB.');
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-admin-upload-'));
  const path = join(directory, 'source.xlsx');
  const output = createWriteStream(path, { flags: 'wx' });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) throw new Error('Ukuran file melebihi 350 MB.');
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve, reject) => {
        output.once('drain', resolve); output.once('error', reject);
      });
    }
    await new Promise((resolve, reject) => { output.end(); output.once('finish', resolve); output.once('error', reject); });
    if (!bytes) throw new Error('File kosong.');
    const file = await open(path, 'r');
    try {
      const signature = Buffer.alloc(4); await file.read(signature, 0, 4, 0);
      if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('File bukan workbook XLSX/ZIP yang valid.');
    } finally { await file.close(); }
    return { path, directory, filename, bytes, checksum: hash.digest('hex') };
  } catch (error) {
    output.destroy(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

export function createAdminUploadHandler(dependencies = {}) {
  const getConfig = dependencies.getConfig || getDatabaseConfig;
  const getPool = dependencies.getPool || getDatabasePool;
  const env = dependencies.env || process.env;
  const previewWorkbook = dependencies.previewWorkbook || previewPositionWorkbook;
  const commitWorkbook = dependencies.commitWorkbook || commitPositionWorkbook;
  const sessions = new Map(); const previews = new Map(); const jobs = new Map(); const failedLogins = new Map();

  async function withDb(callback) {
    const config = getConfig(); assertAdminPositionTarget(config, env);
    const connection = await getPool().getConnection();
    try { await assertActualAdminTarget(connection, config, env); return await callback(connection, config); }
    finally { connection.release(); }
  }

  function clearExpired() {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
    for (const [key, value] of previews) if (value.expiresAt < now && !value.processing) {
      previews.delete(key); rm(value.upload.directory, { recursive: true, force: true }).catch(() => {});
    }
    for (const [key, value] of jobs) if (value.updatedAt < now - SESSION_MS) jobs.delete(key);
    for (const [key, value] of failedLogins) if (value.until < now) failedLogins.delete(key);
  }

  const handler = async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/admin/')) return false;
    clearExpired();
    try {
      assertAdminPositionTarget(getConfig(), env);
      assertAdminOrigin(request, env);
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        if (!adminConfigured(env)) return send(response, 503, { status: 'unavailable', error: 'admin_not_configured' });
        const address = request.socket?.remoteAddress || 'local';
        const attempts = failedLogins.get(address);
        if (attempts && attempts.count >= 5 && attempts.until > Date.now()) {
          return send(response, 429, { status: 'error', error: 'admin_login_rate_limited' });
        }
        const body = await readJson(request);
        if (!verifyAdminCredentials(body.username, body.password, env)) {
          failedLogins.set(address, { count: (attempts?.count ?? 0) + 1, until: Date.now() + 15 * 60 * 1000 });
          return send(response, 401, { status: 'error', error: 'invalid_admin_credentials' });
        }
        failedLogins.delete(address);
        const id = randomBytes(32).toString('hex');
        const csrf = randomBytes(32).toString('hex');
        sessions.set(id, { user: body.username, csrf, expiresAt: Date.now() + SESSION_MS });
        return send(response, 200, { status: 'ok', user: body.username, csrf }, {
          'Set-Cookie': `funding_admin_session=${id}; HttpOnly; SameSite=Strict; ${env.DASHBOARD_RUNTIME_ENV === 'production' ? 'Secure; ' : ''}Path=/api; Max-Age=${SESSION_MS / 1000}`,
        });
      }
      const id = cookieId(request);
      const session = id && sessions.get(id);
      if (!session || session.expiresAt < Date.now()) return send(response, 401, { status: 'error', error: 'admin_auth_required' });
      if (request.method !== 'GET' && url.pathname !== '/api/admin/logout' && request.headers['x-admin-csrf'] !== session.csrf) {
        return send(response, 403, { status: 'error', error: 'admin_csrf_invalid' });
      }
      if (url.pathname === '/api/admin/session' && request.method === 'GET') {
        return send(response, 200, { status: 'ok', user: session.user, csrf: session.csrf, reportTypes: TYPES });
      }
      if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
        sessions.delete(id);
        return send(response, 200, { status: 'ok' }, {
          'Set-Cookie': `funding_admin_session=; HttpOnly; SameSite=Strict; ${env.DASHBOARD_RUNTIME_ENV === 'production' ? 'Secure; ' : ''}Path=/api; Max-Age=0`,
        });
      }
      if (url.pathname === '/api/admin/history' && request.method === 'GET') {
        const history = await withDb(async connection => {
          const [rows] = await connection.execute(
            `SELECT scope_key AS period,actor,action,event_at,new_batch_id AS batch_id
             FROM dashboard_domain_publication_history WHERE domain_key='position_daily'
             ORDER BY event_at DESC,publication_event_id DESC LIMIT 50`,
          );
          return rows.map(row => ({ period: row.period, user: row.actor, reportType: 'position',
            action: row.action, at: row.event_at, status: 'completed', batchId: row.batch_id }));
        });
        const local = [...jobs.values()].filter(job => job.user === session.user && job.status !== 'completed')
          .map(job => ({ reportType: 'position', at: new Date(job.updatedAt).toISOString(), status: job.status,
          error: job.error ?? null, period: job.dates.join(', ') }));
        return send(response, 200, { status: 'ok', records: [...local, ...history] });
      }
      if (url.pathname === '/api/admin/preview' && request.method === 'POST') {
        if (url.searchParams.get('type') !== 'position') return send(response, 422, { status: 'error', error: 'report_not_available' });
        const upload = await saveUpload(request);
        try {
          const preview = await withDb((connection, config) => previewWorkbook(upload.path, connection, { config, env }));
          if (preview.checksum !== upload.checksum) throw new Error('Checksum workbook tidak konsisten.');
          const token = randomBytes(24).toString('hex');
          previews.set(token, { sessionId: id, upload, preview, expiresAt: Date.now() + PREVIEW_MS, processing: false });
          return send(response, 200, { status: 'ok', previewId: token, filename: upload.filename, reportType: 'position', ...preview });
        } catch (error) { await rm(upload.directory, { recursive: true, force: true }); throw error; }
      }
      if (url.pathname === '/api/admin/commit' && request.method === 'POST') {
        const body = await readJson(request, 8192);
        const entry = previews.get(String(body.previewId ?? ''));
        if (!entry || entry.sessionId !== id || entry.expiresAt < Date.now() || entry.processing) {
          return send(response, 409, { status: 'error', error: 'preview_expired_or_busy' });
        }
        if (entry.preview.invalidRows || Object.keys(entry.preview.validationErrors).length) {
          return send(response, 422, { status: 'error', error: 'source_validation_failed' });
        }
        const current = await withDb(currentPositionDates);
        const sourceDates = Object.fromEntries(Object.entries(entry.preview.dates).map(([date, value]) => [date, value.rows]));
        const selected = validateDateDecisions(sourceDates, current.dates, body.decisions, body.confirmation, body.snapshotComplete);
        entry.processing = true;
        const jobId = randomBytes(24).toString('hex');
        const job = { id: jobId, user: session.user, sessionId: id, status: 'processing',
          phase: 'queued', processed: 0, total: entry.preview.totalRows,
          dates: selected.map(item => item.date), updatedAt: Date.now(), error: null, result: null };
        jobs.set(jobId, job);
        setImmediate(async () => {
          try {
            const config = getConfig(); assertAdminPositionTarget(config, env);
            job.result = await commitWorkbook({ filePath: entry.upload.path, preview: entry.preview,
              decisions: body.decisions, confirmation: body.confirmation, snapshotComplete: body.snapshotComplete, actor: session.user,
              pool: getPool(), config, env,
              progress: update => { Object.assign(job, update, { updatedAt: Date.now() }); },
            });
            job.status = 'completed';
            previews.delete(String(body.previewId));
            await rm(entry.upload.directory, { recursive: true, force: true });
          } catch (error) {
            job.status = 'failed';
            job.error = error?.code ? 'Penyimpanan MySQL gagal; periode aktif tidak diubah. Periksa log server yang aman.'
              : (error?.message || 'Penyimpanan gagal; periode aktif tidak diubah.');
            entry.processing = false;
          } finally { job.updatedAt = Date.now(); }
        });
        return send(response, 202, { status: 'processing', jobId });
      }
      if (url.pathname.startsWith('/api/admin/jobs/') && request.method === 'GET') {
        const job = jobs.get(url.pathname.slice('/api/admin/jobs/'.length));
        if (!job || job.sessionId !== id) return send(response, 404, { status: 'error', error: 'job_not_found' });
        return send(response, 200, { status: job.status, phase: job.phase,
          processed: job.processed, total: job.total, dates: job.dates, error: job.error, result: job.result });
      }
      return send(response, 404, { status: 'error', error: 'not_found' });
    } catch (error) {
      const code = error?.code;
      const isSql = typeof code === 'string' && /^(ER_|ECONN|ETIMEDOUT)/.test(code);
      const message = isSql ? 'Permintaan Admin gagal karena database tidak tersedia atau skemanya belum sesuai.'
        : (error?.message || 'Permintaan Admin gagal.');
      const forbidden = error?.name === 'AdminTargetError' || error?.name === 'AdminOriginError';
      return send(response, forbidden ? 403 : isSql ? 503 : 422,
        { status: 'error', error: error?.name === 'AdminTargetError' ? 'admin_target_not_allowed'
          : error?.name === 'AdminOriginError' ? 'admin_origin_not_allowed' : isSql ? 'database_unavailable' : 'admin_request_failed', message });
    }
  };
  handler.authorizeDataRequest = (request) => {
    const id = cookieId(request);
    const session = id && sessions.get(id);
    return Boolean(session && session.expiresAt > Date.now());
  };
  return handler;
}
