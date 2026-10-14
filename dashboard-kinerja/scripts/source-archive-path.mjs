import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_ARCHIVE_DIR = path.join(PROJECT_ROOT, 'data', 'source-archive');

export function sourceArchivePath(...parts) {
  const base = process.env.DASHBOARD_SOURCE_ARCHIVE_DIR
    ? path.resolve(process.env.DASHBOARD_SOURCE_ARCHIVE_DIR)
    : SOURCE_ARCHIVE_DIR;
  return path.join(base, ...parts);
}
