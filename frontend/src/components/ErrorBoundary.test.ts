import { describe, it, expect } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('derives error state from a thrown error so the fallback renders', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom'))).toEqual({ hasError: true });
  });
});
