import React from 'react';
import { ArrowRight } from 'lucide-react';
import { Layer2Synthetic } from './Layer2Synthetic';
import { Layer3Instrument } from './Layer3Instrument';

export const StepZero: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100">
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Start from zero</h1>
          <p className="text-sm text-gray-400">
            Get telemetry flowing into Helix without instrumenting your apps. Click the
            button below and the configurator will start generating realistic synthetic
            traffic on your behalf.
          </p>
        </header>

        <Layer2Synthetic />

        <Layer3Instrument />

        <footer className="pt-4 border-t border-gray-800">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100"
          >
            Continue to the full wizard <ArrowRight className="w-4 h-4" />
          </a>
        </footer>
      </main>
    </div>
  );
};
