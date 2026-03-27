/**
 * Custom Agent Executor
 *
 * Executes custom agents through the active runtime with local tool reporting.
 */

import { z } from 'zod';

import { createRuntimeFromEnv } from '../../runtime/factory.js';
import type { RuntimeExecution, RuntimeToolDefinition } from '../../runtime/types.js';
import type { IssueCategory, RawIssue, Severity } from '../types.js';
import type { CustomAgentIssue, CustomAgentResult, LoadedCustomAgent } from './types.js';
import { CUSTOM_AGENT_DEFAULTS } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for executing custom agents
 */
export interface CustomAgentExecutorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Repository path for agent execution */
  repoPath: string;
  /** Diff content to review */
  diffContent: string;
  /** File analyses summary */
  fileAnalysesSummary?: string;
  /** Project standards text */
  standardsText?: string;
  /** Max turns for agent execution */
  maxTurns?: number;
  /** Output language for review comments */
  language?: 'en' | 'zh';
}

/**
 * Callback interface for custom agent execution
 */
export interface CustomAgentExecutorCallbacks {
  /** Called when an issue is discovered */
  onIssueDiscovered?: (issue: RawIssue) => void;
  /** Called when agent starts */
  onAgentStart?: (agent: LoadedCustomAgent) => void;
  /** Called when agent completes */
  onAgentComplete?: (agent: LoadedCustomAgent, result: CustomAgentResult) => void;
  /** Called when agent fails */
  onAgentError?: (agent: LoadedCustomAgent, error: Error) => void;
}

// ============================================================================
// Prompt Builders
// ============================================================================

function buildCustomAgentSystemPrompt(
  agent: LoadedCustomAgent,
  language: 'en' | 'zh' = 'zh'
): string {
  const category = agent.output?.category || CUSTOM_AGENT_DEFAULTS.output.category;
  const defaultSeverity = agent.output?.default_severity || 'warning';
  const langLabel = language === 'en' ? 'English' : 'Chinese';

  return `# ${agent.name}

${agent.description}

You are a focused code review agent. Review only the provided diff and report concrete, actionable issues.

Instructions:
1. Read the diff carefully and follow the agent-specific prompt below.
2. Use \`report_issue\` for each issue you find.
3. Write \`title\`, \`description\`, and \`suggestion\` in ${langLabel}.
4. Use category \`${category}\` unless you have a better fit.
5. Default severity is \`${defaultSeverity}\` when the issue does not need escalation.
6. Confidence must be a number between 0 and 1.

Agent-specific review focus:
${agent.prompt}`;
}

function buildCustomAgentUserPrompt(
  diffContent: string,
  fileAnalysesSummary?: string,
  standardsText?: string
): string {
  const sections: string[] = [];

  if (standardsText) {
    sections.push('## Project Standards');
    sections.push(standardsText);
    sections.push('');
  }

  if (fileAnalysesSummary) {
    sections.push('## File Analysis Summary');
    sections.push(fileAnalysesSummary);
    sections.push('');
  }

  sections.push('## Diff');
  sections.push('```diff');
  sections.push(diffContent);
  sections.push('```');
  sections.push('');
  sections.push('Report every issue through the `report_issue` tool.');

  return sections.join('\n');
}

interface ReportIssueArgs {
  file: string;
  line_start: number;
  line_end: number;
  severity?: Severity;
  category?: IssueCategory;
  title: string;
  description: string;
  suggestion?: string;
  code_snippet?: string;
  confidence: number;
}

// ============================================================================
// Runtime Tool Factory
// ============================================================================

