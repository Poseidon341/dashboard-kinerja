import { checkRuntimeDatabase, closeDatabasePool, getHostingErrorInfo } from '../server/db.js';

try {
  const target = await checkRuntimeDatabase();
  console.log(JSON.stringify({ status: 'ok', service: 'mysql', ...target, readOnly: true }));
} catch (error) {
  console.error(JSON.stringify({ status: 'error', service: 'mysql', ...getHostingErrorInfo(error) }));
  process.exitCode = 1;
} finally {
  await closeDatabasePool();
}
