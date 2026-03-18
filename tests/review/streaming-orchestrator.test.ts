import { describe, expect, it } from 'vitest';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

describe('StreamingReviewOrchestrator turn scaling', () => {
  it('scales reviewer turns by agent type', () => {
    const orchestrator = Object.create(
      StreamingReviewOrchestrator.prototype
    ) as StreamingReviewOrchestrator & {
      getAgentMaxTurns: (
        agentType: string,
        baseTurns: number,
        attempt: number,
        zeroIssueMaxTurnsRetry: boolean
      ) => number;
    };

    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 1, false)).toBe(42);
    expect(orchestrator.getAgentMaxTurns('performance-reviewer', 31, 1, false)).toBe(47);
    expect(orchestrator.getAgentMaxTurns('security-reviewer', 28, 1, false)).toBe(34);
    expect(orchestrator.getAgentMaxTurns('style-reviewer', 28, 1, false)).toBe(28);
  });

  it('applies one-time retry uplift only for zero-issue max-turn retries', () => {
    const orchestrator = Object.create(
      StreamingReviewOrchestrator.prototype
    ) as StreamingReviewOrchestrator & {
      getAgentMaxTurns: (
        agentType: string,
        baseTurns: number,
        attempt: number,
        zeroIssueMaxTurnsRetry: boolean
      ) => number;
    };

    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 2, true)).toBe(53);
    expect(orchestrator.getAgentMaxTurns('logic-reviewer', 28, 2, false)).toBe(42);
  });

  it('counts issues per invocation using isolated invocation keys', () => {
    const orchestrator = Object.create(
      StreamingReviewOrchestrator.prototype
    ) as StreamingReviewOrchestrator & {
      issueCountByInvocation: Map<string, number>;
      getInvocationIssueCount: (invocationKey: string) => number;
    };

    orchestrator.issueCountByInvocation = new Map([
      ['logic-run-a', 0],
      ['logic-run-b', 2],
    ]);

    expect(orchestrator.getInvocationIssueCount('logic-run-a')).toBe(0);
    expect(orchestrator.getInvocationIssueCount('logic-run-b')).toBe(2);
  });
});
