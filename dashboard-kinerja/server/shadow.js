import { pathToFileURL } from 'node:url';
import { closeDatabasePool, checkRuntimeDatabase, getHostingErrorInfo } from './db.js';
import { createShadowServer } from './shadow-master-api.mjs';

export const SHADOW_HOST = '127.0.0.1';
export const DEFAULT_SHADOW_PORT = 8788;

export function getShadowPort(env = process.env) {
  const value = env.SHADOW_API_PORT ?? String(DEFAULT_SHADOW_PORT);
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('SHADOW_API_PORT harus berupa port TCP yang valid.');
    error.code = 'INVALID_SHADOW_API_PORT';
    throw error;
  }
  return port;
}

export async function startShadowServer({
  port, checkTarget = checkRuntimeDatabase, createServer = createShadowServer,
  closePool = closeDatabasePool,
} = {}) {
  try {
    // Loads local environment in development; production uses systemd EnvironmentFile.
    // Do not open the HTTP port until config AND DATABASE()/@@port are verified.
    await checkTarget();
    const listenPort = getShadowPort(port === undefined ? process.env : { SHADOW_API_PORT: String(port) });
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, SHADOW_HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    console.log(`[shadow-api] Listening on http://${SHADOW_HOST}:${listenPort}`);
    const shutdown = () => server.close(async () => { await closePool(); });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.once('close', () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    });
    return server;
  } catch (error) {
    await closePool();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShadowServer().catch((error) => {
    console.error(JSON.stringify({ status: 'error', service: 'shadow-api', ...getHostingErrorInfo(error) }));
    process.exitCode = 1;
  });
}
