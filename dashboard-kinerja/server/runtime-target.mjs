// Runtime API target policy. Importer CLI guards remain independent and test-only.
export const DEVELOPMENT_TARGET = Object.freeze({ port: 3308, database: 'dashboard_funding_test' });

export class RuntimeTargetError extends Error {
  constructor() {
    super('Target database runtime tidak diizinkan.');
    this.name = 'RuntimeTargetError';
    this.code = 'RUNTIME_TARGET_NOT_ALLOWED';
  }
}

function validPort(value) {
  const port = Number(value);
  return /^\d+$/.test(String(value ?? '')) && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function resolveRuntimeTarget(config, env = process.env) {
  const mode = env.DASHBOARD_RUNTIME_ENV || 'development';
  const host = String(config?.host ?? '').trim().toLowerCase();
  const port = Number(config?.port);
  const database = String(config?.database ?? '').trim();
  if (mode === 'development') {
    if (!['127.0.0.1', 'localhost'].includes(host)
      || port !== DEVELOPMENT_TARGET.port || database !== DEVELOPMENT_TARGET.database) {
      throw new RuntimeTargetError();
    }
    return { mode, host, port, database };
  }
  if (mode !== 'production') throw new RuntimeTargetError();

  // Deliberately separate from MYSQL_*: production cannot be enabled just by
  // pointing the connection at another database. No wildcard or empty value.
  const allowedHost = String(env.DASHBOARD_PRODUCTION_DB_HOST ?? '').trim().toLowerCase();
  const allowedPort = env.DASHBOARD_PRODUCTION_DB_PORT;
  const allowedDatabase = String(env.DASHBOARD_PRODUCTION_DB_NAME ?? '').trim();
  if (!allowedHost || /\s|[*\/]/.test(allowedHost) || !validPort(allowedPort)
    || !/^[A-Za-z0-9_]+$/.test(allowedDatabase)
    || host !== allowedHost || port !== Number(allowedPort) || database !== allowedDatabase) {
    throw new RuntimeTargetError();
  }
  return { mode, host, port, database };
}

export async function assertActualRuntimeTarget(connection, config, env = process.env) {
  const target = resolveRuntimeTarget(config, env);
  const [rows] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (rows?.[0]?.database_name !== target.database || Number(rows?.[0]?.server_port) !== target.port) {
    throw new RuntimeTargetError();
  }
  return target;
}
