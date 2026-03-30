import type { ZodRawShape } from 'zod';

import type { ArgusRuntimeConfig, ArgusRuntimeType } from '../config/env.js';

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RuntimeTextContentBlock {
  type: 'text';
  text: string;
}

export interface RuntimeToolResult {
  content: RuntimeTextContentBlock[];
}

export interface RuntimeToolDefinition<TArgs = any> {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  execute: (args: TArgs) => Promise<RuntimeToolResult>;
}

export interface RuntimeExecuteOptions {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  maxTurns: number;
  model?: string;
  settingSources?: string[];
  abortController?: AbortController;
  tools?: RuntimeToolDefinition<any>[];
  toolNamespace?: string;
}

export interface RuntimeGenerateTextOptions {
  prompt: string;
  model?: string;
  maxOutputTokens?: number;
  abortController?: AbortController;
}

export interface RuntimeGenerateTextResult {
  text: string;
  usage?: RuntimeUsage;
}

export interface RuntimeAssistantTextEvent {
  type: 'assistant.text';
  text: string;
}

export interface RuntimeActivityEvent {
  type: 'activity';
  event: string;
}

export interface RuntimeResultEvent {
  type: 'result';
  status: string;
  text?: string;
  usage?: RuntimeUsage;
  error?: string;
}

export type RuntimeEvent = RuntimeAssistantTextEvent | RuntimeActivityEvent | RuntimeResultEvent;

export interface RuntimeExecution extends AsyncIterable<RuntimeEvent> {
  close(): Promise<void>;
}

export interface AgentRuntime {
  kind: ArgusRuntimeType;
  config: ArgusRuntimeConfig;
  generateText(options: RuntimeGenerateTextOptions): Promise<RuntimeGenerateTextResult>;
  execute(options: RuntimeExecuteOptions): RuntimeExecution;
}
