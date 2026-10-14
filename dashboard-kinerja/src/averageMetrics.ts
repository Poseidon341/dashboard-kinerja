/** Average is valid only when every required daily snapshot is present. */
export const calculateCompleteDailyAverage = (
  dailyTotals: ReadonlyMap<number, number>,
  requiredDays: number
): number | null => {
  if (!Number.isInteger(requiredDays) || requiredDays < 1) return null;

  let total = 0;
  for (let day = 1; day <= requiredDays; day += 1) {
    const value = dailyTotals.get(day);
    if (value === undefined || !Number.isFinite(value)) return null;
    total += value;
  }

  return total / requiredDays;
};
