import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  custom: vi.fn(),
  fix: vi.fn(),
  select: vi.fn(),
  segmented: false,
  validator: vi.fn(),
}));
vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeFromEnv: () => ({
    kind: 'openai-responses',
    config: { models: { main: 'test' } },
    execute: mocks.execute,
  }),
}));
vi.mock('../../src/review/custom-agents/executor.js', () => ({
  executeCustomAgents: mocks.custom,
}));
vi.mock('../../src/review/fix-verifier.js', () => ({ executeFixVerifier: mocks.fix }));
vi.mock('../../src/review/agent-selector.js', () => ({ selectAgents: mocks.select }));
vi.mock('../../src/review/streaming-validator.js', () => ({
  createStreamingValidator: mocks.validator,
}));
vi.mock('../../src/diff/index.js', async (original) => ({
  ...(await original<typeof import('../../src/diff/index.js')>()),
  needsSegmentation: () => mocks.segmented,
  segmentDiff: (files: any[]) => ({
    segments: files.map((file) => ({ name: file.path, files: [file], size: 30 })),
    strategy: 'test',
    reason: 'test',
  }),
  rebuildDiffFromSegment: (segment: any) => `+${segment.files[0].path}`,
}));
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

const directories: string[] = [];
const files = ['src/a.ts', 'src/b.ts'].map((path) => ({
  path,
  status: 'modified',
  language: 'typescript',
  additions: 1,
  deletions: 0,
  changedLines: [1],
  hunks: [],
  content: '+change',
}));
const context = {
  repoPath: '.',
  diff: { diff: '+change' },
  fileAnalyses: [],
  standards: { source: [] },
  diffFiles: files,
};
const usage = {
  input_tokens_used: 5,
  cached_input_tokens_used: 2,
  output_tokens_used: 1,
  tokens_used: 6,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.segmented = false;
  mocks.execute.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        status: 'success',
        usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      };
    },
    close: async () => {},
  }));
  mocks.custom.mockImplementation(async (agents: any[], _options, callbacks) =>
    agents.map((agent) => {
      callbacks.onAgentStart?.(agent);
      const result = {
        agent_id: agent.id,
        agent_name: agent.name,
        issues: [],
        execution_time_ms: 1,
        ...usage,
      };
      callbacks.onAgentComplete?.(agent, result);
      return result;
    })
  );
  mocks.fix.mockResolvedValue({
    total: 1,
    by_status: { fixed: 1, missed: 0, false_positive: 0 },
    results: [],
    ...usage,
  });
  mocks.validator.mockReturnValue({
    enqueue: vi.fn(),
    flush: async () => ({
      issues: [],
      inputTokensUsed: 0,
      cachedInputTokensUsed: 0,
      outputTokensUsed: 0,
      tokensUsed: 0,
    }),
  });
  mocks.select.mockResolvedValue({
    agents: ['logic-reviewer'],
    reasons: {},
    usedLLM: false,
    confidence: 1,
  });
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: any = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'argus-integration-'));
  directories.push(dir);
  const primary = join(dir, 'primary.yaml');
  await writeFile(
    primary,
    'name: primary\ndescription: Comprehensive\nprompt: Review all dimensions.\n'
  );
  await writeFile(
    join(dir, 'extra.yaml'),
    'name: extra\ndescription: Supplemental\nprompt: Review API contracts.\ntrigger_mode: rule\ntriggers:\n  files: ["**/*.ts"]\n'
  );
  const orchestrator = new StreamingReviewOrchestrator({
    reviewStrategy: 'single',
    primaryReviewerFile: primary,
    customAgentsDirs: [dir],
    disableCustomAgentLLM: true,
    progressMode: 'silent',
    ...options,
  });
  vi.spyOn(orchestrator as any, 'buildContextByRefs').mockResolvedValue({
    context,
    diffFiles: files,
  });
  vi.spyOn(orchestrator as any, 'attachDependencyContext').mockResolvedValue(undefined);
  return { orchestrator, primary };
}
function review(orchestrator: StreamingReviewOrchestrator) {
  return orchestrator.reviewByRefs({
    repoPath: '.',
    externalDiff: { diffContent: '+change' },
  } as any);
}

