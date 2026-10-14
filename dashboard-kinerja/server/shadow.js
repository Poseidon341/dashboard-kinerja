import { pathToFileURL } from 'node:url';
import { closeDatabasePool } from './db.js';
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

export function startShadowServer({ port = getShadowPort() } = {}) {
  const server = createShadowServer();
  server.listen(port, SHADOW_HOST, () => {
    console.log(`[shadow-api] Listening on http://${SHADOW_HOST}:${port}`);
  });
  const shutdown = () => server.close(async () => { await closeDatabasePool(); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShadowServer();
}
