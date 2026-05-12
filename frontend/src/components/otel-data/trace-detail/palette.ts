// Stable color for a service name across renders. Hash → palette index. Same
// service always gets the same swatch so the breakdown bar matches the
// inline service labels in the waterfall.
const SERVICE_PALETTE = [
  '#7c5cff', '#3759d8', '#11845b', '#0c8aa4', '#d99100',
  '#c42a3f', '#7a2db8', '#1a8a7e', '#a84300', '#5c5c8a',
];

export const colorForService = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SERVICE_PALETTE[Math.abs(h) % SERVICE_PALETTE.length];
};
