import OpenAI from 'openai';
import { z, toJSONSchema } from 'zod';

import type { ArgusRuntimeConfig } from '../config/env.js';
import type {
  AgentRuntime,
  RuntimeExecuteOptions,
  RuntimeExecution,
  RuntimeGenerateTextOptions,
  RuntimeGenerateTextResult,
  RuntimeToolDefinition,
  RuntimeUsage,
} from './types.js';

type OpenAIResponse = {
  id: string;
  status?: string | null;
  output?: unknown[];
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    message?: string;
  } | null;
};

type OpenAIFunctionCallItem = {
  type: 'function_call';
  name: string;
  call_id: string;
  arguments: string;
};

type OpenAIResponseInput =
  | string
  | Array<{ type: 'function_call_output'; call_id: string; output: string }>;

function buildToolParameters(tool: RuntimeToolDefinition): Record<string, unknown> {
  return toJSONSchema(z.object(tool.inputSchema), {
    io: 'input',
  }) as Record<string, unknown>;
}

function normalizeUsage(usage: OpenAIResponse['usage'] | undefined): RuntimeUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

function normalizeResponseStatus(response: OpenAIResponse): string {
  switch (response.status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'incomplete':
      return 'incomplete';
    default:
      return response.status || 'unknown';
  }
}

function getResponseError(response: OpenAIResponse): string | undefined {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.status === 'failed') {
    return 'OpenAI Responses request failed';
  }

  return undefined;
}

function getResponseText(response: OpenAIResponse): string | undefined {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const item of response.output) {
    if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'message') {
      continue;
    }

    if (!('content' in item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (
        content &&
        typeof content === 'object' &&
        'type' in content &&
        content.type === 'output_text' &&
        'text' in content &&
        typeof content.text === 'string'
      ) {
        texts.push(content.text);
      }
    }
  }

  return texts.length > 0 ? texts.join('') : undefined;
}

function isFunctionCallItem(item: unknown): item is OpenAIFunctionCallItem {
  return Boolean(
    item &&
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'function_call' &&
      'name' in item &&
      typeof item.name === 'string' &&
      'call_id' in item &&
      typeof item.call_id === 'string' &&
      'arguments' in item &&
      typeof item.arguments === 'string'
  );
}

function isAsyncIterablePrompt(
  prompt: RuntimeExecuteOptions['prompt']
): prompt is AsyncIterable<unknown> {
  return typeof prompt === 'object' && prompt !== null && Symbol.asyncIterator in prompt;
}

function getPromptText(promptItem: unknown): string {
  if (typeof promptItem === 'string') {
    return promptItem;
  }

  if (
    promptItem &&
    typeof promptItem === 'object' &&
    'message' in promptItem &&
    promptItem.message &&
    typeof promptItem.message === 'object' &&
    'content' in promptItem.message &&
    typeof promptItem.message.content === 'string'
  ) {
    return promptItem.message.content;
  }

  throw new Error('OpenAI Responses runtime requires prompt items to resolve to text content');
}

async function* iteratePromptInputs(
  prompt: RuntimeExecuteOptions['prompt']
): AsyncGenerator<string> {
  if (isAsyncIterablePrompt(prompt)) {
    for await (const promptItem of prompt) {
      yield getPromptText(promptItem);
    }
    return;
  }

  yield getPromptText(prompt);
}

function toolResultToOutput(result: Awaited<ReturnType<RuntimeToolDefinition['execute']>>): string {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return text || 'Tool completed successfully.';
}

export class OpenAIResponsesRuntime implements AgentRuntime {
  readonly kind = 'openai-responses';
  readonly client: OpenAI;

  constructor(
    readonly config: ArgusRuntimeConfig,
    client?: OpenAI
  ) {
    if (!config.openai) {
      throw new Error('OpenAI runtime requires openai credentials in the runtime config');
    }

    this.client =
      client ||
      new OpenAI({
        apiKey: config.openai.apiKey,
        ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
      });
  }

