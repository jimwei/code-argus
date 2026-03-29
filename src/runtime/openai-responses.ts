import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
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

type OpenAIFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

type OpenAIResponseInputItem = ResponseInputItem;

type OpenAIResponseInput = string | OpenAIResponseInputItem[];

type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeSchemaNullable(schema: unknown): unknown {
  if (!isPlainObject(schema)) {
    return schema;
  }

  if (Array.isArray(schema.anyOf)) {
    const hasNullVariant = schema.anyOf.some(
      (variant) => isPlainObject(variant) && variant.type === 'null'
    );
    if (hasNullVariant) {
      return schema;
    }

    return {
      ...schema,
      anyOf: [...schema.anyOf, { type: 'null' }],
    };
  }

  const nullableSchema: JsonSchema = { ...schema };

  if (Array.isArray(nullableSchema.enum) && !nullableSchema.enum.includes(null)) {
    nullableSchema.enum = [...nullableSchema.enum, null];
  }

  const schemaType = nullableSchema.type;
  if (typeof schemaType === 'string') {
    nullableSchema.type = [schemaType, 'null'];
    return nullableSchema;
  }

  if (Array.isArray(schemaType)) {
    nullableSchema.type = schemaType.includes('null') ? schemaType : [...schemaType, 'null'];
    return nullableSchema;
  }

  return {
    anyOf: [nullableSchema, { type: 'null' }],
  };
}

function normalizeToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeToolSchema(entry));
  }

  if (!isPlainObject(schema)) {
    return schema;
  }

  const normalized: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') {
      continue;
    }

    if (key === 'properties') {
      continue;
    }

    if (key === 'items') {
      normalized.items = normalizeToolSchema(value);
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      normalized[key] = value.map((entry) => normalizeToolSchema(entry));
      continue;
    }

    normalized[key] = value;
  }

  const schemaType = normalized.type;
  const isObjectSchema =
    schemaType === 'object' || (Array.isArray(schemaType) && schemaType.includes('object'));

  if (isObjectSchema) {
    const rawProperties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === 'string')
        : []
    );
    const properties: JsonSchema = {};

    for (const [name, propertySchema] of Object.entries(rawProperties)) {
      const normalizedProperty = normalizeToolSchema(propertySchema);
      properties[name] = required.has(name)
        ? normalizedProperty
        : makeSchemaNullable(normalizedProperty);
      required.add(name);
    }

    normalized.properties = properties;
    normalized.required = Array.from(required);
    normalized.additionalProperties = false;
  }

  return normalized;
}

function buildToolParameters(tool: RuntimeToolDefinition): Record<string, unknown> {
  return normalizeToolSchema(
    toJSONSchema(z.object(tool.inputSchema), {
      io: 'input',
    })
  ) as Record<string, unknown>;
}

function normalizeToolArguments<T>(value: T): T {
  if (value === null) {
    return undefined as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeToolArguments(entry)) as T;
  }

  if (isPlainObject(value)) {
    const normalizedEntries = Object.entries(value).map(([key, entryValue]) => [
      key,
      normalizeToolArguments(entryValue),
    ]);
    return Object.fromEntries(normalizedEntries) as T;
  }

  return value;
}

function createUserMessageInput(prompt: string): OpenAIResponseInputItem {
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: prompt,
      },
    ],
  };
}

function isFunctionCallOutputItem(item: unknown): item is OpenAIFunctionCallOutputItem {
  return Boolean(
    item &&
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'function_call_output' &&
      'call_id' in item &&
      typeof item.call_id === 'string' &&
      'output' in item &&
      typeof item.output === 'string'
  );
}

function isFunctionCallOutputInput(
  input: OpenAIResponseInput
): input is OpenAIFunctionCallOutputItem[] {
  return Array.isArray(input) && input.length > 0 && input.every(isFunctionCallOutputItem);
}

function isToolContinuationGatewayFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = 'status' in error ? error.status : undefined;
  const message = 'message' in error ? error.message : undefined;
  const upstreamError = 'error' in error && isPlainObject(error.error) ? error.error : undefined;
  const errorType = upstreamError?.type;
  const errorMessage = upstreamError?.message;

  return (
    status === 502 &&
    errorType === 'upstream_error' &&
    (message === '502 Upstream request failed' || errorMessage === 'Upstream request failed')
  );
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
    const ownsAbortController = !options.abortController;
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
        const conversationItems: OpenAIResponseInputItem[] = [];
        let previousResponseId: string | undefined;
        let statelessMode = false;
        let remainingTurns = Math.max(options.maxTurns, 1);

        for await (const promptInput of iteratePromptInputs(options.prompt)) {
          if (closed) {
            return;
          }

          conversationItems.push(createUserMessageInput(promptInput));
          let input: OpenAIResponseInput = statelessMode ? [...conversationItems] : promptInput;
          let lastText: string | undefined;
          let lastUsage: RuntimeUsage | undefined;

          while (remainingTurns > 0 && !closed) {
            remainingTurns--;

            const request = {
              model: options.model || defaultModel,
              input,
              ...(!statelessMode && previousResponseId
                ? { previous_response_id: previousResponseId }
                : {}),
              ...(openAITools
                ? {
                    tools: openAITools,
                    parallel_tool_calls: false,
                  }
                : {}),
            };

            let response: OpenAIResponse;
            try {
              response = (await client.responses.create(request, {
                signal: abortController.signal,
              })) as OpenAIResponse;
            } catch (error) {
              const shouldFallbackToStatelessReplay =
                !statelessMode &&
                previousResponseId &&
                isFunctionCallOutputInput(input) &&
                isToolContinuationGatewayFailure(error);

              if (!shouldFallbackToStatelessReplay) {
                throw error;
              }

              statelessMode = true;
              previousResponseId = undefined;
              input = [...conversationItems];
              response = (await client.responses.create(
                {
                  input,
                  model: options.model || defaultModel,
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
            }

            if (!statelessMode) {
              previousResponseId = response.id;
            }
            lastUsage = normalizeUsage(response.usage);
            const responseText = getResponseText(response);
            const responseOutputItems = Array.isArray(response.output)
              ? (response.output as OpenAIResponseInputItem[])
              : [];
            conversationItems.push(...responseOutputItems);

            if (responseText) {
              lastText = responseText;
              yield {
                type: 'assistant.text',
                text: responseText,
              };
            }

            const functionCalls = responseOutputItems.filter(isFunctionCallItem);
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

            const toolOutputs: OpenAIFunctionCallOutputItem[] = [];

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
                const args = normalizeToolArguments(JSON.parse(functionCall.arguments));
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

            conversationItems.push(...toolOutputs);
            input = statelessMode ? [...conversationItems] : toolOutputs;
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
        if (ownsAbortController) {
          abortController.abort();
        }
      },
    };
  }
}
