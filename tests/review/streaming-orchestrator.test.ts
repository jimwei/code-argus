import { describe, expect, it } from 'vitest';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

type OrchestratorInternals = {
  getAgentMaxTurns: (
    agentType: string,
    baseTurns: number,
    attempt: number,
    zeroIssueMaxTurnsRetry: boolean
  ) => number;
  issueCountByInvocation: Map<string, number>;
  getInvocationIssueCount: (invocationKey: string) => number;
};

function createBareOrchestrator(): StreamingReviewOrchestrator & OrchestratorInternals {
  return Object.create(StreamingReviewOrchestrator.prototype) as StreamingReviewOrchestrator &
    OrchestratorInternals;
}

describe('StreamingReviewOrchestrator turn scaling', () => {
  it('scales reviewer turns by agent type', () => {
    const orchestrator = createBareOrchestrator();

    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 1, false)).toBe(42);
    expect(orchestrator.getAgentMaxTurns('performance-reviewer', 31, 1, false)).toBe(47);
    expect(orchestrator.getAgentMaxTurns('security-reviewer', 28, 1, false)).toBe(34);
    expect(orchestrator.getAgentMaxTurns('style-reviewer', 28, 1, false)).toBe(28);
  });

  it('applies one-time retry uplift only for zero-issue max-turn retries', () => {
    const orchestrator = createBareOrchestrator();

    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 2, true)).toBe(53);
    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 2, false)).toBe(42);
  });

  it('keeps issue counts isolated per invocation', () => {
    const orchestrator = createBareOrchestrator();
    orchestrator.issueCountByInvocation = new Map([
      ['logic-run-a', 0],
      ['logic-run-b', 2],
    ]);

    expect(orchestrator.getInvocationIssueCount('logic-run-a')).toBe(0);
    expect(orchestrator.getInvocationIssueCount('logic-run-b')).toBe(2);
    expect(orchestrator.getInvocationIssueCount('logic-run-missing')).toBe(0);
  });
});
