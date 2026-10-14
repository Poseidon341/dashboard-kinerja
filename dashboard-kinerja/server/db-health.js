import { checkDatabaseConnection, getDatabaseErrorInfo } from './db.js';

try {
  const result = await checkDatabaseConnection();
  console.log(JSON.stringify({ status: 'ok', service: 'mysql', ...result }));
} catch (error) {
  const safeError = getDatabaseErrorInfo(error);
  console.error(JSON.stringify({
    status: 'unavailable',
    service: 'mysql',
    error: safeError.category,
    code: safeError.code,
    ...(safeError.missingVariables ? { missingVariables: safeError.missingVariables } : {}),
  }));
  process.exitCode = 1;
}
