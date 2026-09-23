import OpenAI from 'openai';
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
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
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens: number;
  };
  error?: {
    message?: string;
  } | null;
};

type OpenAIFunctionCallItem = {
  id?: string;
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

type OpenAIItemReferenceInputItem = {
  type: 'item_reference';
  id: string;
};

type OpenAIUserPromptInputMode = 'message_list' | 'string';

type OpenAIConversationContinuationMode = 'managed' | 'stateless_full' | 'stateless_item_reference';

type OpenAIRequestTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
};

type OpenAIResponseRequest = {
  model: string;
  instructions?: string;
  input: OpenAIResponseInput;
  previous_response_id?: string;
  tools?: OpenAIRequestTool[];
  parallel_tool_calls?: false;
  max_output_tokens?: number;
  reasoning?: Reasoning | null;
};

type OpenAIResponseStream = AsyncIterable<ResponseStreamEvent> & {
  controller?: AbortController;
};

type JsonSchema = Record<string, unknown>;
type MutableJsonObject = Record<string, any>;

const DEFAULT_OPENAI_RESPONSES_INSTRUCTIONS =
  'Follow the user instructions and tool definitions exactly.';

/**
 * 收尾阶段的提示语。它必须出现在 input 的末尾而不是 instructions 里：
 * 上游（OpenAI / DeepSeek / 网关）按「前缀完全一致」判定 prompt cache 命中，
 * instructions 排在 payload 最前面，任何一轮改动都会让整段上下文重新计费。
 */
const COMPLETION_BUDGET_CLOSING_NOTE =
  'The closing phase has begun. Stop context exploration. Report concrete findings already supported by evidence, then finish with a brief summary. Zero issues is valid when review is complete. If evidence is insufficient to complete the review, call report_incomplete with the missing evidence; do not claim a clean review.';

/**
 * Reasoning 模型把 reasoning token 计入 max_output_tokens。预算耗尽时上游会把请求标记为
 * incomplete（`incomplete_details.reason=max_output_tokens`）并且只返回 reasoning 内容，
 * 没有任何可交付的文本。重试时把预算提升到这个下限。
 */
const ESCALATED_MAX_OUTPUT_TOKENS_FLOOR = 2048;
const ESCALATED_MAX_OUTPUT_TOKENS_CEILING = 8192;

/**
 * Builds the `reasoning` request fragment from the single global
 * ARGUS_REASONING_EFFORT value. Empty/undefined leaves the provider default.
 */
function buildReasoningRequest(effort: string | undefined): { reasoning?: Reasoning } {
  if (!effort) {
    return {};
  }

  return {
    reasoning: {
      effort: effort as Reasoning['effort'],
    },
  };
}

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

/**
 * 会话级固定 instructions：整轮 review 里每个请求都发同一份字节，
 * 这样 instructions + tools 组成的前缀才能稳定命中上游 prompt cache。
 */
function buildStableBudgetInstructions(totalTurns: number, reserveTurns: number): string {
  return (
    `${DEFAULT_OPENAI_RESPONSES_INSTRUCTIONS}\n` +
    `Review budget: ${totalTurns} requests for this review. ` +
    `Reserve the last ${reserveTurns} requests for reporting and completion. ` +
    'Stay within your specialist scope. ' +
    'If evidence is insufficient to complete the review, call report_incomplete instead of claiming a clean review.'
  );
}

/**
 * 每轮变化的预算提示。只允许追加在 input 末尾：
 * 前缀不变 → 已缓存上下文继续命中，只有新增的尾部需要重新计费。
 */
function buildTurnBudgetNote(
  remainingTurns: number,
  reserveTurns: number,
  closing: boolean
): string {
  return (
    `Review budget: ${remainingTurns} requests remaining (including this request). ` +
    (closing
      ? COMPLETION_BUDGET_CLOSING_NOTE
      : `Reserve the last ${reserveTurns} requests for reporting and completion. Stay within your specialist scope.`)
  );
}

