import http from 'node:http';
import { GoogleAuth } from 'google-auth-library';
import { checkDatabaseConnection, closeDatabasePool, getDatabaseErrorInfo } from './db.js';
import { createFundingPositionHandler } from './funding-position-api.mjs';
import { createFundingReferenceHandler } from './funding-reference-api.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.APPRAISAL_PORT || 8787);
const SPREADSHEET_ID = process.env.APPRAISAL_SPREADSHEET_ID?.trim() || '';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_SHEETS_ATTEMPTS = 3;
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const DATA_CACHE_TTL_MS = 60 * 1000;

const MONTHS = new Map([
  ['Januari', '01'], ['Februari', '02'], ['Maret', '03'], ['April', '04'],
  ['Mei', '05'], ['Juni', '06'], ['Juli', '07'], ['Agustus', '08'],
  ['September', '09'], ['Oktober', '10'], ['November', '11'], ['Desember', '12'],
]);

const PROFILE_HEADERS = [
  'Nama RM', 'PN', 'Kode KC', 'Kantor Cabang', 'Kode Uker', 'Unit Kerja', 'Jabatan', 'JG',
];

const KPI_METRICS = [
  ['Daily Average Tabungan', 'Target Daily Average Tabungan', 'Daily Average Tabungan', '% Realisasi Daily Average Tabungan', 'Score Daily Average Tabungan'],
  ['Posisi Saldo Tabungan', 'Target Posisi Saldo Tabungan', 'Posisi Saldo Tabungan', '% Realisasi Posisi Saldo Tabungan', 'Score Posisi Saldo Tabungan'],
  ['Daily Average Giro Retail', 'Target Daily Average Giro Retail', 'Daily Average Giro Retail', '% Realisasi Daily Average Giro Retail', 'Score Daily Average Giro Retail'],
  ['Daily Average DPK Retail', 'Target Daily Average DPK Retail', 'Daily Average DPK Retail', '% Realisasi Daily Average DPK Retail', 'Score Daily Average DPK Retail'],
  ['New Account Payroll', 'Target New Account Payroll', 'New Account Payroll', '% Realisasi New Account Payroll', 'Score New Account Payroll'],
  ['Jumlah Merchant EDC Produktif', 'Target Jumlah Merchant EDC Produktif', 'Jumlah Merchant EDC Produktif', '% Realisasi Jumlah Merchant EDC Produktif', 'Score Jumlah Merchant EDC Produktif'],
  ['Jumlah Merchant QRIS Produktif', 'Target Jumlah Merchant QRIS Produktif', 'Jumlah Merchant QRIS Produktif', '% Realisasi Jumlah Merchant QRIS Produktif', 'Score Jumlah Merchant QRIS Produktif'],
  ['Daily Average CASA EDC Merchant', 'Target Daily Average CASA EDC Merchant', 'Daily Average CASA EDC Merchant', '% Realisasi Daily Average CASA EDC Merchant', 'Score Daily Average CASA EDC Merchant'],
  ['Sales Volume Merchant EDC', 'Target Sales Volume Merchant EDC', 'Sales Volume Merchant EDC', '% Realisasi Sales Volume Merchant EDC', 'Score Sales Volume Merchant EDC'],
  ['Sales Volume Merchant QRIS', 'Target Sales Volume Merchant QRIS', 'Sales Volume Merchant QRIS', '% Realisasi Sales Volume Merchant QRIS', 'Score Sales Volume Merchant QRIS'],
  ['Jumlah User Aktif BRImo', 'Target Jumlah User Aktif BRImo', 'Jumlah User Aktif BRImo', '% Realisasi Jumlah User Aktif BRImo', 'Score Jumlah User Aktif BRImo'],
  ['User Aktif QLOLA', 'Target User Aktif QLOLA', 'User Aktif QLOLA', '% Realisasi User Aktif QLOLA', 'Score User Aktif QLOLA'],
  ['Product Holding', 'Target Product Holding', 'Product Holding', '% Realisasi Product Holding', 'Score Product Holding'],
].map(([name, target, actual, realization, score]) => ({ name, target, actual, realization, score }));

const OUTPUT_HEADERS = [...PROFILE_HEADERS, ...KPI_METRICS.flatMap(({ target, actual, realization, score }) => [target, actual, realization, score]), 'Score', 'Tier'];
const auth = new GoogleAuth({ scopes: [SHEETS_SCOPE] });
let sourcesCache = null;
let sourcesCacheAt = 0;
let sourcesInFlight = null;
const dataCache = new Map();
const dataInFlight = new Map();
const mysqlPositionHandler = createFundingPositionHandler();
const mysqlReferenceHandler = createFundingReferenceHandler();

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function responseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || null;
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
}

