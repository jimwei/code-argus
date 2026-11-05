import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildCoverageWarningPolicy,
  createCoverageWarningTool,
  parseIgnoreCoverageWarnings,
  resolveIgnoreCoverageWarnings,
} from '../../src/review/coverage-policy.js';

afterEach(() => vi.unstubAllEnvs());

describe('explicit coverage warnings', () => {
  it('defaults on, parses booleans and rejects ambiguous values', () => {
    for (const value of [undefined, '', ' ', 'true', ' TRUE ']) {
      expect(parseIgnoreCoverageWarnings(value)).toBe(true);
    }
    expect(parseIgnoreCoverageWarnings(' false ')).toBe(false);
    for (const value of ['yes', '1', '0', 'typo']) {
      expect(() => parseIgnoreCoverageWarnings(value)).toThrow(/true or false/);
    }
  });

  it.each([undefined, '', ' '])(
    'defaults the policy and env %j to on with explicit false opt-out',
    (value) => {
      vi.stubEnv('ARGUS_IGNORE_COVERAGE_WARNINGS', value);
      expect(resolveIgnoreCoverageWarnings()).toBe(true);
      expect(resolveIgnoreCoverageWarnings(false)).toBe(false);
      expect(buildCoverageWarningPolicy()).toContain('Ignoring coverage warnings is ENABLED');
    }
  );

  it('uses explicit CLI/API boolean before env and snapshots the result', () => {
    vi.stubEnv('ARGUS_IGNORE_COVERAGE_WARNINGS', 'true');
    const captured = resolveIgnoreCoverageWarnings();
    expect(captured).toBe(true);
    expect(resolveIgnoreCoverageWarnings(false)).toBe(false);
    vi.stubEnv('ARGUS_IGNORE_COVERAGE_WARNINGS', 'false');
    expect(captured).toBe(true);
    expect(resolveIgnoreCoverageWarnings()).toBe(false);
    expect(resolveIgnoreCoverageWarnings(true)).toBe(true);
    vi.stubEnv('ARGUS_IGNORE_COVERAGE_WARNINGS', 'invalid');
    expect(() => resolveIgnoreCoverageWarnings()).toThrow(/ARGUS_IGNORE/);
    expect(resolveIgnoreCoverageWarnings(false)).toBe(false);
  });

  it.each([
    'Required local evidence missing',
    'Cannot verify visual output',
    'Caller implementation unavailable',
    'External API contract unknown',
    'Opaque coverage note α',
  ])('ignores the explicit coverage warning for any reason: %s', async (reason) => {
    for (const enabled of [false, true]) {
      const warnings: string[] = [];
      const tool = createCoverageWarningTool(enabled, (value) => warnings.push(value));
      expect(Object.keys(tool.inputSchema)).toEqual(['reason']);
      expect(z.object(tool.inputSchema).parse({ reason })).toEqual({ reason });
      const result = await tool.execute({ reason });
      expect(warnings).toEqual(enabled ? [] : [reason]);
      expect(result.content[0]?.text).toContain(enabled ? 'ignored' : 'recorded');
    }
  });

  it('requires a reason and applies the same setting to every independent gap', async () => {
    for (const enabled of [false, true]) {
      const warnings: string[] = [];
      const tool = createCoverageWarningTool(enabled, (reason) => warnings.push(reason));
      expect(() => z.object(tool.inputSchema).parse({ reason: '' })).toThrow();
      for (const reason of ['Missing local evidence', 'Unverified visual output']) {
        await tool.execute({ reason });
      }
      expect(warnings).toEqual(
        enabled ? [] : ['Missing local evidence', 'Unverified visual output']
      );
    }
  });

  it('preserves true findings and independent failures in the prompt and prevents warning bypasses', () => {
    for (const enabled of [false, true]) {
      const prompt = buildCoverageWarningPolicy(enabled);
      expect(prompt).toContain(enabled ? 'ENABLED' : 'DISABLED');
      expect(prompt).toContain('report_issue');
      expect(prompt).toContain('turn/token budget');
      expect(prompt).toContain('validator and fix-verification failures');
      if (enabled) expect(prompt).toContain('ordinary report_issue findings or summary warnings');
    }
  });
});
