import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('reviews with no text changes', () => {
  it.each([
    'diff --git a/menu.XLS b/menu.XLS\nindex abc..def 100644\n',
    'diff --git a/data.unknown b/data.unknown\nBinary files a/data.unknown and b/data.unknown differ\n',
  ])(
    'completes excluded binary-only changes without AI usage or incomplete coverage',
    async (diffContent) => {
      const repoPath = await mkdtemp(join(tmpdir(), 'argus-binary-only-'));
      directories.push(repoPath);
      const orchestrator = new StreamingReviewOrchestrator({
        reviewStrategy: 'single',
        local: true,
        progressMode: 'silent',
      });
      const report = await orchestrator.reviewByRefs({ repoPath, externalDiff: { diffContent } });
      expect(report.metrics.files_reviewed).toBe(0);
      expect(report.issues).toEqual([]);
      expect(report.metadata.review_complete).toBe(true);
      expect(report.metadata.incomplete_reasons).toEqual([]);
      expect(report.metadata.agents_used).toEqual([]);
      expect(report.metadata.tokens_used).toBe(0);
    }
  );
});
