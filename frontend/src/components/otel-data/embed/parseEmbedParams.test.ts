import { describe, it, expect } from 'vitest';
import { parseEmbedParams } from './parseEmbedParams';

describe('parseEmbedParams', () => {
  it('reads trace and span from the query string', () => {
    expect(parseEmbedParams('?trace=abc&span=s1')).toEqual({ traceId: 'abc', spanId: 's1' });
  });
  it('returns nulls when params are missing or blank', () => {
    expect(parseEmbedParams('?trace=&span=')).toEqual({ traceId: null, spanId: null });
    expect(parseEmbedParams('')).toEqual({ traceId: null, spanId: null });
  });
});
