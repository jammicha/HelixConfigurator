import React from 'react';
import { ArrowRight, Boxes, ExternalLink } from 'lucide-react';
import { Layer2Synthetic } from './Layer2Synthetic';
import { Layer3Instrument } from './Layer3Instrument';

export const StepZero: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100">
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Start from zero</h1>
          <p className="text-base text-gray-400 leading-relaxed">
            Three ways to see Helix without instrumenting your own apps first: a 60-second
            synthetic scenario, the upstream OpenTelemetry demo, or guides for instrumenting
            your own.
          </p>
        </header>

        <Layer2Synthetic />

        <Layer3Instrument />

        {/* Pointer to the upstream OTel Demo. Static content; no backend wiring. */}
        <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded bg-gray-900 border border-gray-800 flex items-center justify-center">
              <Boxes className="w-5 h-5 text-blue-300" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-tiny uppercase tracking-wider text-blue-300 mb-1">Real apps, real SDKs</div>
              <h2 className="text-h3 font-semibold text-gray-100 mb-2">Try the OpenTelemetry demo against Helix</h2>
              <p className="text-base text-gray-300 mb-3 leading-relaxed">
                A polyglot demo app (~15 services across Java, .NET, Python, Node, Go, Rust)
                wired with real SDKs. Run it locally, then point its collector at{' '}
                <code className="font-mono text-sm bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-gray-200">
                  http://helix-gateway:4318
                </code>.
              </p>
              <a
                href="https://opentelemetry.io/docs/demo/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-base text-link hover:underline"
              >
                Set up the OpenTelemetry demo <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </section>

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
