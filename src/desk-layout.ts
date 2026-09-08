/// Restore saved desk order, remove vanished entries, and append newcomers. Keep the calculation pure for tests.
export function arrange(alive: string[], saved: string[]): string[] {
  const live = new Set(alive);
  const kept = [...new Set(saved.filter((id) => live.has(id)))];
  const seen = new Set(kept);
  return [...kept, ...alive.filter((id) => !seen.has(id))];
}