function appendTurnNote(input: OpenAIResponseInput, note: string): OpenAIResponseInput {
  if (typeof input === 'string') {
    return `${input}\n\n${note}`;
  }

  return [...input, createUserMessageInput(note)];
}

function buildUserPromptInputVariants(
  prompt: string
): Array<{ mode: OpenAIUserPromptInputMode; input: OpenAIResponseInput }> {
  return [
    {
      mode: 'message_list',
      input: [createUserMessageInput(prompt)],
    },
    {
      mode: 'string',
      input: prompt,
    },
  ];
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

function containsFunctionCallOutputItems(
  input: OpenAIResponseInput
): input is OpenAIResponseInputItem[] {
  return Array.isArray(input) && input.some(isFunctionCallOutputItem);
}

function isReasoningItem(item: unknown): item is MutableJsonObject {
  return isPlainObject(item) && item.type === 'reasoning';
}

function hasEncryptedReasoningContent(item: MutableJsonObject): boolean {
  return typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
}

function shouldOmitFromStatelessReplay(item: OpenAIResponseInputItem): boolean {
  // Plain reasoning item IDs are not durable when store=false/ZDR; only encrypted reasoning can be replayed.
  return isReasoningItem(item) && !hasEncryptedReasoningContent(item);
}

function buildReplayableStatelessConversationItems(
  conversationItems: OpenAIResponseInputItem[]
): OpenAIResponseInputItem[] {
  return conversationItems.filter((item) => !shouldOmitFromStatelessReplay(item));
}

function getFunctionCallReferenceIds(item: OpenAIFunctionCallItem): string[] {
  const ids = new Set<string>();

  if (typeof item.id === 'string' && item.id.length > 0) {
    ids.add(item.id);
  }

  ids.add(item.call_id);
  return Array.from(ids);
}

function buildItemReferenceToolContinuationInput(
  conversationItems: OpenAIResponseInputItem[]
): OpenAIResponseInputItem[] {
  const referenceIdsByCallId = new Map<string, string[]>();
  const transformed: OpenAIResponseInputItem[] = [];

  for (const item of conversationItems) {
    if (isFunctionCallItem(item)) {
      referenceIdsByCallId.set(item.call_id, getFunctionCallReferenceIds(item));
      transformed.push(item);
      continue;
    }

    if (isFunctionCallOutputItem(item)) {
      const referenceIds = referenceIdsByCallId.get(item.call_id) ?? [item.call_id];
      for (const referenceId of referenceIds) {
        transformed.push({
          type: 'item_reference',
          id: referenceId,
        } as OpenAIItemReferenceInputItem);
      }
    }

    transformed.push(item);
  }

  return transformed;
}

function buildStatelessConversationInput(
  mode: Exclude<OpenAIConversationContinuationMode, 'managed'>,
  conversationItems: OpenAIResponseInputItem[]
): OpenAIResponseInputItem[] {
  const replayableItems = buildReplayableStatelessConversationItems(conversationItems);

  if (mode === 'stateless_item_reference') {
    return buildItemReferenceToolContinuationInput(replayableItems);
  }

  return replayableItems;
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

function isPreviousResponseIdUnsupportedError(error: unknown): boolean {
  if (getOpenAIErrorStatus(error) !== 400) {
    return false;
  }

  const message = getOpenAIErrorMessage(error)?.toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('previous_response_id') &&
    (message.includes('websocket v2') ||
      message.includes('responses websocket') ||
      message.includes('not supported'))
  );
}

function isNonPersistedItemReferenceError(error: unknown): boolean {
  if (getOpenAIErrorStatus(error) !== 404) {
    return false;
  }

  const message = getOpenAIErrorMessage(error)?.toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('item with id') &&
    message.includes('not found') &&
    (message.includes('items are not persisted') ||
      (message.includes('store') && message.includes('false')))
  );
}

function isItemReferenceRequiredError(error: unknown): boolean {
  const message = getOpenAIErrorMessage(error)?.toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('function_call_output') &&
    message.includes('item_reference') &&
    message.includes('call_id')
  );
}

