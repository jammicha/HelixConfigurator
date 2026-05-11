import React from 'react';

const STEPS = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Exporter' },
  { n: 3, label: 'Connect' },
  { n: 4, label: 'Verify' },
];

type Props = {
  current: number;
  onJump: (step: number) => void;
};

export const Stepper: React.FC<Props> = ({ current, onJump }) => (
  <div className="flex items-center justify-between gap-2 px-1">
    {STEPS.map((s, idx) => {
      const isCurrent = current === s.n;
      const isCompleted = current > s.n;
      const clickable = s.n <= current;
      return (
        <React.Fragment key={s.n}>
          <button
            onClick={() => clickable && onJump(s.n)}
            disabled={!clickable}
            className={`flex items-center gap-2 ${clickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-tiny font-semibold border ${
                isCurrent
                  ? 'bg-primary border-primary text-white'
                  : isCompleted
                    ? 'bg-success border-success text-white'
                    : 'bg-gray-1000 border-gray-700 text-gray-400'
              }`}
            >
              {isCompleted ? '✓' : s.n}
            </span>
            <span className={`text-tiny font-semibold uppercase tracking-wider ${isCurrent ? 'text-gray-100' : isCompleted ? 'text-gray-300' : 'text-gray-500'}`}>
              {s.label}
            </span>
          </button>
          {idx < STEPS.length - 1 && (
            <span className={`flex-1 h-px ${current > s.n ? 'bg-success/60' : 'bg-gray-800'}`} />
          )}
        </React.Fragment>
      );
    })}
  </div>
);
