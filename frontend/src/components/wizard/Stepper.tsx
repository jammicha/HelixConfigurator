import React from 'react';
import { Check } from 'lucide-react';

type WizardStep = { n: number; label: string };

type Props = {
  current: number;
  steps: WizardStep[];
  onJump: (step: number) => void;
};

export const Stepper: React.FC<Props> = ({ current, steps, onJump }) => (
  <div className="flex items-center justify-between gap-2 px-1">
    {steps.map((s, idx) => {
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
              className={`w-7 h-7 rounded inline-flex items-center justify-center text-tiny font-semibold border ${
                isCurrent
                  ? 'bg-primary border-primary text-white'
                  : isCompleted
                    ? 'bg-success border-success text-white'
                    : 'bg-gray-1000 border-gray-700 text-gray-400'
              }`}
            >
              {isCompleted ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : s.n}
            </span>
            <span className={`text-tiny font-semibold uppercase tracking-wider ${isCurrent ? 'text-gray-100' : isCompleted ? 'text-gray-300' : 'text-gray-500'}`}>
              {s.label}
            </span>
          </button>
          {idx < steps.length - 1 && (
            <span className={`flex-1 h-px ${current > s.n ? 'bg-success/60' : 'bg-gray-800'}`} />
          )}
        </React.Fragment>
      );
    })}
  </div>
);
