import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/config/env.js', () => ({ initializeEnv: vi.fn() }));
vi.mock('../../src/review/index.js', () => ({
  reviewByRefs: mocks.review,
  formatReport: () => 'Review report',
  loadPreviousReview: vi.fn(),
  validatePreviousReviewData: vi.fn(),
}));
vi.mock('../../src/git/ref.js', () => ({ detectRefType: () => 'branch' }));

const argv = [...process.argv];
const signals = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'] as const;
const listeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
const maxListeners = process.getMaxListeners();
let main: () => Promise<void>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  process.argv = ['node', 'argus', '--help'];
  main = (await import('../../src/index.js')).main;
  await Promise.resolve();
});
beforeEach(() => {
  mocks.review.mockReset().mockResolvedValue({ issues: [], metadata: {} });
});
afterEach(() => {
  process.argv = [...argv];
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!listeners.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    }
  }
  process.setMaxListeners(maxListeners);
  vi.restoreAllMocks();
});

it.each([
  [[], undefined],
  [['--ignore-coverage-warnings'], true],
  [['--ignore-coverage-warnings=true'], true],
  [['--ignore-coverage-warnings=false'], false],
] as const)('forwards CLI warning override %j as %s', async (flags, expected) => {
  vi.stubEnv('ARGUS_IGNORE_COVERAGE_WARNINGS', 'true');
  process.argv = ['node', 'argus', 'review', '/repo', 'feature', 'main', ...flags];
  await main();
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({ ignoreCoverageWarnings: expected }),
    })
  );
});

it('rejects invalid CLI booleans before starting review', async () => {
  process.argv = [
    'node',
    'argus',
    'review',
    '/repo',
    'feature',
    'main',
    '--ignore-coverage-warnings=yes',
  ];
  await expect(main()).rejects.toThrow(/--ignore-coverage-warnings/);
  expect(mocks.review).not.toHaveBeenCalled();
});
