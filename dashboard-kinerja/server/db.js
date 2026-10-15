import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(projectRoot, '.env');
const REQUIRED_VARIABLES = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'];
let pool;
let localEnvironmentLoaded = false;

export class DatabaseConfigurationError extends Error {
  constructor(missingVariables) {
    super('Konfigurasi MySQL belum lengkap.');
    this.name = 'DatabaseConfigurationError';
    this.missingVariables = missingVariables;
  }
}

export function getDatabaseConfig(env = process.env) {
  if (env === process.env && !localEnvironmentLoaded && existsSync(envFile)) {
    if (typeof process.loadEnvFile !== 'function') {
      const error = new DatabaseConfigurationError([]);
      error.code = 'ENV_FILE_UNSUPPORTED';
      throw error;
    }
    try {
      process.loadEnvFile(envFile);
      localEnvironmentLoaded = true;
    } catch {
      const error = new DatabaseConfigurationError([]);
      error.code = 'INVALID_ENV_FILE';
      throw error;
    }
  } else if (env === process.env) {
    localEnvironmentLoaded = true;
  }
  const missingVariables = REQUIRED_VARIABLES.filter((name) => (
    env[name] === undefined || (name !== 'MYSQL_PASSWORD' && String(env[name]).trim() === '')
  ));
  if (missingVariables.length) throw new DatabaseConfigurationError(missingVariables);

  const port = Number(env.MYSQL_PORT);
  if (!/^\d+$/.test(String(env.MYSQL_PORT)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('MYSQL_PORT harus berupa nomor port yang valid.');
    error.name = 'DatabaseConfigurationError';
    error.code = 'INVALID_MYSQL_PORT';
    throw error;
  }

  const connectionLimit = env.MYSQL_CONNECTION_LIMIT === undefined ? 5 : Number(env.MYSQL_CONNECTION_LIMIT);
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 50) {
    const error = new Error('MYSQL_CONNECTION_LIMIT harus berupa bilangan bulat 1 sampai 50.');
    error.name = 'DatabaseConfigurationError';
    error.code = 'INVALID_MYSQL_CONNECTION_LIMIT';
    throw error;
  }

  const host = String(env.MYSQL_HOST).trim();
  let ssl;
  if (env.MYSQL_SSL_CA_FILE) {
    try { ssl = { ca: readFileSync(String(env.MYSQL_SSL_CA_FILE)), rejectUnauthorized: true }; }
    catch {
      const error = new DatabaseConfigurationError([]);
      error.code = 'INVALID_MYSQL_SSL_CA_FILE';
      throw error;
    }
  }
  if (env.DASHBOARD_RUNTIME_ENV === 'production'
    && !['127.0.0.1', 'localhost'].includes(host.toLowerCase()) && !ssl) {
    const error = new DatabaseConfigurationError([]);
    error.code = 'MYSQL_TLS_REQUIRED';
    throw error;
  }

  return {
    host,
    port,
    database: String(env.MYSQL_DATABASE).trim(),
    user: String(env.MYSQL_USER),
    password: String(env.MYSQL_PASSWORD),
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    connectTimeout: 5000,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    ...(ssl ? { ssl } : {}),
  };
}

export function getDatabasePool() {
  if (pool) return pool;
  pool = mysql.createPool(getDatabaseConfig());
  return pool;
}

export async function checkDatabaseConnection() {
  const config = getDatabaseConfig();
  const connection = await getDatabasePool().getConnection();
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version, DATABASE() AS database_name');
    const result = rows[0] ?? {};
    if (result.database_name !== config.database) {
      const error = new Error('Database aktif berbeda dari konfigurasi yang diminta.');
      error.name = 'DatabaseSelectionError';
      error.code = 'DATABASE_SELECTION_MISMATCH';
      throw error;
    }
    return { version: result.version ?? null, database: result.database_name ?? null };
  } finally {
    connection.release();
  }
}

export function getDatabaseErrorInfo(error) {
  if (error?.name === 'DatabaseSelectionError') {
    return { category: 'database_mismatch', code: 'DATABASE_SELECTION_MISMATCH' };
  }
  if (error instanceof DatabaseConfigurationError || error?.name === 'DatabaseConfigurationError') {
    return {
      category: error.code ? 'invalid_configuration' : 'not_configured',
      code: error.code || null,
      missingVariables: Array.isArray(error.missingVariables) ? error.missingVariables : undefined,
    };
  }
  const rawCode = error?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : null;
  return { category: 'connection_failed', code };
}

export async function closeDatabasePool() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