it('runs the selected primary once, preserves supplemental matching and validator rules', async () => {
  const { orchestrator } = await fixture();
  const report = await review(orchestrator);
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.custom.mock.calls[0]![0].map((agent: any) => agent.id)).toEqual(['custom:extra']);
  expect(mocks.validator.mock.calls[0]![0].projectRules).toContain('Review all dimensions.');
  expect(report.metadata.agents_used.sort()).toEqual(['custom:extra', 'custom:primary']);
  expect(report.metadata.review_complete).toBe(true);
  expect(report.metadata.tokens_used).toBe(18);
});

it('keeps multi selection and custom triggers compatible when a primary path is configured', async () => {
  const { orchestrator, primary } = await fixture({
    reviewStrategy: 'multi',
    skipValidation: true,
  });
  // An ordinary triggered custom definition must not be suppressed in multi mode.
  await writeFile(
    primary,
    'name: primary\ndescription: Ordinary custom\nprompt: Review.\ntrigger_mode: rule\ntriggers:\n  files: ["**/*.ts"]\n'
  );
  const report = await review(orchestrator);
  expect(mocks.select).toHaveBeenCalledOnce();
  expect(mocks.custom.mock.calls[0]![0]).toHaveLength(2);
  expect(report.metadata.primary_reviewer).toBeUndefined();
  expect(report.metadata.agents_used).toContain('logic-reviewer');
});

it('runs supplemental reviewers per segment and fix verification once for the whole PR', async () => {
  mocks.segmented = true;
  const { orchestrator } = await fixture({ previousReviewData: { issues: [{ id: 'old' }] } });
  const report = await review(orchestrator);
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  expect(mocks.custom).toHaveBeenCalledTimes(2);
  expect(mocks.fix).toHaveBeenCalledOnce();
  expect(mocks.fix.mock.calls[0]![0].diffContent).toBe('+change');
  expect(report.metadata.tokens_used).toBe(42);
  expect(report.metadata.agents_used.sort()).toEqual(['custom:extra', 'custom:primary']);
  expect(report.fix_verification).toBeDefined();
});

it('marks a failed segment incomplete and retains successful usage and partial findings', async () => {
  mocks.segmented = true;
  const { orchestrator } = await fixture({ skipValidation: true });
  const run = vi.spyOn(orchestrator as any, 'runAgentsWithStreaming');
  run.mockImplementation(async (segmentContext: any) => {
    if (segmentContext.diff.diff.includes('a.ts')) throw new Error('missing segment evidence');
    return {
      checklists: [],
      tokens: 12,
      inputTokensUsed: 10,
      cachedInputTokensUsed: 4,
      outputTokensUsed: 2,
    };
  });
  const report = await review(orchestrator);
  expect(report.metadata.review_complete).toBe(false);
  expect(report.metadata.incomplete_reasons?.join(' ')).toContain('a.ts');
  expect(report.metadata.tokens_used).toBe(24);
});

it('resets execution completeness between repeated reviews on the same orchestrator', async () => {
  const { orchestrator } = await fixture({ skipValidation: true });
  mocks.execute.mockImplementationOnce((options) => ({
    async *[Symbol.asyncIterator]() {
      await options.tools
        .find((tool: any) => tool.name === 'report_incomplete')
        .execute({ reason: 'Missing evidence' });
      yield { type: 'result', status: 'success' };
    },
    close: async () => {},
  }));
  expect((await review(orchestrator)).metadata.review_complete).toBe(false);
  expect((await review(orchestrator)).metadata.review_complete).toBe(true);
});

