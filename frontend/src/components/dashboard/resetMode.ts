// Pure function mirroring the backend's mode decision in
// POST /api/lifecycle/reset-onboarding: an empty selection or a selection
// that covers every connection is a full reset (the historical
// wipe-everything-and-return-to-Step-1 behavior); any strict subset is a
// partial reset (only the selected connections are removed, the rest and
// the wizard state are left alone).
export function computeResetMode(selectedIds: string[], allIds: string[]): 'full' | 'partial' {
  if (!selectedIds.length) return 'full';
  const set = new Set(selectedIds);
  return allIds.every((id) => set.has(id)) ? 'full' : 'partial';
}
