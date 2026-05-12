import React from 'react';

type Props = {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  /** When true, also fills below the line at low opacity. ADAPT-flat by default — no fill. */
  filled?: boolean;
};

/**
 * Compact SVG sparkline. No axis, no labels — meant to be embedded inside a
 * stat card where the headline number is the focus and the sparkline just
 * shows shape. Calm and flat per ADAPT: 1.5px stroke, no fill by default.
 */
export const Sparkline: React.FC<Props> = ({
  data,
  width = 120,
  height = 28,
  stroke = '#3759d8', // active blue
  filled = false,
}) => {
  if (!data.length) return <svg width={width} height={height} />;
  const max = Math.max(1, ...data);
  const min = 0;
  const range = Math.max(1, max - min);
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((v, i) => `${i * stepX},${height - ((v - min) / range) * (height - 2) - 1}`);
  const path = `M ${points.join(' L ')}`;
  const areaPath = filled ? `${path} L ${width},${height} L 0,${height} Z` : '';
  return (
    <svg width={width} height={height} className="block">
      {filled && <path d={areaPath} fill={stroke} fillOpacity={0.12} />}
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
