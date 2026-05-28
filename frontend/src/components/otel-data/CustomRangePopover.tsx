import React, { useState } from 'react';

// Format a Date in the local timezone for an <input type="datetime-local">.
// toISOString gives UTC; the input control wants local. Padding via slice.
const toLocalInputValue = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const CustomRangePopover: React.FC<{
  initial: { sinceMs: number; untilMs: number } | null;
  onApply: (sinceMs: number, untilMs: number) => void;
  onClear: () => void;
  onClose: () => void;
}> = ({ initial, onApply, onClear, onClose }) => {
  const now = new Date();
  const initialStart = initial ? new Date(initial.sinceMs) : new Date(now.getTime() - 60 * 60 * 1000);
  const initialEnd = initial ? new Date(initial.untilMs) : now;
  const [start, setStart] = useState(toLocalInputValue(initialStart));
  const [end, setEnd] = useState(toLocalInputValue(initialEnd));
  const [err, setErr] = useState('');
  const apply = () => {
    const s = new Date(start).getTime();
    const u = new Date(end).getTime();
    if (!isFinite(s) || !isFinite(u)) return setErr('Invalid date');
    if (u <= s) return setErr('End must be after start');
    onApply(s, u);
  };
  return (
    <div className="absolute right-0 top-full mt-2 w-72 z-50 bg-gray-1000 border border-gray-800 rounded shadow-4 p-3 normal-case tracking-normal font-normal">
      <div className="text-tiny font-semibold text-gray-300 uppercase tracking-wider mb-2">Custom time window</div>
      <label className="block text-tiny text-gray-400 mb-2">
        From
        <input
          type="datetime-local"
          value={start}
          onChange={(e) => { setStart(e.target.value); setErr(''); }}
          className="mt-1 block w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-link"
        />
      </label>
      <label className="block text-tiny text-gray-400 mb-2">
        To
        <input
          type="datetime-local"
          value={end}
          onChange={(e) => { setEnd(e.target.value); setErr(''); }}
          className="mt-1 block w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-link"
        />
      </label>
      {err && <div className="text-tiny text-danger-text mb-2">{err}</div>}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onClear}
          className="text-tiny text-gray-400 hover:text-gray-200 font-semibold"
        >Clear</button>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="text-tiny text-gray-400 hover:text-gray-200 px-2 py-1 rounded font-semibold"
          >Cancel</button>
          <button
            onClick={apply}
            className="text-tiny bg-primary hover:bg-primary-hover text-white px-3 py-1 rounded font-semibold"
          >Apply</button>
        </div>
      </div>
    </div>
  );
};
