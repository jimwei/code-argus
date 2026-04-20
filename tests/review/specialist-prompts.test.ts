import { describe, expect, it } from 'vitest';
import { buildSpecialistPrompt } from '../../src/review/prompts/specialist.js';

describe('specialist prompts', () => {
  it('includes PR description without forcing a related issues section', () => {
    const prompt = buildSpecialistPrompt('logic-reviewer', {
      diff: '+const ready = true',
      fileAnalyses: [],
      standardsText: '',
      prContext: {
        prTitle: 'Improve login validation',
        prDescription: 'Handle special characters and keep backward compatibility.',
        issues: [],
      },
    });

    expect(prompt).toContain('## PR Business Context');
    expect(prompt).toContain(
      '**PR Description**: Handle special characters and keep backward compatibility.'
    );
    expect(prompt).not.toContain('### Related Issues');
  });
});
