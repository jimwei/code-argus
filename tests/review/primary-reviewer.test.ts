import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPrimaryReviewerMaxTurns,
  isPrimaryReviewer,
  loadPrimaryReviewer,
  parseReviewStrategy,
} from '../../src/review/primary-reviewer.js';
import { loadCustomAgents } from '../../src/review/custom-agents/loader.js';

const directories: string[] = [];
async function fixture(yaml: string) {
  const dir = await mkdtemp(join(tmpdir(), 'argus-primary-'));
  directories.push(dir);
  const file = join(dir, 'reviewer.yaml');
  await writeFile(file, yaml);
  return { dir, file };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('configurable primary reviewer', () => {
  it('defaults to multi and rejects an unknown strategy', () => {
    expect(parseReviewStrategy()).toBe('multi');
    expect(parseReviewStrategy('')).toBe('multi');
    expect(parseReviewStrategy('single')).toBe('single');
    expect(() => parseReviewStrategy('singel')).toThrow(/review strategy/i);
  });

  it('ships a comprehensive definition without adding a new built-in role', async () => {
    const reviewer = await loadPrimaryReviewer();
    expect(reviewer.id).toBe('custom:comprehensive-reviewer');
    for (const focus of ['Security', 'Logic', 'Performance', 'Maintainability']) {
      expect(reviewer.prompt).toContain(focus);
    }
    expect(reviewer.prompt).toContain('report_incomplete');
    expect(reviewer.source_file).toMatch(/comprehensive-reviewer\.yaml$/);
  });

  it('ships a severity rubric that keeps removed-guard security regressions at error', async () => {
    const reviewer = await loadPrimaryReviewer();
    expect(reviewer.prompt).toContain('## Severity');
    for (const level of ['`critical`', '`error`', '`warning`', '`suggestion`']) {
      expect(reviewer.prompt).toContain(level);
    }
    expect(reviewer.prompt).toMatch(/removes? or weakens an existing security guard/i);
    expect(reviewer.prompt).toMatch(/at least `error`/i);
  });

  it('loads a selected definition without requiring trigger conditions', async () => {
    const { file } = await fixture(
      'name: business-reviewer\ndescription: Business rules\nprompt: Check balances.\n'
    );
    const reviewer = await loadPrimaryReviewer(file);
    expect(reviewer.id).toBe('custom:business-reviewer');
    expect(reviewer.prompt).toBe('Check balances.');
  });

  it('loads Markdown relative to its YAML definition and preserves budgets', async () => {
    const { file, dir } = await fixture(
      'name: custom-comprehensive\ndescription: All dimensions\nprompt_file: review.md\nmax_turns: 80\ntrigger_mode: rule\n'
    );
    await writeFile(join(dir, 'review.md'), '# Rules\nReview authorization and transactions.');
    const reviewer = await loadPrimaryReviewer(file);
    expect(reviewer.prompt).toContain('Review authorization');
    expect(getPrimaryReviewerMaxTurns(reviewer, 1)).toBe(80);
    expect(getPrimaryReviewerMaxTurns(reviewer, 100, 2)).toBe(100);
    const supplemental = await loadCustomAgents([dir]);
    expect(supplemental.agents).toHaveLength(1);
    expect(isPrimaryReviewer(supplemental.agents[0]!, reviewer)).toBe(true);
  });

  it('rejects missing, disabled, empty, ambiguous and invalid-budget definitions', async () => {
    await expect(
      loadPrimaryReviewer(join(tmpdir(), 'does-not-exist-primary.yaml'))
    ).rejects.toThrow();
    for (const extra of [
      'enabled: false',
      'enabled: "false"',
      'enabled: 0',
      'enabled: null',
      'max_turns: 0',
      'max_turns: 501',
      'max_turns: 1.5',
      'prompt_file: also.md',
    ]) {
      const { file } = await fixture(`description: Primary\nprompt: Review.\n${extra}\n`);
      await expect(loadPrimaryReviewer(file)).rejects.toThrow();
    }
    const { file, dir } = await fixture('description: Primary\nprompt_file: empty.md\n');
    await writeFile(join(dir, 'empty.md'), '  \n');
    await expect(loadPrimaryReviewer(file)).rejects.toThrow(/empty/i);
  });

  it('uses twice the base budget and clamps retries', async () => {
    const reviewer = await loadPrimaryReviewer();
    expect(getPrimaryReviewerMaxTurns(reviewer, 10)).toBe(92);
    expect(getPrimaryReviewerMaxTurns(reviewer, 1000, 2)).toBe(500);
  });
});
