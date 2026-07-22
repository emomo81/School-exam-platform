import { createHash } from "node:crypto";

/**
 * Deterministic per-attempt shuffle (PRD §4.2). Ordering is a stable function
 * of (seed, item id), so a student sees the same order on every reload/resume,
 * but different students (different attempt ids) see different orders.
 */
function sortKey(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

export function shuffleBySeed<T extends { id: string }>(seed: string, items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ka = sortKey(seed, a.id);
    const kb = sortKey(seed, b.id);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Ordered list of ids for the attempt's shuffled sequence (used for backtracking). */
export function shuffledIdOrder(seed: string, ids: string[]): string[] {
  return shuffleBySeed(
    seed,
    ids.map((id) => ({ id })),
  ).map((x) => x.id);
}