function retryAfterMs(error, attempt) {
  const raw = responseHeader(error?.response?.headers, 'retry-after');
  if (raw !== null && raw !== undefined && String(raw).trim()) {
    const value = String(raw).trim();
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Math.max(0, Date.parse(value) - Date.now());
    if (Number.isFinite(delay)) return Math.min(60_000, delay);
  }
  return Math.min(10_000, 500 * (2 ** attempt));
}

function retryAfterHeader(error) {
  const raw = responseHeader(error?.response?.headers, 'retry-after');
  if (raw !== null && raw !== undefined && String(raw).trim()) {
    const value = String(raw).trim();
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return String(Math.ceil(Math.min(seconds, 60)));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return String(Math.ceil(Math.max(1, Math.min(60, (date - Date.now()) / 1000))));
  }
  return '5';
}

function sheetError(error, route) {
  const status = Number(error?.response?.status || error?.status || 0) || null;
  // Never log raw provider errors: they may contain user or credential context.
  const rawCode = error?.code || error?.cause?.code || null;
  const errorCode = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : null;
  console.error('[appraisal-api] Google Sheets request failed', { route, status, errorType: error?.name || 'Error', errorCode });
  if (status === 403 || status === 401) {
    return { statusCode: 502, body: { error: 'sheets_access_denied', message: 'Backend tidak memiliki scope atau izin baca Google Sheets.' } };
  }
  if (status === 404) {
    return { statusCode: 502, body: { error: 'spreadsheet_not_found', message: 'Spreadsheet atau sumber yang diminta tidak ditemukan.' } };
  }
  if (status === 429) {
    return {
      statusCode: 429,
      body: { error: 'rate_limited', message: 'Google Sheets sedang membatasi permintaan. Tunggu sebentar sebelum mencoba lagi.' },
      headers: { 'Retry-After': retryAfterHeader(error) },
    };
  }
  return { statusCode: 502, body: { error: 'sheets_unavailable', message: 'Google Sheets tidak dapat dibaca saat ini.' } };
}

async function sheetsGet(path, params = {}) {
  if (!SPREADSHEET_ID) throw new Error('Optional Appraisal source is not configured.');
  const client = await auth.getClient();
  const suffix = path ? `/${path}` : '';
  const url = new URL(`${API_BASE}/${SPREADSHEET_ID}${suffix}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < MAX_SHEETS_ATTEMPTS; attempt += 1) {
    try {
      const result = await client.request({ url: url.toString(), method: 'GET', retry: false });
      return result.data;
    } catch (error) {
      const status = Number(error?.response?.status || error?.status || 0);
      if (status !== 429 || attempt === MAX_SHEETS_ATTEMPTS - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, retryAfterMs(error, attempt)));
    }
  }
  throw new Error('Google Sheets request attempts exhausted.');
}

async function getSources() {
  if (sourcesCache && Date.now() - sourcesCacheAt < SOURCE_CACHE_TTL_MS) return sourcesCache;
  if (sourcesInFlight) return sourcesInFlight;
  sourcesInFlight = (async () => {
    const metadata = await sheetsGet('', {
      fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
    });
    const sources = (metadata.sheets || []).flatMap(({ properties }) => {
      const match = /^Master Data (Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember) (\d{4}) \((RO|KP)\)$/.exec(properties?.title || '');
      if (!match) return [];
      const [, monthName, year, type] = match;
      const month = MONTHS.get(monthName);
      return [{
        period: `${year}-${month}`,
        year: Number(year),
        month,
        type,
        sheetName: properties.title,
        sheetId: properties.sheetId,
        rowCount: properties.gridProperties?.rowCount ?? null,
      }];
    }).sort((a, b) => b.period.localeCompare(a.period) || a.type.localeCompare(b.type));
    sourcesCache = sources;
    sourcesCacheAt = Date.now();
    return sources;
  })();
  try {
    return await sourcesInFlight;
  } finally {
    sourcesInFlight = null;
  }
}

async function getSourceRecords(source) {
  const key = `${source.period}|${source.type}|${source.sheetId}`;
  const cached = dataCache.get(key);
  if (cached && Date.now() - cached.cachedAt < DATA_CACHE_TTL_MS) return cached.value;
  if (dataInFlight.has(key)) return dataInFlight.get(key);
  const range = `'${source.sheetName.replaceAll("'", "''")}'!A4:BP${source.rowCount || 386}`;
  const promise = (async () => {
    const result = await sheetsGet(`values/${encodeURIComponent(range)}`, { valueRenderOption: 'UNFORMATTED_VALUE' });
    const rows = result.values || [];
    const headers = rows[0] || [];
    const missingHeaders = OUTPUT_HEADERS.filter(header => !headers.includes(header));
    if (missingHeaders.length) return { schemaMismatch: true, range };
    const records = rows.slice(1).flatMap((values, index) => {
      const record = buildRecord(headers, values, index + 5);
      return record.PN !== null || record['Nama RM'] !== null ? [record] : [];
    });
    const value = { records, range };
    dataCache.set(key, { value, cachedAt: Date.now() });
    return value;
  })();
  dataInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    dataInFlight.delete(key);
  }
}