/**
 * 上游只接受工具调用与工具输出成对出现，无法通过 previous_response_id 找到对应的
 * function_call 时会返回 400（"No tool call found for tool output with call_id ..."）。
 * 这类网关必须退化为无状态重放：把 function_call 和 function_call_output 一起发回去。
 */
function isOrphanedToolOutputError(error: unknown): boolean {
  const status = getOpenAIErrorStatus(error);
  // 网关也可能把这条校验错误放进 SSE 的 error 事件，此时抛出的 Error 上没有 status，
  // 因此只在状态码存在且不是 400 时排除。
  if (status !== undefined && status !== 400) {
    return false;
  }

  const message = getOpenAIErrorMessage(error)?.toLowerCase();
  if (!message) {
    return false;
  }

  return message.includes('no tool call found for') && message.includes('call_id');
}

function isMaxOutputTokensUnsupportedError(error: unknown): boolean {
  if (getOpenAIErrorStatus(error) !== 400) {
    return false;
  }

  const message = getOpenAIErrorMessage(error)?.toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('max_output_tokens') ||
    message.includes('max output tokens') ||
    message.includes('status code (no body)')
  );
}

function getOpenAIErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined;
  }

  return typeof error.status === 'number' ? error.status : undefined;
}

function getOpenAIErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if ('error' in error && isPlainObject(error.error) && typeof error.error.message === 'string') {
    return error.error.message;
  }

  if ('message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return undefined;
}

function isInputCompatibilityError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  const indicators = [
    'input must be a list',
    'input must be an array',
    'input should be a list',
    'input should be an array',
    'input must be a string',
    'input should be a string',
    'expected input to be a list',
    'expected input to be an array',
    'expected input to be a string',
    'invalid input type',
    'input format',
    'content must be a string',
    'content should be a string',
  ];

  return indicators.some((indicator) => normalized.includes(indicator));
}

function shouldRetryUserPromptAsString(mode: OpenAIUserPromptInputMode, error: unknown): boolean {
  return (
    mode === 'message_list' &&
    getOpenAIErrorStatus(error) === 400 &&
    isInputCompatibilityError(getOpenAIErrorMessage(error))
  );
}

function normalizeUsage(usage: OpenAIResponse['usage'] | undefined): RuntimeUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    outputTokens: usage.output_tokens,
  };
}

function createResponseSnapshot(response: OpenAIResponse): OpenAIResponse {
  const snapshot = cloneJson(response);
  snapshot.output = Array.isArray(snapshot.output) ? snapshot.output : [];
  return snapshot;
}

function mergeResponseSnapshot(
  snapshot: OpenAIResponse | undefined,
  response: OpenAIResponse
): OpenAIResponse {
  const merged = snapshot ? cloneJson(snapshot) : createResponseSnapshot(response);
  merged.id = response.id;
  merged.status = response.status ?? merged.status;
  merged.usage = response.usage ?? merged.usage;
  merged.error = response.error ?? merged.error;
  merged.incomplete_details = response.incomplete_details ?? merged.incomplete_details;

  if (typeof response.output_text === 'string') {
    merged.output_text = response.output_text;
  }

  if (Array.isArray(response.output) && response.output.length > 0) {
    merged.output = cloneJson(response.output);
  }

  return merged;
}

function ensureOutputItem(
  snapshot: OpenAIResponse,
  outputIndex: number
): MutableJsonObject | undefined {
  if (!Array.isArray(snapshot.output)) {
    snapshot.output = [];
  }

  const outputItem = snapshot.output[outputIndex];
  return isPlainObject(outputItem) ? outputItem : undefined;
}

function applyOutputItemAdded(snapshot: OpenAIResponse, event: ResponseStreamEvent): void {
  if (event.type !== 'response.output_item.added') {
    return;
  }

  if (!Array.isArray(snapshot.output)) {
    snapshot.output = [];
  }

  const item = cloneJson(event.item) as unknown as MutableJsonObject;
  if (item.type === 'message' && !Array.isArray(item.content)) {
    item.content = [];
  }
  if (item.type === 'function_call' && typeof item.arguments !== 'string') {
    item.arguments = '';
  }

  snapshot.output[event.output_index] = item;
}

