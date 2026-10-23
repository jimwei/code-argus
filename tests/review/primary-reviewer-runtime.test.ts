import { beforeEach, describe, expect, it, vi } from 'vitest';
const { executeMock, createRuntimeMock, closeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  createRuntimeMock: vi.fn(),
  closeMock: vi.fn(async () => undefined),
}));
vi.mock('../../src/runtime/factory.js', () => ({ createRuntimeFromEnv: createRuntimeMock }));
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

const context = {
  repoPath: '.',
  diff: { diff: '+const ready = true' },
  fileAnalyses: [],
  standards: { source: [] },
  diffFiles: [],
  prContext: {
    issues: [
      {
        key: 'TASK-1',
        type: 'Story',
        summary: 'Only administrators can update accounts',
        keyPoints: [],
        reviewContext: 'Authorization',
      },
    ],
  },
};
function runtimeWith(status = 'success', reportIncomplete = false) {
  return {
    kind: 'openai-responses',
    config: { models: { main: 'test-model' } },
    execute: executeMock.mockImplementation((options: any) => ({
      async *[Symbol.asyncIterator]() {
        if (reportIncomplete)
          await options.tools
            .find((tool: any) => tool.name === 'report_incomplete')
            .execute({ reason: 'Missing policy implementation' });
        yield {
          type: 'result',
          status,
          text: 'Review finished.',
          usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
        };
      },
      close: closeMock,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});

describe('primary reviewer runtime', () => {
  it('runs exactly one configurable reviewer with repository tools and shared context', async () => {
    createRuntimeMock.mockReturnValue(runtimeWith());
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'silent',
    } as any);
    await (orchestrator as any).preparePrimaryReviewer();
    (orchestrator as any).rulesConfig = {
      global: 'Global project rule',
      agents: {
        'security-reviewer': 'Check all tenant boundaries',
        'performance-reviewer': 'Avoid unbounded queries',
      },
      checklist: [],
      sources: [],
    };
    const result = await (orchestrator as any).runAgentsWithStreaming(context, '.', [
      'logic-reviewer',
      'security-reviewer',
      'performance-reviewer',
      'style-reviewer',
    ]);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const options = executeMock.mock.calls[0]![0];
    expect(options.prompt).toContain('Security');
    expect(options.prompt).toContain('Only administrators');
    expect(options.prompt).toContain('Check all tenant boundaries');
    expect(options.prompt).toContain('Avoid unbounded queries');
    expect(options.tools.map((tool: any) => tool.name)).toEqual([
      'report_issue',
      'Read',
      'Grep',
      'Glob',
      'report_incomplete',
    ]);
    expect(options.maxTurns).toBe(30);
    expect(options.completionBudget.reserveTurns).toBe(3);
    expect(result.tokens).toBe(12);
  });

  it('keeps an incomplete primary reviewer from being overwritten as completed', async () => {
    createRuntimeMock.mockReturnValue(runtimeWith('success', true));
    const events: any[] = [];
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'auto',
      onEvent: (event: any) => events.push(event),
    } as any);
    await (orchestrator as any).preparePrimaryReviewer();
    await (orchestrator as any).runAgentsWithStreaming(context, '.', []);
    const terminal = events.filter((event) => event.type === 'agent:complete');
    expect(terminal).toHaveLength(1);
    expect(terminal.at(-1)?.data?.status).toBe('error');
    expect((orchestrator as any).incompleteReasons).toContain(
      'custom:comprehensive-reviewer: Missing policy implementation'
    );
  });

  it('fails a primary reviewer with no terminal runtime result', async () => {
    createRuntimeMock.mockReturnValue({
      kind: 'openai-responses',
      config: { models: { main: 'test-model' } },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {},
        close: closeMock,
      })),
    });
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'silent',
    } as any);
    await (orchestrator as any).preparePrimaryReviewer();
    await expect((orchestrator as any).runAgentsWithStreaming(context, '.', [])).rejects.toThrow(
      /Review failed/
    );
  });

  it.each(['incomplete', 'error_max_turns'])(
    'retains findings and usage when the primary returns %s',
    async (status) => {
      createRuntimeMock.mockReturnValue({
        kind: 'openai-responses',
        config: { models: { main: 'test-model' } },
        execute: executeMock.mockImplementation((options: any) => ({
          async *[Symbol.asyncIterator]() {
            await options.tools
              .find((tool: any) => tool.name === 'report_issue')
              .execute({
                file: 'src/auth.ts',
                line_start: 1,
                line_end: 1,
                category: 'security',
                severity: 'error',
                title: 'Missing authorization',
                description: 'A user can update other accounts.',
                confidence: 0.95,
              });
            yield {
              type: 'result',
              status,
              error: 'Review budget exhausted',
              usage: { inputTokens: 10, outputTokens: 2 },
            };
          },
          close: closeMock,
        })),
      });
      const orchestrator = new StreamingReviewOrchestrator({
        reviewStrategy: 'single',
        skipValidation: true,
        progressMode: 'silent',
      });
      const result = await (orchestrator as any).runAgentsWithStreaming(context, '.', []);
      expect(executeMock).toHaveBeenCalledOnce();
      expect(result.tokens).toBe(12);
      expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(1);
      expect((orchestrator as any).getReviewExecutionMetadata().review_complete).toBe(false);
    }
  );

  it('counts the failed zero-finding attempt and enlarges the retry budget', async () => {
    let attempt = 0;
    createRuntimeMock.mockReturnValue({
      kind: 'openai-responses',
      config: { models: { main: 'test-model' } },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: ++attempt === 1 ? 'error_max_turns' : 'success',
            usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
          };
        },
        close: closeMock,
      })),
    });
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'silent',
    });
    const result = await (orchestrator as any).runAgentsWithStreaming(context, '.', []);
    expect(executeMock.mock.calls.map(([options]) => options.maxTurns)).toEqual([30, 38]);
    expect(result.tokens).toBe(24);
    expect(result.cachedInputTokensUsed).toBe(8);
    expect((orchestrator as any).getReviewExecutionMetadata().review_complete).toBe(true);
  });

  it('stops immediately when the primary runtime is cancelled', async () => {
    createRuntimeMock.mockReturnValue({
      kind: 'openai-responses',
      config: { models: { main: 'test-model' } },
      execute: executeMock.mockImplementation(() => ({
        // eslint-disable-next-line require-yield -- cancelled streams emit no events
        async *[Symbol.asyncIterator]() {
          throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        },
        close: closeMock,
      })),
    });
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'silent',
    });
    await expect((orchestrator as any).runAgentsWithStreaming(context, '.', [])).rejects.toThrow(
      /Cancelled/
    );
    expect(executeMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'unterminated'])(
    'does not label a %s multi reviewer as a complete review',
    async (outcome) => {
      createRuntimeMock.mockReturnValue({
        kind: 'openai-responses',
        config: { models: { main: 'test-model' } },
        execute: executeMock.mockImplementation(() => ({
          // eslint-disable-next-line require-yield -- unterminated streams emit no events
          async *[Symbol.asyncIterator]() {
            if (outcome === 'cancelled')
              throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          },
          close: closeMock,
        })),
      });
      const orchestrator = new StreamingReviewOrchestrator({
        reviewStrategy: 'multi',
        skipValidation: true,
        progressMode: 'silent',
      });
      await expect(
        (orchestrator as any).runAgentsWithStreaming(context, '.', ['logic-reviewer'])
      ).rejects.toThrow(/Review failed/);
    }
  );

  it('applies changed-line and whitespace style filters to a configurable primary', async () => {
    const orchestrator = new StreamingReviewOrchestrator({
      reviewStrategy: 'single',
      skipValidation: true,
      progressMode: 'silent',
    });
    const tools = (orchestrator as any).createReportIssueRuntimeTools(
      new Map([['src/a.ts', new Set([2, 3])]]),
      new Map([['src/a.ts', new Set([2])]])
    )('custom:primary', 'test');
    const issue = {
      file: 'src/a.ts',
      line_start: 1,
      line_end: 1,
      category: 'style',
      severity: 'warning',
      title: 'Confusing statement',
      description: 'Details',
      confidence: 0.9,
    };
    for (const line of [1, 2, 3])
      await tools[0].execute({ ...issue, line_start: line, line_end: line });
    expect(
      (orchestrator as any).rawIssuesForSkipMode.map((finding: any) => finding.line_start)
    ).toEqual([3]);
  });
});