function createCustomAgentRuntimeTools(
  agent: LoadedCustomAgent,
  onIssue: (issue: RawIssue) => void,
  language: 'en' | 'zh' = 'zh',
  verbose?: boolean
): RuntimeToolDefinition<ReportIssueArgs>[] {
  const defaultCategory = agent.output?.category || CUSTOM_AGENT_DEFAULTS.output.category;
  const defaultSeverity = agent.output?.default_severity;
  const langLabel = language === 'en' ? 'English' : 'Chinese';

  return [
    {
      name: 'report_issue',
      description: `Report a discovered code issue. Call this for EACH issue found during review.
Write all text (title, description, suggestion) in ${langLabel}.`,
      inputSchema: {
        file: z.string().describe('File path where the issue is located'),
        line_start: z.number().describe('Starting line number'),
        line_end: z.number().describe('Ending line number'),
        severity: z
          .enum(['critical', 'error', 'warning', 'suggestion'])
          .optional()
          .describe(`Issue severity level (default: ${defaultSeverity || 'warning'})`),
        category: z
          .enum(['security', 'logic', 'performance', 'style', 'maintainability'])
          .optional()
          .describe(`Issue category (default: ${defaultCategory})`),
        title: z.string().describe(`Short title in ${langLabel}`),
        description: z.string().describe(`Detailed description in ${langLabel}`),
        suggestion: z.string().optional().describe(`Fix suggestion in ${langLabel}`),
        code_snippet: z.string().optional().describe('Relevant code snippet'),
        confidence: z.number().min(0).max(1).describe('Confidence level (0-1)'),
      },
      async execute(args) {
        if (verbose) {
          console.log(`[CustomAgent:${agent.name}] report_issue: ${args.title}`);
        }

        const issueId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const rawIssue: RawIssue = {
          id: issueId,
          file: args.file,
          line_start: args.line_start,
          line_end: args.line_end,
          severity: (args.severity || defaultSeverity || 'warning') as Severity,
          category: (args.category || defaultCategory) as IssueCategory,
          title: args.title,
          description: args.description,
          suggestion: args.suggestion,
          code_snippet: args.code_snippet,
          confidence: args.confidence,
          source_agent: agent.id as RawIssue['source_agent'],
        };

        onIssue(rawIssue);

        return {
          content: [{ type: 'text' as const, text: `Issue recorded (ID: ${issueId})` }],
        };
      },
    },
  ];
}

// ============================================================================
// Executor
// ============================================================================

/**
 * Execute a single custom agent
 */
