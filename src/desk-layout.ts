/// A ordem da mesa: a guardada, sem quem já foi, e quem chegou no fim. Pura,
/// fora de `desk.ts`, para o teste não arrastar a tela junto.
export function arrange(alive: string[], saved: string[]): string[] {
  const live = new Set(alive);
  const kept = [...new Set(saved.filter((id) => live.has(id)))];
  const seen = new Set(kept);
  return [...kept, ...alive.filter((id) => !seen.has(id))];
}