it.each(['refs', 'legacy'])(
  'preserves partial findings and known usage after exhausted failures through %s',
  async (entry) => {
    const { orchestrator } = await fixture({
      skipValidation: true,
      local: true,
      customAgentsDirs: [],
    });
    vi.spyOn(orchestrator as any, 'buildContext').mockResolvedValue({ context, diffFiles: files });
    let attempt = 0;
    mocks.execute.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        if (++attempt === 1)
          await options.tools
            .find((tool: any) => tool.name === 'report_issue')
            .execute({
              file: 'src/a.ts',
              line_start: 1,
              line_end: 1,
              category: 'security',
              severity: 'error',
              title: 'Missing permission check',
              description: 'The mutation allows another user account to be updated.',
              confidence: 0.95,
            });
        yield {
          type: 'result',
          status: 'error',
          error: 'Provider stream failed',
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
      close: async () => {},
    }));
    const result =
      entry === 'refs'
        ? await review(orchestrator)
        : await orchestrator.review({
            repoPath: '.',
            sourceBranch: 'feature',
            targetBranch: 'main',
          } as any);
    expect(attempt).toBe(2);
    expect(result.issues).toHaveLength(1);
    expect(result.metadata.review_complete).toBe(false);
    expect(result.metadata.incomplete_reasons?.join(' ')).toContain('Provider stream failed');
    expect(result.metadata.tokens_used).toBe(24);
  }
);

it.each(['cancelled', 'unterminated'])(
  'preserves partial findings from a %s primary stream',
  async (outcome) => {
    const { orchestrator } = await fixture({ skipValidation: true, customAgentsDirs: [] });
    let attempt = 0;
    mocks.execute.mockImplementation((options) => ({
      // eslint-disable-next-line require-yield -- mock stream intentionally emits no events
      async *[Symbol.asyncIterator]() {
        if (++attempt === 1)
          await options.tools
            .find((tool: any) => tool.name === 'report_issue')
            .execute({
              file: 'src/a.ts',
              line_start: 1,
              line_end: 1,
              category: 'logic',
              severity: 'error',
              title: 'Lost update',
              description: 'The updated transaction overwrites a newer value.',
              confidence: 0.95,
            });
        if (outcome === 'cancelled')
          throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      },
      close: async () => {},
    }));
    const result = await review(orchestrator);
    expect(result.issues).toHaveLength(1);
    expect(result.metadata.review_complete).toBe(false);
    expect(attempt).toBe(outcome === 'cancelled' ? 1 : 2);
  }
);

it('passes validation tuning to the streaming validator', async () => {
  const { orchestrator } = await fixture({
    validationRounds: 1,
    validationMaxTurns: 15,
    validationReadLimit: 400,
  });
  await review(orchestrator);
  expect(mocks.validator).toHaveBeenCalledWith(
    expect.objectContaining({ maxChallengeRounds: 1, maxTurns: 15, readLimit: 400 })
  );
});

it('reads validation tuning from ARGUS_VALIDATION_* when options are absent', async () => {
  process.env.ARGUS_VALIDATION_ROUNDS = '1';
  process.env.ARGUS_VALIDATION_MAX_TURNS = '15';
  try {
    const { orchestrator } = await fixture();
    await review(orchestrator);
    expect(mocks.validator).toHaveBeenCalledWith(
      expect.objectContaining({ maxChallengeRounds: 1, maxTurns: 15 })
    );
  } finally {
    delete process.env.ARGUS_VALIDATION_ROUNDS;
    delete process.env.ARGUS_VALIDATION_MAX_TURNS;
  }
});

it('marks the review incomplete when a validator session was cut short', async () => {
  mocks.validator.mockReturnValue({
    enqueue: vi.fn(),
    flush: async () => ({
      issues: [],
      inputTokensUsed: 0,
      cachedInputTokensUsed: 0,
      outputTokensUsed: 0,
      tokensUsed: 0,
      incompleteReasons: [
        'Validation turn budget exhausted (15 turns): "Missing guard" (src/a.ts:1) was left unvalidated',
      ],
    }),
  });
  const { orchestrator } = await fixture();
  const report = await review(orchestrator);
  expect(report.metadata.review_complete).toBe(false);
  expect(report.metadata.incomplete_reasons?.join(' ')).toContain('turn budget exhausted');
});
