import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message?: string };

// Top-level safety net. This is a diagnostics tool people open *when things
// are already broken*, so a single render-time throw must not blank the whole
// app to a white screen. Mounted around the routed content in main.tsx.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // No server round-trip by design — last-resort console log for the dev/operator.
    console.error('[ErrorBoundary] render error:', error, info.componentStack);
    this.setState({ message: error.message });
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex items-center justify-center h-screen w-full bg-gray-900">
        <div
          className="bg-gray-1000 border border-gray-800 rounded-lg shadow-4 p-8 w-full max-w-md space-y-5"
          role="alert"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-danger-text flex-shrink-0" aria-hidden="true" />
            <h1 className="text-white font-semibold text-xl">Something went wrong</h1>
          </div>
          <p className="text-sm text-gray-300">
            The page hit an unexpected error and couldn&apos;t continue. Reloading usually clears it.
          </p>
          {this.state.message && (
            <pre className="text-xs text-gray-400 bg-gray-900 border border-gray-800 rounded p-3 overflow-x-auto whitespace-pre-wrap">
              {this.state.message}
            </pre>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full bg-primary hover:bg-[#3006c2] text-white px-6 py-2.5 rounded font-semibold transition-all flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
