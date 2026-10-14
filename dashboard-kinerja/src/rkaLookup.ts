export type RkaRow = Record<string, unknown> & {
  'KODE UKER'?: string | number | null;
  'MATA ANGGARAN'?: string | null;
};

const monthColumns: Array<[string, string]> = [
  ['JAN', 'JAN'], ['FEB', 'FEB'], ['MAR', 'MAR'], ['APR', 'APR'],
  ['MAY', 'MEI'], ['JUN', 'JUN'], ['JUL', 'JUL'], ['AUG', 'AGU'],
  ['SEP', 'SEP'], ['OCT', 'OKT'], ['NOV', 'NOV'], ['DEC', 'DES']
];

const parseRkaAmount = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;

  const parsed = Number(value.trim().replace(/\./g, '').replace(/,/g, '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

export const getRkaValFromRow = (row: RkaRow, monthIndex: number): number | null => {
  const columns = monthColumns[monthIndex];
  if (!columns) return null;
  return parseRkaAmount(row[columns[0]]) ?? parseRkaAmount(row[columns[1]]);
};

const getExactTargetRow = (rows: RkaRow[], ukerCode: string | number, targetCategory: string) => {
  const normalizedCode = String(ukerCode).trim();
  const normalizedCategory = targetCategory.trim().toUpperCase();
  if (!normalizedCode || !normalizedCategory) return null;

  const matches = rows.filter(row =>
    String(row['KODE UKER'] ?? '').trim() === normalizedCode
    && String(row['MATA ANGGARAN'] ?? '').trim().toUpperCase() === normalizedCategory
  );
  return matches.length === 1 ? matches[0] : null;
};

export const getUkerRkaVal = (
  rows: RkaRow[],
  ukerCode: string | number,
  targetCategory: string,
  monthIndex: number
): number | null => {
  const row = getExactTargetRow(rows, ukerCode, targetCategory);
  return row ? getRkaValFromRow(row, monthIndex) : null;
};

export const getUkerRkaValDec = (
  rows: RkaRow[],
  ukerCode: string | number,
  targetCategory: string
): number | null => {
  const row = getExactTargetRow(rows, ukerCode, targetCategory);
  if (!row) return null;

  return parseRkaAmount(row.DEC) ?? parseRkaAmount(row.DES);
};
