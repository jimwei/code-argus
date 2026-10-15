/**
 * 大 PR 分段审核上下文回归测试
 *
 * 背景：超过分段阈值的大 PR 会按文件拆成多个分段，每个分段独立跑一遍 agents。
 * 分段的 user prompt 同时包含 "File Change Analysis"（由 fileAnalyses 渲染）和
 * "Code Changes (Diff)"（本分段的 diff）。如果 fileAnalyses 仍沿用整个 PR 的清单，
 * agent 会看到大量文件只在清单里、不在 diff 里，于是调用 report_incomplete，
 * 评审被标记为「agent 执行失败」。分段上下文的 fileAnalyses 必须只包含本分段的文件。
 */
import { describe, expect, it } from 'vitest';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';
import type { AgentType, ReviewContext } from '../../src/review/types.js';
import type { DiffFile } from '../../src/git/parser.js';
import type { ChangeAnalysis } from '../../src/analyzer/types.js';

const SEGMENT_SIZE_LIMIT = 1024;

function makeDiffFile(path: string, contentSize: number): DiffFile {
  return {
    path,
    type: 'add',
    content: `diff --git a/${path} b/${path}\n+${'x'.repeat(contentSize)}\n`,
    category: 'source',
  };
}

function makeAnalysis(filePath: string): ChangeAnalysis {
  return {
    file_path: filePath,
    risk_level: 'low',
    semantic_hints: { summary: `${filePath} changed` },
  };
}

function makeContext(diffFiles: DiffFile[]): ReviewContext {
  return {
    repoPath: '/repo',
    diff: {
      diff: diffFiles.map((file) => file.content).join('\n'),
      sourceBranch: 'feature',
      targetBranch: 'main',
      repoPath: '/repo',
      remote: 'origin',
    },
    fileAnalyses: diffFiles.map((file) => makeAnalysis(file.path)),
    standards: {} as ReviewContext['standards'],
    diffFiles,
    deletedFiles: ['src/deleted.ts'],
  };
}

interface SegmentedReviewParams {
  context: ReviewContext;
  diffFiles: DiffFile[];
  reviewRepoPath: string;
  agentsToRun: AgentType[];
  startTime: number;
  segmentSizeLimit: number;
}

interface OrchestratorInternals {
  progress: Record<string, (...args: unknown[]) => void>;
  options: { skipValidation: boolean };
  rawIssuesForSkipMode: unknown[];
  runAgentsWithStreaming: (context: ReviewContext) => Promise<{
    tokensUsed: number;
    inputTokensUsed: number;
    cachedInputTokensUsed: number;
    outputTokensUsed: number;
    checklists: never[];
  }>;
  runSegmentedReview: (params: SegmentedReviewParams) => Promise<unknown>;
}

function createHarness() {
  const orchestrator = Object.create(
    StreamingReviewOrchestrator.prototype
  ) as StreamingReviewOrchestrator;
  const capturedContexts: ReviewContext[] = [];
  const noop = () => {};

  const internals = orchestrator as unknown as OrchestratorInternals;
  internals.progress = {
    progress: noop,
    info: noop,
    success: noop,
    warn: noop,
    error: noop,
    phase: noop,
    complete: noop,
    agent: noop,
  };
  internals.options = { skipValidation: true };
  internals.rawIssuesForSkipMode = [];
  internals.runAgentsWithStreaming = async (context: ReviewContext) => {
    capturedContexts.push(context);
    return {
      tokensUsed: 0,
      inputTokensUsed: 0,
      cachedInputTokensUsed: 0,
      outputTokensUsed: 0,
      checklists: [],
    };
  };

  return { internals, capturedContexts };
}

describe('segmented review context', () => {
  it('scopes file analyses to the files of each segment', async () => {
    const bigFile = makeDiffFile('src/reports/big.resx', 2000);
    const smallFile = makeDiffFile('src/reports/small.ts', 300);
    const diffFiles = [bigFile, smallFile];
    const context = makeContext(diffFiles);

    const { internals, capturedContexts } = createHarness();
    const report = (await internals.runSegmentedReview({
      context,
      diffFiles,
      reviewRepoPath: '/repo',
      agentsToRun: ['logic-reviewer'],
      startTime: Date.now(),
      segmentSizeLimit: SEGMENT_SIZE_LIMIT,
    })) as { segmentation?: { totalSegments?: number } };

    expect(report.segmentation?.totalSegments).toBe(2);
    expect(capturedContexts).toHaveLength(2);

    const bigSegment = capturedContexts.find((ctx) =>
      ctx.diffFiles?.some((file) => file.path === bigFile.path)
    );
    const smallSegment = capturedContexts.find((ctx) =>
      ctx.diffFiles?.some((file) => file.path === smallFile.path)
    );

    expect(bigSegment).toBeDefined();
    expect(smallSegment).toBeDefined();

    // File Change Analysis 只能包含本分段自己的文件，否则 agent 会以为
    // diff 缺失清单里的文件并调用 report_incomplete。
    expect(bigSegment!.fileAnalyses.map((analysis) => analysis.file_path)).toEqual([bigFile.path]);
    expect(smallSegment!.fileAnalyses.map((analysis) => analysis.file_path)).toEqual([
      smallFile.path,
    ]);

    // 分段 diff 本身只包含本分段文件
    expect(bigSegment!.diffFiles?.map((file) => file.path)).toEqual([bigFile.path]);
    expect(smallSegment!.diffFiles?.map((file) => file.path)).toEqual([smallFile.path]);

    // 原始上下文不被就地修改，deletedFiles 仍透传
    expect(context.fileAnalyses.map((analysis) => analysis.file_path)).toEqual([
      bigFile.path,
      smallFile.path,
    ]);
    for (const ctx of capturedContexts) {
      expect(ctx.deletedFiles).toEqual(['src/deleted.ts']);
    }
  });
});
