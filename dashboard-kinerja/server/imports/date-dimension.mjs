const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoUtcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function dateDimensionRow(value) {
  const dateText = String(value ?? '');
  const match = DATE_RE.exec(dateText);
  if (!match) throw new Error('Tanggal staging bukan format YYYY-MM-DD yang valid.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || isoUtcDate(year, month, day) !== dateText) {
    throw new Error('Tanggal staging tidak valid secara kalender.');
  }
  return {
    calendar_date: dateText,
    calendar_year: year,
    calendar_month: month,
    calendar_day: day,
    month_start: `${match[1]}-${match[2]}-01`,
    month_end: isoUtcDate(year, month + 1, 0),
  };
}

export function planDateDimensionRows(requiredDates, existingRows) {
  const expected = requiredDates.map(dateDimensionRow);
  const existing = new Map(existingRows.map((row) => [String(row.calendar_date), row]));
  const missing = [];
  const conflicts = [];
  const present = [];
  for (const row of expected) {
    const current = existing.get(row.calendar_date);
    if (!current) missing.push(row);
    else {
      const same = ['calendar_year', 'calendar_month', 'calendar_day', 'month_start', 'month_end']
        .every((field) => String(current[field]) === String(row[field]));
      if (same) present.push(row.calendar_date);
      else conflicts.push(row.calendar_date);
    }
  }
  return { required: expected, present, missing, conflicts };
}

export function assertDateDimensionTarget(config) {
  if (!['127.0.0.1', 'localhost'].includes(String(config?.host ?? '').toLowerCase())
    || Number(config?.port) !== 3308 || config?.database !== 'dashboard_funding_test') {
    const error = new Error('Pengisian dimensi tanggal hanya diizinkan pada MySQL lokal dashboard_funding_test port 3308.');
    error.name = 'ImportTargetMismatchError';
    throw error;
  }
}
