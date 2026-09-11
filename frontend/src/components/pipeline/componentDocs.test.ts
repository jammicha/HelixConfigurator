import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { resolveDoc } from './componentDocs';
import { baseType } from './pipelineGraph';

describe('resolveDoc', () => {
  it('resolves the Helix exporter by name to a Helix-egress doc', () => {
    const doc = resolveDoc('otlphttp/bmchelix');
    expect(doc.role.toLowerCase()).toContain('helix');
  });
  it('resolves the local viewer exporter by name', () => {
    const doc = resolveDoc('otlphttp/helix_local_viewer');
    expect(doc.role.toLowerCase()).toMatch(/viewer|local/);
  });
  it('attaches a gRPC vs HTTP concept card to otlp', () => {
    const doc = resolveDoc('otlp');
    expect(doc.concept?.title).toMatch(/gRPC/i);
  });
  it('attaches a sampling concept card to tail_sampling', () => {
    const doc = resolveDoc('tail_sampling');
    expect(doc.concept?.title.toLowerCase()).toContain('sampl');
  });
  it('falls back to a generic doc for an unknown type', () => {
    const doc = resolveDoc('some_custom_exporter');
    expect(doc.role.length).toBeGreaterThan(0);
    expect(doc.concept?.docsUrl).toMatch(/opentelemetry\.io|registry/);
  });
});

// Coverage guard: every component named in any shipped template resolves to a
// non-generic doc (name match or base-type match), so teaching keeps pace with templates.
describe('template coverage', () => {
  const tplDir = join(__dirname, '../../../../templates');
  const files = readdirSync(tplDir).filter(f => f.endsWith('.yaml'));
  const GENERIC_ROLE = resolveDoc('___definitely_unknown___').role;

  const names = new Set<string>();
  for (const f of files) {
    const doc: any = yaml.load(readFileSync(join(tplDir, f), 'utf8'));
    for (const section of ['receivers', 'processors', 'exporters', 'connectors']) {
      Object.keys(doc?.[section] || {}).forEach(n => names.add(n));
    }
  }

  it('finds at least the default components', () => {
    expect(names.size).toBeGreaterThan(0);
  });

  for (const name of [...names]) {
    it(`has a specific doc for "${name}" (type ${baseType(name)})`, () => {
      expect(resolveDoc(name).role).not.toBe(GENERIC_ROLE);
    });
  }
});