function applyContentPartAdded(snapshot: OpenAIResponse, event: ResponseStreamEvent): void {
  if (event.type !== 'response.content_part.added') {
    return;
  }

  const outputItem = ensureOutputItem(snapshot, event.output_index);
  if (!outputItem || outputItem.type !== 'message') {
    return;
  }

  if (!Array.isArray(outputItem.content)) {
    outputItem.content = [];
  }

  outputItem.content[event.content_index] = cloneJson(event.part) as unknown as MutableJsonObject;
}

function ensureOutputTextContent(
  outputItem: MutableJsonObject,
  contentIndex: number
): MutableJsonObject {
  if (!Array.isArray(outputItem.content)) {
    outputItem.content = [];
  }

  let content = outputItem.content[contentIndex];
  if (!isPlainObject(content) || content.type !== 'output_text') {
    content = {
      type: 'output_text',
      text: '',
      annotations: [],
    } satisfies MutableJsonObject;
    outputItem.content[contentIndex] = content;
  }

  if (typeof content.text !== 'string') {
    content.text = '';
  }

  return content;
}

function applyOutputTextDelta(snapshot: OpenAIResponse, event: ResponseStreamEvent): void {
  if (event.type !== 'response.output_text.delta') {
    return;
  }

  const outputItem = ensureOutputItem(snapshot, event.output_index);
  if (!outputItem || outputItem.type !== 'message') {
    return;
  }

  const content = ensureOutputTextContent(outputItem, event.content_index);
  content.text = `${content.text}${event.delta}`;
}

function applyFunctionCallArgumentsDelta(
  snapshot: OpenAIResponse,
  event: ResponseStreamEvent
): void {
  if (event.type !== 'response.function_call_arguments.delta') {
    return;
  }

  const outputItem = ensureOutputItem(snapshot, event.output_index);
  if (!outputItem || outputItem.type !== 'function_call') {
    return;
  }

  if (typeof outputItem.arguments !== 'string') {
    outputItem.arguments = '';
  }

  outputItem.arguments = `${outputItem.arguments}${event.delta}`;
}

async function createOpenAIStreamSnapshot(
  client: OpenAI,
  request: OpenAIResponseRequest,
  signal?: AbortSignal
): Promise<OpenAIResponse> {
  const requestWithDefaults = {
    instructions: DEFAULT_OPENAI_RESPONSES_INSTRUCTIONS,
    ...request,
  };

  const stream = (
    signal
      ? await client.responses.create(
          {
            ...requestWithDefaults,
            stream: true,
          },
          { signal }
        )
      : await client.responses.create({
          ...requestWithDefaults,
          stream: true,
        })
  ) as OpenAIResponseStream;

  let snapshot: OpenAIResponse | undefined;
  let sawTerminalEvent = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'response.created':
        snapshot = createResponseSnapshot(event.response as OpenAIResponse);
        break;
      case 'response.output_item.added':
        if (!snapshot) {
          snapshot = createResponseSnapshot({
            id: '',
            output: [],
          });
        }
        applyOutputItemAdded(snapshot, event);
        break;
      case 'response.content_part.added':
        if (!snapshot) {
          snapshot = createResponseSnapshot({
            id: '',
            output: [],
          });
        }
        applyContentPartAdded(snapshot, event);
        break;
      case 'response.output_text.delta':
        if (!snapshot) {
          snapshot = createResponseSnapshot({
            id: '',
            output: [],
          });
        }
        applyOutputTextDelta(snapshot, event);
        break;
      case 'response.function_call_arguments.delta':
        if (!snapshot) {
          snapshot = createResponseSnapshot({
            id: '',
            output: [],
          });
        }
        applyFunctionCallArgumentsDelta(snapshot, event);
        break;
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
        snapshot = mergeResponseSnapshot(snapshot, event.response as OpenAIResponse);
        sawTerminalEvent = true;
        break;
      case 'error':
        throw new Error(event.message);
      default:
        break;
    }
  }

  if (!snapshot) {
    throw new Error('OpenAI Responses stream ended without a response');
  }

  if (!sawTerminalEvent) {
    throw new Error('OpenAI Responses stream ended before completion');
  }

  return snapshot;
}