  async generateText(options: RuntimeGenerateTextOptions): Promise<RuntimeGenerateTextResult> {
    const response = (
      options.abortController
        ? await this.client.responses.create(
            {
              model: options.model || this.config.models.main,
              input: options.prompt,
            },
            {
              signal: options.abortController.signal,
            }
          )
        : await this.client.responses.create({
            model: options.model || this.config.models.main,
            input: options.prompt,
          })
    ) as OpenAIResponse;

    const error = getResponseError(response);
    if (error) {
      throw new Error(error);
    }

    return {
      text: getResponseText(response) || '',
      usage: normalizeUsage(response.usage),
    };
  }

  execute(options: RuntimeExecuteOptions): RuntimeExecution {
    const client = this.client;
    const defaultModel = this.config.models.main;
    const abortController = options.abortController ?? new AbortController();
    const runtimeTools = options.tools ?? [];
    const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const openAITools =
      runtimeTools.length > 0
        ? runtimeTools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: buildToolParameters(tool),
            strict: true,
          }))
        : undefined;

    let closed = false;

    return {
      async *[Symbol.asyncIterator]() {
        let previousResponseId: string | undefined;
        let remainingTurns = Math.max(options.maxTurns, 1);

        for await (const promptInput of iteratePromptInputs(options.prompt)) {
          if (closed) {
            return;
          }

          let input: OpenAIResponseInput = promptInput;
          let lastText: string | undefined;
          let lastUsage: RuntimeUsage | undefined;

          while (remainingTurns > 0 && !closed) {
            remainingTurns--;

            const response = (await client.responses.create(
              {
                model: options.model || defaultModel,
                input,
                ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
                ...(openAITools
                  ? {
                      tools: openAITools,
                      parallel_tool_calls: false,
                    }
                  : {}),
              },
              {
                signal: abortController.signal,
              }
            )) as OpenAIResponse;

            previousResponseId = response.id;
            lastUsage = normalizeUsage(response.usage);
            const responseText = getResponseText(response);
            if (responseText) {
              lastText = responseText;
              yield {
                type: 'assistant.text',
                text: responseText,
              };
            }

            const functionCalls = (response.output || []).filter(isFunctionCallItem);
            if (functionCalls.length === 0) {
              const error = getResponseError(response);
              yield {
                type: 'result',
                status: normalizeResponseStatus(response),
                text: responseText,
                usage: lastUsage,
                ...(error ? { error } : {}),
              };
              break;
            }

            const toolOutputs: Array<{
              type: 'function_call_output';
              call_id: string;
              output: string;
            }> = [];

            for (const functionCall of functionCalls) {
              yield {
                type: 'activity',
                event: `function_call:${functionCall.name}`,
              };

              const runtimeTool = toolsByName.get(functionCall.name);
              if (!runtimeTool) {
                toolOutputs.push({
                  type: 'function_call_output',
                  call_id: functionCall.call_id,
                  output: `Tool "${functionCall.name}" is not available.`,
                });
                continue;
              }

              try {
                const args = JSON.parse(functionCall.arguments);
                const result = await runtimeTool.execute(args);
                toolOutputs.push({
                  type: 'function_call_output',
                  call_id: functionCall.call_id,
                  output: toolResultToOutput(result),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                toolOutputs.push({
                  type: 'function_call_output',
                  call_id: functionCall.call_id,
                  output: `Tool "${functionCall.name}" failed: ${message}`,
                });
              }
            }

            input = toolOutputs;
          }

          if (!closed && remainingTurns === 0) {
            yield {
              type: 'result',
              status: 'error_max_turns',
              text: lastText,
              usage: lastUsage,
              error: 'OpenAI Responses runtime exhausted maxTurns while resolving tool calls',
            };
            return;
          }
        }
      },
      async close() {
        if (closed) {
          return;
        }

        closed = true;
        abortController.abort();
      },
    };
  }
}
