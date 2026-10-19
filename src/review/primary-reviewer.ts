import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { loadCustomAgentFile } from './custom-agents/loader.js';
import type { LoadedCustomAgent } from './custom-agents/types.js';
import { getRecommendedMaxTurns } from './constants.js';

export type ReviewStrategy = 'multi' | 'single';

export function parseReviewStrategy(value?: string): ReviewStrategy {
  const strategy = value?.trim() || 'multi';
  if (strategy !== 'multi' && strategy !== 'single') {
    throw new Error(`Invalid review strategy "${strategy}": expected multi or single`);
  }
  return strategy;
}

export async function loadPrimaryReviewer(file?: string): Promise<LoadedCustomAgent> {
  const path =
    file?.trim() ||
    fileURLToPath(new URL('./prompts/templates/comprehensive-reviewer.yaml', import.meta.url));
  const reviewer = await loadCustomAgentFile(path, true);
  if (reviewer.enabled === false)
    throw new Error(`Primary reviewer "${reviewer.name}" is disabled`);
  return reviewer;
}

export function isPrimaryReviewer(agent: LoadedCustomAgent, primary?: LoadedCustomAgent): boolean {
  return (
    !!primary &&
    (agent.id === primary.id || resolve(agent.source_file) === resolve(primary.source_file))
  );
}

export function getPrimaryReviewerMaxTurns(
  reviewer: LoadedCustomAgent,
  files: number,
  attempt = 1
): number {
  const base = reviewer.max_turns ?? getRecommendedMaxTurns(files) * 2;
  return Math.max(24, Math.min(500, Math.ceil(base * (attempt > 1 ? 1.25 : 1))));
}