export async function executeCustomAgent(
  agent: LoadedCustomAgent,
  options: CustomAgentExecutorOptions,
  callbacks?: CustomAgentExecutorCallbacks
): Promise<CustomAgentResult> {
  const startTime = Date.now();
  const issues: CustomAgentIssue[] = [];

  if (options.verbose) {
    console.log(`[CustomAgentExecutor] Starting agent: ${agent.name}`);
  }

  callbacks?.onAgentStart?.(agent);

  const onIssue = (rawIssue: RawIssue) => {
    const customIssue: CustomAgentIssue = {
      id: rawIssue.id,
      file: rawIssue.file,
      line_start: rawIssue.line_start,
      line_end: rawIssue.line_end,
      category: rawIssue.category,
      severity: rawIssue.severity,
      title: rawIssue.title,
      description: rawIssue.description,
      suggestion: rawIssue.suggestion,
      confidence: rawIssue.confidence,
      source_agent: agent.id,
    };
    issues.push(customIssue);
    callbacks?.onIssueDiscovered?.(rawIssue);
  };

  const runtime = createRuntimeFromEnv();
  const runtimeTools = createCustomAgentRuntimeTools(
    agent,
    onIssue,
    options.language,
    options.verbose
  );
  const systemPrompt = buildCustomAgentSystemPrompt(agent, options.language);
  const userPrompt = buildCustomAgentUserPrompt(
    options.diffContent,
    options.fileAnalysesSummary,
    options.standardsText
  );
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  let tokensUsed = 0;
  let execution: RuntimeExecution | null = null;
  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  try {
    execution = runtime.execute({
      prompt: fullPrompt,
      cwd: options.repoPath,
      maxTurns: options.maxTurns || 20,
      toolNamespace: 'custom-agent-tools',
      tools: runtimeTools,
    });

    let isCleaningUp = false;
    const cleanupAndExit = async (signal: string) => {
      if (isCleaningUp || !execution) return;
      isCleaningUp = true;
      console.log(`[CustomAgentExecutor:${agent.name}] Received ${signal}, cleaning up...`);
      try {
        await execution.close();
      } catch {
        // Ignore cleanup errors during shutdown.
      }
      process.exit(0);
    };

    sigtermHandler = () => cleanupAndExit('SIGTERM');
    sigintHandler = () => cleanupAndExit('SIGINT');
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);

    for await (const event of execution) {
      if (event.type !== 'result') {
        continue;
      }

      if (event.usage) {
        tokensUsed = event.usage.inputTokens + event.usage.outputTokens;
      }

      if (event.status !== 'success' && options.verbose) {
        console.error(`[CustomAgentExecutor] Agent ${agent.name} error:`, event.status);
      }
    }

    const result: CustomAgentResult = {
      agent_id: agent.id,
      agent_name: agent.name,
      issues,
      tokens_used: tokensUsed,
      execution_time_ms: Date.now() - startTime,
    };

    if (options.verbose) {
      console.log(
        `[CustomAgentExecutor] Agent ${agent.name} completed: ${issues.length} issues, ${tokensUsed} tokens`
      );
    }

    callbacks?.onAgentComplete?.(agent, result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (options.verbose) {
      console.error(`[CustomAgentExecutor] Agent ${agent.name} failed:`, error);
    }

    callbacks?.onAgentError?.(agent, error instanceof Error ? error : new Error(errorMessage));

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      issues,
      tokens_used: tokensUsed,
      execution_time_ms: Date.now() - startTime,
      error: errorMessage,
    };
  } finally {
    if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
    if (sigintHandler) process.off('SIGINT', sigintHandler);

    if (execution) {
      try {
        await execution.close();
      } catch (cleanupError) {
        if (options.verbose) {
          console.warn(
            `[CustomAgentExecutor] Cleanup warning for agent ${agent.name}:`,
            cleanupError
          );
        }
      }
    }
  }
}

/**
 * Execute multiple custom agents in parallel
 */
export async function executeCustomAgents(
  agents: LoadedCustomAgent[],
  options: CustomAgentExecutorOptions,
  callbacks?: CustomAgentExecutorCallbacks,
  maxConcurrency: number = 4
): Promise<CustomAgentResult[]> {
  if (agents.length === 0) {
    return [];
  }

  if (options.verbose) {
    console.log(
      `[CustomAgentExecutor] Executing ${agents.length} agents (concurrency: ${maxConcurrency})`
    );
  }

  const results: CustomAgentResult[] = [];
  const executing: Promise<void>[] = [];

  for (const agent of agents) {
    const promise = executeCustomAgent(agent, options, callbacks).then((result) => {
      results.push(result);
    });

    executing.push(promise);

    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
      const completedIndices: number[] = [];
      for (let i = 0; i < executing.length; i++) {
        const isSettled = await Promise.race([
          executing[i]!.then(() => true).catch(() => true),
          Promise.resolve(false),
        ]);
        if (isSettled) {
          completedIndices.push(i);
        }
      }
      for (const index of completedIndices.reverse()) {
        executing.splice(index, 1);
      }
    }
  }

  await Promise.all(executing);

  return results;
}

/**
 * Convert custom agent issues to raw issues for validation
 */
export function customIssuesToRawIssues(results: CustomAgentResult[]): RawIssue[] {
  const rawIssues: RawIssue[] = [];

  for (const result of results) {
    for (const issue of result.issues) {
      rawIssues.push({
        id: issue.id,
        file: issue.file,
        line_start: issue.line_start,
        line_end: issue.line_end,
        category: issue.category,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        suggestion: issue.suggestion,
        confidence: issue.confidence,
        source_agent: issue.source_agent as RawIssue['source_agent'],
      });
    }
  }

  return rawIssues;
}
