export type PositionDataset<T> = { scope: string; rows: T[] };

export const EMPTY_POSITION_ROWS = Object.freeze([]) as unknown as any[];

export function positionRowsForScope<T>(dataset: PositionDataset<T>, scope: string): T[] {
  return dataset.scope === scope ? dataset.rows : EMPTY_POSITION_ROWS;
}

export function activatePositionDataset<T>(
  scope: string,
  rows: T[],
  derivedCache: { clear(): void },
): PositionDataset<T> {
  derivedCache.clear();
  return { scope, rows };
}