function parsePositiveInt(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function emptyToNull(value) {
  return value === undefined || value === '' ? null : value;
}

function buildRecord(headers, values, sourceRow) {
  const record = { sourceRow };
  for (const header of OUTPUT_HEADERS) {
    const index = headers.indexOf(header);
    const value = index === -1 ? undefined : emptyToNull(values[index]);
    record[header] = header === 'PN' && value !== null ? String(value) : value;
  }
  record.targetAvailability = Object.fromEntries(KPI_METRICS.map(({ name, target }) => [
    name,
    record[target] === null ? 'not_available' : 'available',
  ]));
  return record;
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  if (process.env.DASHBOARD_RUNTIME_ENV === 'production'
    && (requestUrl.pathname.startsWith('/api/funding/') || requestUrl.pathname.startsWith('/api/appraisal/')
      || requestUrl.pathname === '/api/health/database')) {
    sendJson(response, 403, { status: 'unavailable', error: 'legacy_data_api_disabled' });
    return;
  }
  if (requestUrl.pathname.startsWith('/api/funding/')) {
    const handled = await mysqlPositionHandler(request, response);
    if (handled === false) await mysqlReferenceHandler(request, response);
    return;
  }
  if (process.env.VITE_DASHBOARD_FUNDING_SOURCE === 'mysql' && requestUrl.pathname.startsWith('/api/appraisal/')) {
    await mysqlReferenceHandler(request, response);
    return;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed', message: 'Endpoint hanya menerima GET.' });
    return;
  }

  if (requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', service: 'appraisal-readonly', host: HOST });
    return;
  }

  if (requestUrl.pathname === '/api/health/database') {
    try {
      const databaseInfo = await checkDatabaseConnection();
      sendJson(response, 200, { status: 'ok', service: 'mysql', ...databaseInfo });
    } catch (error) {
      const safeError = getDatabaseErrorInfo(error);
      console.error('[dashboard-api] Database health check failed', {
        category: safeError.category,
        code: safeError.code,
      });
      sendJson(response, 503, {
        status: 'unavailable',
        service: 'mysql',
        error: safeError.category,
        ...(safeError.missingVariables ? { missingVariables: safeError.missingVariables } : {}),
      });
    }
    return;
  }

  if (requestUrl.pathname === '/api/appraisal/sources') {
    try {
      const sources = await getSources();
      sendJson(response, 200, { sources });
    } catch (error) {
      const failure = sheetError(error, 'sources');
      sendJson(response, failure.statusCode, failure.body, failure.headers);
    }
    return;
  }

  if (requestUrl.pathname === '/api/appraisal/data') {
    const period = requestUrl.searchParams.get('period');
    const type = requestUrl.searchParams.get('type');
    const limit = parsePositiveInt(requestUrl.searchParams.get('limit'), 200, 500);
    const offset = parsePositiveInt(requestUrl.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '') || !['RO', 'KP'].includes(type || '')) {
      sendJson(response, 400, { error: 'invalid_source', message: 'Gunakan period=YYYY-MM dan type=RO atau KP.' });
      return;
    }
    if (limit === null || offset === null) {
      sendJson(response, 400, { error: 'invalid_pagination', message: 'Parameter limit/offset tidak valid.' });
      return;
    }

    try {
      const sources = await getSources();
      const source = sources.find(item => item.period === period && item.type === type);
      if (!source) {
        sendJson(response, 404, { error: 'source_not_found', message: 'Periode dan sumber tersebut tidak tersedia di spreadsheet.' });
        return;
      }
      const result = await getSourceRecords(source);
      if (result.schemaMismatch) {
        sendJson(response, 502, { error: 'source_schema_mismatch', message: 'Header sumber appraisal tidak cocok dengan skema yang diaudit.' });
        return;
      }
      const { records, range } = result;
      const page = records.slice(offset, offset + limit);
      sendJson(response, 200, {
        source: { ...source, range, valueRenderOption: 'UNFORMATTED_VALUE' },
        recordCount: records.length,
        pagination: { limit, offset, returned: page.length },
        records: page,
      });
    } catch (error) {
      const failure = sheetError(error, 'data');
      sendJson(response, failure.statusCode, failure.body, failure.headers);
    }
    return;
  }

  sendJson(response, 404, { error: 'not_found', message: 'Endpoint tidak ditemukan.' });
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('APPRAISAL_PORT harus berupa port TCP yang valid.');
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    console.error('[appraisal-api] Unhandled request failure', { errorType: error?.name || 'Error' });
    if (!response.headersSent) sendJson(response, 500, { error: 'internal_error', message: 'Permintaan tidak dapat diproses.' });
    else response.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[appraisal-api] Listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal) {
  console.log(`[dashboard-api] Received ${signal}; closing server and database pool.`);
  server.close(async () => {
    await closeDatabasePool();
    process.exit(0);
  });
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
