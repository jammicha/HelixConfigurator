// "Which install am I looking at?" for the settings drawer footer.
//
// The browser cannot tell a packaged app from a repo checkout running
// `node index.js` — both serve the same UI on the same port — and that
// ambiguity is genuinely confusing when a machine has both. The update
// capability probe already classifies the install to decide whether
// self-update is possible, so this reuses that classification as a plain
// label. Pure: no React, no I/O.

type Mode = string | null | undefined;

// `windows` and `native` are both packaged installs; the modes differ only
// because the Windows swap is file-locked and self-update is not implemented
// there. That distinction matters to the update button, not to "what am I
// running", so both read as the package here.
const MODE_LABELS: Record<string, string> = {
  native: 'native package',
  windows: 'native package',
  docker: 'Docker image',
  'dev-checkout': 'source checkout',
};

export function formatInstallLabel({ version, mode }: { version?: string | null; mode?: Mode }): string {
  if (!version) return '';
  const kind = mode ? MODE_LABELS[mode] : undefined;
  // An unrecognised mode gets no label rather than a guess: a wrong claim
  // about which install you are on is worse than no claim.
  return kind ? `v${version} · ${kind}` : `v${version}`;
}
