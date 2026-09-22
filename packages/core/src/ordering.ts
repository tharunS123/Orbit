import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Fractional ordering keys. Items sort by (position, id). Inserting between two neighbours
 * only writes the moved item — no renumbering. Concurrent inserts at the same spot may produce
 * equal keys; the id tie-break keeps order deterministic and `planMove` re-keys a neighbour
 * when an insert must land between two equal keys.
 */

export interface Positioned {
  id: string;
  position: string;
}

export function comparePositioned(a: Positioned, b: Positioned): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortByPosition<T extends Positioned>(items: readonly T[]): T[] {
  return [...items].sort(comparePositioned);
}

/** Key strictly between `before` and `after` (either may be null for open ends). */
export function positionBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    // Degenerate neighbours (equal keys from concurrent inserts): go just after `before`.
    return generateKeyBetween(before, null);
  }
  return generateKeyBetween(before, after);
}

export function positionsBetween(before: string | null, after: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (before !== null && after !== null && before >= after) return generateNKeysBetween(before, null, n);
  return generateNKeysBetween(before, after, n);
}

export const firstPosition = (): string => generateKeyBetween(null, null);

export function positionAtEnd(items: readonly Positioned[]): string {
  const sorted = sortByPosition(items);
  return positionBetween(sorted.at(-1)?.position ?? null, null);
}

export function positionAtStart(items: readonly Positioned[]): string {
  const sorted = sortByPosition(items);
  return positionBetween(null, sorted[0]?.position ?? null);
}

export interface PositionUpdate {
  id: string;
  position: string;
}

/**
 * Compute the position updates to move `ids` (in the given order) so they sit at `toIndex` of
 * the list obtained after removing them. Returns updates for the moved items and, when the
 * target neighbours collide, for one neighbour as well.
 */
export function planMove(
  items: readonly Positioned[],
  ids: readonly string[],
  toIndex: number,
): PositionUpdate[] {
  const moving = new Set(ids);
  const rest = sortByPosition(items).filter((i) => !moving.has(i.id));
  const index = Math.max(0, Math.min(toIndex, rest.length));
  const prev = rest[index - 1] ?? null;
  const next = rest[index] ?? null;
  const updates: PositionUpdate[] = [];

  if (prev && next && prev.position >= next.position) {
    // Re-key `next` (and following equal keys) so there is room.
    const after = rest.slice(index).find((i) => i.position > prev.position) ?? null;
    const equalRun = rest.slice(index, after ? rest.indexOf(after) : undefined);
    const fresh = positionsBetween(prev.position, after?.position ?? null, equalRun.length + ids.length);
    const movedKeys = fresh.slice(0, ids.length);
    ids.forEach((id, i) => updates.push({ id, position: movedKeys[i]! }));
    equalRun.forEach((item, i) => updates.push({ id: item.id, position: fresh[ids.length + i]! }));
    return updates;
  }

  const keys = positionsBetween(prev?.position ?? null, next?.position ?? null, ids.length);
  ids.forEach((id, i) => updates.push({ id, position: keys[i]! }));
  return updates;
}
