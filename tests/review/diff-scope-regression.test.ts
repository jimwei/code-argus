import { describe, expect, it, vi } from 'vitest';
import { preprocessDiff } from '../../src/diff/preprocessor.js';
import type { DiffFile } from '../../src/git/parser.js';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';
import type { ValidatedIssue } from '../../src/review/types.js';

const file = 'src/StatusMenu.cs';

// Model the PR-manager input after whitespace-only changes are converted to
// context lines: the brace before the misspelled field is not an added line.
const diff = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1382 +1382 @@ namespace Example
-if (approve || cancelApproval)
+if (approve)
@@ -1393,3 +1393,3 @@ namespace Example
 else if (unlimitedTime)
 {
-    fieldName = "UnlimitedTime";
+    fieldName = "UnlimitedTime1";
`;

type DiffScopeInternals = {
  options: { verbose: boolean };
  progress: { info: (message: string) => void };
  filterIssuesByDiffScope: (issues: ValidatedIssue[], files: DiffFile[]) => ValidatedIssue[];
};

function confirmedIssue(line: number, endLine = line): ValidatedIssue {
  return {
    id: `issue-${line}`,
    file,
    line_start: line,
    line_end: endLine,
    severity: 'error',
    category: 'logic',
    title: `Regression on line ${line}`,
    description: 'The changed menu handler no longer updates the expected state.',
    confidence: 0.95,
    source_agent: 'logic-reviewer',
    validation_status: 'confirmed',
    final_confidence: 0.95,
    grounding_evidence: {
      checked_files: [file],
      checked_symbols: [],
      related_context: 'Changed menu handler',
      reasoning: 'Confirmed against the changed code.',
    },
  };
}

describe('fast review diff scope regression', () => {
  it('keeps confirmed changed-line issues without treating section text as code', () => {
    const { diffFiles } = preprocessDiff(diff);
    const issues = [
      confirmedIssue(1382),
      confirmedIssue(1395),
      confirmedIssue(1394, 1395),
      confirmedIssue(1394),
      confirmedIssue(1396),
    ];
    const orchestrator = Object.create(StreamingReviewOrchestrator.prototype) as DiffScopeInternals;
    orchestrator.options = { verbose: false };
    orchestrator.progress = { info: vi.fn() };

    expect(diffFiles).toHaveLength(1);
    expect(orchestrator.filterIssuesByDiffScope(issues, diffFiles)).toEqual(issues.slice(0, 3));
    expect(diffFiles[0].changedLines).toEqual([1382, 1395]);
    expect(orchestrator.progress.info).toHaveBeenCalledWith(
      '快速模式范围过滤: 移除 2 个非变更行问题'
    );
  });
});