async function createOpenAIStreamSnapshotForUserPrompt(
  client: OpenAI,
  request: Omit<OpenAIResponseRequest, 'input'> & {
    prompt: string;
  },
  signal?: AbortSignal
): Promise<OpenAIResponse> {
  let lastError: unknown;
  const { prompt, ...requestWithoutPrompt } = request;

  for (const variant of buildUserPromptInputVariants(prompt)) {
    try {
      return await createOpenAIStreamSnapshot(
        client,
        {
          ...requestWithoutPrompt,
          input: variant.input,
        },
        signal
      );
    } catch (error) {
      if (!shouldRetryUserPromptAsString(variant.mode, error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('OpenAI Responses request failed for all supported input formats');
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

/**
 * 判断一次 Responses 调用是否因为输出预算被 reasoning token 吃光而没有文本。
 * 有明确的 reason 时以它为准，避免把 content_filter 之类的终止原因当成预算不足重试。
 */
function isOutputBudgetExhausted(response: OpenAIResponse): boolean {
  const reason = response.incomplete_details?.reason;
  if (typeof reason === 'string' && reason.length > 0) {
    return reason === 'max_output_tokens';
  }

  return response.status === 'incomplete';
}

/**
 * 预算耗尽重试时使用的 max_output_tokens：在 [2048, 8192] 本地策略区间内按调用方预算翻倍。
 * 已达本地上限、或调用方预算非法（非正整数）时返回 undefined 表示不重试，
 * 避免基于错误配置或超出本地保护的数值再发一次请求；实际上限仍以 provider 为准。
 */
function escalateMaxOutputTokens(maxOutputTokens: number): number | undefined {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    return undefined;
  }

  const escalated = Math.min(
    ESCALATED_MAX_OUTPUT_TOKENS_CEILING,
    Math.max(ESCALATED_MAX_OUTPUT_TOKENS_FLOOR, maxOutputTokens * 2)
  );

  return escalated > maxOutputTokens ? escalated : undefined;
}

/**
 * 预算耗尽或空响应时保留 status/reason 与已消耗的 token，便于线上定位是预算不足还是上游异常。
 */
function buildNoTextError(
  response: OpenAIResponse,
  extra: { attempts: number; tokensUsed: number },
  cause?: unknown
): Error {
  const status = response.status ?? 'unknown';
  const reason = response.incomplete_details?.reason ?? 'unknown';

  return new Error(
    `OpenAI Responses stream completed without text output (status=${status}, reason=${reason}, attempts=${extra.attempts}, tokensUsed=${extra.tokensUsed})`,
    cause === undefined ? undefined : { cause }
  );
}

/**
 * 被放弃的尝试同样消耗 token，统计时与最终响应合并，避免少报成本。
 */
function mergeUsage(
  first: RuntimeUsage | undefined,
  second: RuntimeUsage | undefined
): RuntimeUsage | undefined {
  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  const cachedInputTokens = (first.cachedInputTokens ?? 0) + (second.cachedInputTokens ?? 0);
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    outputTokens: first.outputTokens + second.outputTokens,
  };
}

function totalTokens(usage: RuntimeUsage | undefined): number {
  return usage ? usage.inputTokens + usage.outputTokens : 0;
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
    const reasoningRequest = buildReasoningRequest(this.config.reasoningEffort);
    const request = {
      model: options.model || this.config.models.main,
      prompt: options.prompt,
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
      ...reasoningRequest,
    };

    let response: OpenAIResponse;
    let sentMaxOutputTokens = Boolean(request.max_output_tokens);
    let retriedOutputBudget = false;
    try {
      response = await createOpenAIStreamSnapshotForUserPrompt(
        this.client,
        request,
        options.abortController?.signal
      );
    } catch (error) {
      if (!request.max_output_tokens || !isMaxOutputTokensUnsupportedError(error)) {
        throw error;
      }

      sentMaxOutputTokens = false;
      const { max_output_tokens: _maxOutputTokens, ...requestWithoutMaxOutputTokens } = request;
      response = await createOpenAIStreamSnapshotForUserPrompt(
        this.client,
        requestWithoutMaxOutputTokens,
        options.abortController?.signal
      );
    }

    const error = getResponseError(response);
    if (error) {
      throw new Error(error);
    }

    let text = getResponseText(response);
    let spentUsage: RuntimeUsage | undefined;
    const escalatedMaxOutputTokens = sentMaxOutputTokens
      ? escalateMaxOutputTokens(options.maxOutputTokens ?? 0)
      : undefined;

    if (!text && escalatedMaxOutputTokens !== undefined && isOutputBudgetExhausted(response)) {
      // 推理长度波动会让同一请求偶尔吃光输出预算；升档重试一次，避免整条调用直接失败。
      spentUsage = normalizeUsage(response.usage);
      const exhaustedResponse = response;
      retriedOutputBudget = true;
      try {
        response = await createOpenAIStreamSnapshotForUserPrompt(
          this.client,
          {
            ...request,
            max_output_tokens: escalatedMaxOutputTokens,
          },
          options.abortController?.signal
        );
      } catch (retryFailure) {
        // 上游拒绝更大的预算时不再发第三次请求，保留原始的“无文本”失败语义。
        if (isMaxOutputTokensUnsupportedError(retryFailure)) {
          throw buildNoTextError(
            exhaustedResponse,
            {
              attempts: 2,
              tokensUsed: totalTokens(spentUsage),
            },
            retryFailure
          );
        }

        throw retryFailure;
      }

      const retryError = getResponseError(response);
      if (retryError) {
        throw new Error(retryError);
      }

      text = getResponseText(response);
    }

    if (!text) {
      throw buildNoTextError(response, {
        attempts: retriedOutputBudget ? 2 : 1,
        tokensUsed: totalTokens(spentUsage) + totalTokens(normalizeUsage(response.usage)),
      });
    }

    return {
      text,
      usage: mergeUsage(spentUsage, normalizeUsage(response.usage)),
    };
  }

  execute(options: RuntimeExecuteOptions): RuntimeExecution {
    const client = this.client;
    const defaultModel = this.config.models.main;
    const reasoningRequest = buildReasoningRequest(this.config.reasoningEffort);
    const abortController = options.abortController ?? new AbortController();
    const ownsAbortController = !options.abortController;
    const runtimeTools = options.tools ?? [];
    const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const openAITools: OpenAIRequestTool[] | undefined =
      runtimeTools.length > 0
        ? runtimeTools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: buildToolParameters(tool),
            strict: true as const,
          }))
        : undefined;

    const totalTurns = Math.max(options.maxTurns, 1);
    const completionBudget = options.completionBudget;
    // 前缀缓存：instructions 与 tools 在整个会话里保持字节一致，
    // 逐轮变化的预算提示只追加到 input 末尾。
    const stableInstructions = completionBudget
      ? buildStableBudgetInstructions(totalTurns, completionBudget.reserveTurns)
      : undefined;

    let closed = false;

    return {
      async *[Symbol.asyncIterator]() {
        const conversationItems: OpenAIResponseInputItem[] = [];
        let previousResponseId: string | undefined;
        let continuationMode: OpenAIConversationContinuationMode = 'managed';
        let remainingTurns = totalTurns;

        for await (const promptInput of iteratePromptInputs(options.prompt)) {
          if (closed) {
            return;
          }

          conversationItems.push(createUserMessageInput(promptInput));
          let input: OpenAIResponseInput =
            continuationMode === 'managed'
              ? promptInput
              : buildStatelessConversationInput(continuationMode, conversationItems);
          let lastText: string | undefined;
          let lastUsage: RuntimeUsage | undefined;
          let promptFinished = false;

          while (remainingTurns > 0 && !closed) {
            const closing = Boolean(
              completionBudget && remainingTurns <= completionBudget.reserveTurns
            );
            const turnBudgetNote = completionBudget
              ? buildTurnBudgetNote(remainingTurns, completionBudget.reserveTurns, closing)
              : undefined;
            remainingTurns--;

            let response: OpenAIResponse;
            while (true) {
              const requestInput = turnBudgetNote ? appendTurnNote(input, turnBudgetNote) : input;
              const request = {
                model: options.model || defaultModel,
                input: requestInput,
                ...(continuationMode === 'managed' && previousResponseId
                  ? { previous_response_id: previousResponseId }
                  : {}),
                ...(stableInstructions ? { instructions: stableInstructions } : {}),
                ...(openAITools
                  ? {
                      tools: openAITools,
                      parallel_tool_calls: false as const,
                    }
                  : {}),
                ...reasoningRequest,
              };

              try {
                response =
                  continuationMode === 'managed' && typeof input === 'string'
                    ? await createOpenAIStreamSnapshotForUserPrompt(
                        client,
                        {
                          model: request.model,
                          ...(request.instructions ? { instructions: request.instructions } : {}),
                          ...(request.previous_response_id
                            ? { previous_response_id: request.previous_response_id }
                            : {}),
                          ...(request.tools ? { tools: request.tools } : {}),
                          ...(request.parallel_tool_calls !== undefined
                            ? { parallel_tool_calls: request.parallel_tool_calls }
                            : {}),
                          ...(request.reasoning ? { reasoning: request.reasoning } : {}),
                          prompt: typeof requestInput === 'string' ? requestInput : input,
                        },
                        abortController.signal
                      )
                    : await createOpenAIStreamSnapshot(client, request, abortController.signal);
                break;
              } catch (error) {
                const shouldFallbackToStatelessReplay =
                  continuationMode === 'managed' &&
                  ((previousResponseId &&
                    (isPreviousResponseIdUnsupportedError(error) ||
                      isNonPersistedItemReferenceError(error))) ||
                    // 只带工具输出的续链请求即使没有 previous_response_id（上游只在
                    // response.created 给 id 时会出现）也可能被网关以同一条 400 拒绝，
                    // 本地已有完整历史，可以直接降级为无状态重放。
                    (isFunctionCallOutputInput(input) &&
                      (isToolContinuationGatewayFailure(error) ||
                        isOrphanedToolOutputError(error))));

                if (shouldFallbackToStatelessReplay) {
                  continuationMode = 'stateless_full';
                  previousResponseId = undefined;
                  input = buildStatelessConversationInput(continuationMode, conversationItems);
                  continue;
                }

                const shouldFallbackToItemReferenceReplay =
                  continuationMode === 'stateless_full' &&
                  containsFunctionCallOutputItems(input) &&
                  isItemReferenceRequiredError(error);

                if (shouldFallbackToItemReferenceReplay) {
                  continuationMode = 'stateless_item_reference';
                  input = buildStatelessConversationInput(continuationMode, conversationItems);
                  continue;
                }

                throw error;
              }
            }

            if (continuationMode === 'managed') {
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

            const functionCalls = responseOutputItems.filter(
              (item): item is OpenAIFunctionCallItem => isFunctionCallItem(item)
            );
            if (functionCalls.length === 0) promptFinished = true;
            if (response.status === 'completed' && !responseText && functionCalls.length === 0) {
              yield {
                type: 'result',
                status: 'error_empty_output',
                usage: lastUsage,
                error: 'OpenAI Responses stream completed without text or tool calls',
              };
              break;
            }

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

              if (closing && !completionBudget!.toolNames.includes(functionCall.name)) {
                toolOutputs.push({
                  type: 'function_call_output',
                  call_id: functionCall.call_id,
                  output:
                    'Context tools are unavailable in the closing phase. Finish from existing evidence or call report_incomplete.',
                });
                continue;
              }
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
            input =
              continuationMode === 'managed'
                ? toolOutputs
                : buildStatelessConversationInput(continuationMode, conversationItems);
          }

          if (!closed && remainingTurns === 0 && !promptFinished) {
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
