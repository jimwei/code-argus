/**
 * OpenAI Responses runtime built on @earendil-works/pi-ai.
 *
 * 这个文件以前自己实现了 SSE 解析、流式快照重建、`previous_response_id` 续链、
 * 无状态重放，以及一大堆网关兼容探测（item reference、孤立 tool output、
 * `max_output_tokens` 不支持等）。这些现在都由 pi-ai 负责：它每次都以
 * `store: false` + 完整 transcript 发请求，并在库内完成事件流的组装与错误归一化。
 *
 * 本文件只保留编排层需要的东西：
 * - 工具 schema 转换（zod → JSON Schema → pi-ai Tool）
 * - turn 循环、maxTurns、收尾阶段（completionBudget）与工具执行
 * - 输出预算被 reasoning 吃光时的一次升档重试
 *
 * `RuntimeEvent` 契约保持不变，orchestrator / validator 无需改动。
 */
import { Type } from '@earendil-works/pi-ai';
import { completeSimple, streamSimple } from '@earendil-works/pi-ai/compat';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  Tool as PiTool,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
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
import { compactTranscript, estimateTextTokens } from './transcript-budget.js';
import {
  calculateRetryDelayMs,
  createAbortError,
  createStreamIdleWatchdog,
  DEFAULT_PROVIDER_MAX_RETRIES,
  getRetryAfterMs,
  throwIfAborted,
  waitForRetry,
} from '../review/retry-policy.js';

/** 网关真实上下文长度不可知；pi-ai 用它裁剪 maxTokens。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** pi-ai 内部使用的模型输出上限；出站请求不再携带 max_output_tokens（见 buildPiModel）。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** 与旧实现一致：没有会话级 instructions 时的兜底指令。 */
const DEFAULT_RUNTIME_INSTRUCTIONS = 'Follow the user instructions and tool definitions exactly.';

/** The runtime owns the existing provider budget; pi-ai must make one request per attempt. */
const PI_PROVIDER_MAX_RETRIES = 0;

export type PiStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream;

export type PiCompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => Promise<AssistantMessage>;

export interface OpenAIResponsesRuntimeDeps {
  /** 测试注入点：替换真实的 pi-ai 实现。 */
  streamSimple?: PiStreamFn;
  completeSimple?: PiCompleteFn;
  model?: Model<'openai-responses'>;
}

/**
 * 构造 pi-ai 的模型描述。只有显式配置了推理强度才声明 `reasoning`，
 * 否则 pi-ai 会主动补一个默认 effort，从而覆盖网关自身的默认值。
 */
export function buildPiModel(
  config: ArgusRuntimeConfig,
  modelId: string = config.models.main,
  reasoningEffort: string | undefined = config.reasoningEffort
): Model<'openai-responses'> {
  const baseUrl = (config.openai?.baseUrl ?? '').trim().replace(/\/+$/, '');
  // 只认 pi-ai 词汇表里的档位 + 显式 none；未知值按未配置处理（见 resolveConfiguredEffort）。
  const hasReasoning = resolveConfiguredEffort(reasoningEffort) !== undefined;

  return {
    id: modelId,
    name: modelId,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: baseUrl
      ? baseUrl.endsWith('/v1')
        ? baseUrl
        : `${baseUrl}/v1`
      : 'https://api.openai.com/v1',
    reasoning: hasReasoning,
    // xhigh/max 只有在 thinkingLevelMap 里显式声明后 pi-ai 才会接受。
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    compat: {
      // 工具 schema 已由本文件归一化成 strict 形态（见 normalizeToolSchema），
      // 因此显式要求 pi-ai 发送 strict: true；该开关默认是 false。
      supportsStrictMode: true,
      // 整个 pi-ai 路径不再发送 max_output_tokens（SDK 也不为 agent 轮次发送）：
      // 32k 上限会被长推理整轮吃光，上游返回 incomplete(max_output_tokens) 后编排层
      // 整轮重试该 agent——103 实测单次浪费约 600K token 与数分钟墙钟。
      supportsMaxOutputTokens: false,
      // 仅决定 pi-ai 构造首条指令的角色；该指令随后会被搬到顶层 `instructions`
      // （见 liftInstructionsToPayload），因此对出站请求不再有影响。
      supportsDeveloperRole: config.openai?.supportsDeveloperRole ?? true,
    },
  };
}

/** pi-ai 认可的 thinking level 词汇表。 */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

let warnedUnknownReasoningEffort = false;

/**
 * 解析 ARGUS_REASONING_EFFORT：`off` 表示显式关闭推理（仍声明模型支持推理，
 * pi-ai 会据此写 `reasoning.effort=none`）。
 *
 * 未知取值必须在这里拦掉：pi-ai 的 `clampThinkingLevel` 对不认识的档位会退化成
 * 词表里的第一个可用档位（`off`，也就是 `reasoning.effort=none`），直接透传等于把
 * 「网关默认」悄悄换成「关闭推理」。这里按未配置处理（完全不发 reasoning 字段），
 * 并只告警一次。
 */
function resolveConfiguredEffort(effort: string | undefined): ThinkingLevel | 'off' | undefined {
  const trimmed = effort?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === 'none') {
    return 'off';
  }

  if (THINKING_LEVEL_SET.has(trimmed)) {
    return trimmed as ThinkingLevel;
  }

  if (!warnedUnknownReasoningEffort) {
    warnedUnknownReasoningEffort = true;
    console.warn(
      `[OpenAIResponsesRuntime] Unsupported ARGUS_REASONING_EFFORT "${trimmed}"; expected one of: ${THINKING_LEVELS.join(', ')}, none. Falling back to the provider default.`
    );
  }

  return undefined;
}

/**
 * ARGUS_REASONING_EFFORT → pi-ai thinking level。
 * pi-ai 的 ThinkingLevel 没有 `off`：`none` 与「未配置」都不传档位，
 * 两者的差别由 `model.reasoning` 是否声明决定。
 */
export function toThinkingLevel(effort: string | undefined): ThinkingLevel | undefined {
  const resolved = resolveConfiguredEffort(effort);
  return resolved && resolved !== 'off' ? resolved : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * pi-ai 默认把会话指令放在 `input[0]`（推理开启时为 `developer` 角色消息）。
 * SDK 实现与官方 Responses 语义都使用顶层 `instructions` 字段；103 实测把同一段
 * 指令从 developer 消息移到 `instructions` 后，四个 reviewer 的工具调用轮数从
 * 80–103 降到 44–67、总 token 从 3.3–4.7M 降到 2.3–3.1M（同窗 SDK 为 2.2–2.5M）。
 * 这里在出站 payload 上做等价的搬运，保持与 SDK 相同的请求形态。
 */
function liftInstructionsToPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const params = payload as Record<string, unknown>;
  if (typeof params.instructions === 'string' && params.instructions.length > 0) {
    return params;
  }

  const input = params.input;
  if (!Array.isArray(input) || input.length === 0) {
    return params;
  }

  const first = input[0];
  if (
    isPlainObject(first) &&
    (first.role === 'developer' || first.role === 'system') &&
    typeof first.content === 'string'
  ) {
    params.instructions = first.content;
    params.input = input.slice(1);
  }

  return params;
}

type JsonSchema = Record<string, unknown>;

/** 可选字段在 strict 模式下必须显式允许 null，否则网关会以 400 拒绝。 */
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

/**
 * OpenAI 的 strict function tool 要求：object schema 上 `additionalProperties: false`、
 * `required` 覆盖所有字段（可选字段用 nullable 表达），且不能出现 `$schema`。
 * 这里递归处理 `items`/`anyOf`/`oneOf`/`allOf`；pi-ai 会把 schema 原样放进请求。
 */
function normalizeToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeToolSchema(entry));
  }

  if (!isPlainObject(schema)) {
    return schema;
  }

  const normalized: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' || key === 'properties') {
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

export function buildToolParameters(tool: RuntimeToolDefinition): Record<string, unknown> {
  return normalizeToolSchema(
    toJSONSchema(z.object(tool.inputSchema), {
      io: 'input',
    })
  ) as Record<string, unknown>;
}

/** RuntimeToolDefinition → pi-ai Tool（TypeBox 只作为 JSON Schema 的载体）。 */
export function toPiTool(tool: RuntimeToolDefinition): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(buildToolParameters(tool)),
    /**
     * pi-ai 只在工具声明 json_schema 约束采样时才发送 `strict: true`
     * （convertResponsesTools 的 defaultStrict 默认为 false）。旧实现每个工具都发 strict:true，
     * 因此这里显式声明。
     *
     * 用 `prefer` 而不是 `require`：schema 满足 strict 子集时照常发 strict:true（当前所有内置
     * 工具都属于这一类），而带 `z.record` 之类形状的工具会退化成非 strict，而不是让整轮 review
     * 直接失败——编排层更在意「跑完」。
     */
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
  };
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

/**
 * 前缀缓存：instructions 与 tools 在整个会话里保持字节一致，
 * 逐轮变化的预算提示只追加到 transcript 末尾。
 */
export function buildStableBudgetInstructions(totalTurns: number, reserveTurns: number): string {
  return [
    DEFAULT_RUNTIME_INSTRUCTIONS,
    'You are one specialist reviewer inside a multi-agent code review pipeline.',
    `This session has at most ${totalTurns} model turns in total.`,
    `Reserve the last ${reserveTurns} turns for reporting: stop exploring context once that phase starts.`,
    'Call report_issue as soon as an issue is supported by evidence; call report_incomplete when the evidence is not sufficient.',
  ].join('\n');
}

export function buildTurnBudgetNote(
  remainingTurns: number,
  reserveTurns: number,
  closing: boolean
): string {
  const suffix = closing
    ? 'The closing phase has begun. Stop context exploration. Report concrete findings already supported by evidence, then finish with a brief summary. Zero issues is valid when review is complete. If evidence is insufficient to complete the review, call report_incomplete with the missing evidence; do not claim a clean review.'
    : `Reserve the last ${reserveTurns} requests for reporting and completion. Stay within your specialist scope.`;

  return `Review budget: ${remainingTurns} requests remaining (including this request). ${suffix}`;
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

export function extractAssistantText(message: AssistantMessage | undefined): string | undefined {
  const text = message?.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return text && text.length > 0 ? text : undefined;
}

/**
 * pi-ai 的 `usage.input` 已经扣掉缓存命中，这里加回来以保持改造前
 * 「input_tokens + output_tokens」的统计口径。
 */
export function normalizeUsage(message: AssistantMessage | undefined): RuntimeUsage | undefined {
  const usage = message?.usage;
  if (!usage) {
    return undefined;
  }

  const cachedInputTokens = usage.cacheRead;
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    outputTokens: usage.output,
  };
}

/** pi-ai does not finalize usage on response.failed; preserve the upstream record directly. */
function normalizeProviderUsage(event: unknown): RuntimeUsage | undefined {
  if (!isPlainObject(event) || !isPlainObject(event.response)) return undefined;
  const usage = event.response.usage;
  if (
    !isPlainObject(usage) ||
    typeof usage.input_tokens !== 'number' ||
    typeof usage.output_tokens !== 'number'
  )
    return undefined;
  const cachedInputTokens =
    isPlainObject(usage.input_tokens_details) &&
    typeof usage.input_tokens_details.cached_tokens === 'number'
      ? usage.input_tokens_details.cached_tokens
      : 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

/** 预算耗尽或空响应时保留 stopReason 与已消耗的 token，便于线上定位。 */
function buildNoTextError(
  message: AssistantMessage,
  extra: { attempts: number; tokensUsed: number },
  cause?: unknown
): Error {
  return new Error(
    `OpenAI Responses stream completed without text output (stopReason=${message.stopReason}, rawStopReason=${message.rawStopReason ?? 'unknown'}, attempts=${extra.attempts}, tokensUsed=${extra.tokensUsed})`,
    cause === undefined ? undefined : { cause }
  );
}

/** 被放弃的尝试同样消耗 token，统计时与最终响应合并，避免少报成本。 */
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

/**
 * pi-ai 把 provider 错误归一化成 `"<prefix> (<status>): <body>"` 后塞进
 * `AssistantMessage.errorMessage`，错误对象本身不再带 status。调用方
 * （如 realtime-deduplicator）按 `error.status` 判断是否重试，这里把状态码还原回去。
 */
function createProviderError(errorMessage: string, retryAfterMs?: number): Error {
  const error = new Error(errorMessage);
  const status = /\((\d{3})\)/.exec(errorMessage)?.[1] ?? /^(\d{3})\b/.exec(errorMessage)?.[1];
  if (status) {
    (error as Error & { status?: number }).status = Number.parseInt(status, 10);
  }
  if (retryAfterMs !== undefined) {
    (error as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
  }
  return error;
}

/** pi-ai drops HTTP error headers during normalization; capture them per request. */
function createProviderTransport(): {
  fetch: typeof globalThis.fetch;
  retryAfterMs?: number;
} {
  const transport: { fetch: typeof globalThis.fetch; retryAfterMs?: number } = {
    fetch: async (...args) => {
      const response = await globalThis.fetch(...args);
      transport.retryAfterMs = getRetryAfterMs({ headers: response.headers });
      return response;
    },
  };
  return transport;
}

export class OpenAIResponsesRuntime implements AgentRuntime {
  readonly kind = 'openai-responses';
  readonly model: Model<'openai-responses'>;
  private readonly streamFn: PiStreamFn;
  private readonly completeFn: PiCompleteFn;

  constructor(
    readonly config: ArgusRuntimeConfig,
    deps: OpenAIResponsesRuntimeDeps = {}
  ) {
    if (!config.openai) {
      throw new Error('OpenAI runtime requires openai credentials in the runtime config');
    }

    this.model = deps.model ?? buildPiModel(config);
    this.streamFn = deps.streamSimple ?? (streamSimple as PiStreamFn);
    this.completeFn = deps.completeSimple ?? (completeSimple as PiCompleteFn);
  }

  private get apiKey(): string {
    return this.config.openai?.apiKey ?? '';
  }

  private buildStreamOptions(
    extra: SimpleStreamOptions = {},
    effort: string | undefined = this.config.reasoningEffort
  ): SimpleStreamOptions {
    const reasoning = toThinkingLevel(effort);
    return {
      apiKey: this.apiKey,
      maxRetries: PI_PROVIDER_MAX_RETRIES,
      ...(reasoning ? { reasoning } : {}),
      onPayload: liftInstructionsToPayload,
      ...extra,
    };
  }

  async generateText(options: RuntimeGenerateTextOptions): Promise<RuntimeGenerateTextResult> {
    const model = options.model ? buildPiModel(this.config, options.model) : this.model;
    const context: Context = {
      // 旧实现每个 generateText 请求都带这份 instructions，保持行为一致。
      systemPrompt: DEFAULT_RUNTIME_INSTRUCTIONS,
      messages: [{ role: 'user', content: options.prompt, timestamp: Date.now() }],
    };
    const baseOptions = this.buildStreamOptions({
      ...(options.maxOutputTokens ? { maxTokens: options.maxOutputTokens } : {}),
      ...(options.abortController ? { signal: options.abortController.signal } : {}),
    });

    let usage: RuntimeUsage | undefined;
    for (let attempt = 0; ; attempt++) {
      const watchdog = createStreamIdleWatchdog(options.abortController?.signal);
      const transport = createProviderTransport();
      let message: AssistantMessage | undefined;
      let reportedUsage: RuntimeUsage | undefined;
      try {
        throwIfAborted(options.abortController?.signal);
        message = await watchdog.wait(() =>
          this.completeFn(model, context, {
            ...baseOptions,
            fetch: transport.fetch,
            signal: watchdog.signal,
            onProviderStreamEvent: (event) => {
              watchdog.touch();
              reportedUsage = normalizeProviderUsage(event) ?? reportedUsage;
            },
          })
        );
        throwIfAborted(options.abortController?.signal);
        if (message.stopReason === 'aborted') throw createAbortError(message.errorMessage);
        if (message.stopReason === 'error')
          throw createProviderError(
            message.errorMessage || 'pi-ai completion error',
            transport.retryAfterMs
          );
      } catch (error) {
        throwIfAborted(options.abortController?.signal, error);
        watchdog.dispose();
        usage = mergeUsage(usage, reportedUsage ?? normalizeUsage(message));
        if (attempt >= DEFAULT_PROVIDER_MAX_RETRIES) throw error;
        const delayMs = calculateRetryDelayMs(attempt + 1, {
          retryAfterMs: transport.retryAfterMs ?? getRetryAfterMs(error),
        });
        console.warn(
          `[OpenAIResponsesRuntime] Text request retry ${attempt + 1}/${DEFAULT_PROVIDER_MAX_RETRIES} in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!(await waitForRetry(delayMs, options.abortController?.signal))) {
          throwIfAborted(options.abortController?.signal);
        }
        continue;
      } finally {
        watchdog.dispose();
      }
      usage = mergeUsage(usage, reportedUsage ?? normalizeUsage(message));
      const text = extractAssistantText(message);
      if (!text) {
        const error = buildNoTextError(message, {
          attempts: attempt + 1,
          tokensUsed: totalTokens(usage),
        });
        if (message.stopReason !== 'stop' || attempt >= DEFAULT_PROVIDER_MAX_RETRIES) {
          throw error;
        }
        const delayMs = calculateRetryDelayMs(attempt + 1);
        console.warn(
          `[OpenAIResponsesRuntime] Text request retry ${attempt + 1}/${DEFAULT_PROVIDER_MAX_RETRIES} in ${delayMs}ms: ${error.message}`
        );
        if (!(await waitForRetry(delayMs, options.abortController?.signal))) {
          throwIfAborted(options.abortController?.signal);
        }
        continue;
      }
      return { text, usage };
    }
  }

  execute(options: RuntimeExecuteOptions): RuntimeExecution {
    const abortController = options.abortController ?? new AbortController();
    const ownsAbortController = !options.abortController;
    const runtimeTools = options.tools ?? [];
    const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const piTools: PiTool[] | undefined =
      runtimeTools.length > 0 ? runtimeTools.map(toPiTool) : undefined;
    const totalTurns = Math.max(options.maxTurns, 1);
    const completionBudget = options.completionBudget;
    const stableInstructions = completionBudget
      ? buildStableBudgetInstructions(totalTurns, completionBudget.reserveTurns)
      : undefined;
    const activeEffort = options.reasoningEffort ?? this.config.reasoningEffort;
    const model = options.model
      ? buildPiModel(this.config, options.model, activeEffort)
      : activeEffort === this.config.reasoningEffort
        ? this.model
        : buildPiModel(this.config, this.config.models.main, activeEffort);
    const transcriptBudgetTokens = this.config.openai?.transcriptBudgetTokens;
    const streamFn = this.streamFn;
    const buildOptions = (extra: SimpleStreamOptions = {}) =>
      this.buildStreamOptions(extra, activeEffort);

    let closed = false;

    return {
      async *[Symbol.asyncIterator]() {
        let messages: Message[] = [];
        let remainingTurns = totalTurns;
        let warnedTranscriptBudgetMiss = false;
        const systemPromptText = stableInstructions ?? DEFAULT_RUNTIME_INSTRUCTIONS;
        const fixedTranscriptTokens =
          estimateTextTokens(systemPromptText) +
          (piTools ? estimateTextTokens(JSON.stringify(piTools)) : 0);
        const warnTranscriptBudgetMiss = (tokensAfter: number) => {
          if (warnedTranscriptBudgetMiss) {
            return;
          }

          warnedTranscriptBudgetMiss = true;
          console.warn(
            `[OpenAIResponsesRuntime] Transcript stays above the budget (best effort): ` +
              `~${tokensAfter} > ${transcriptBudgetTokens} est. tokens`
          );
        };

        for await (const promptInput of iteratePromptInputs(options.prompt)) {
          if (closed) {
            return;
          }

          messages.push({ role: 'user', content: promptInput, timestamp: Date.now() });
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

            // 长会话控制：超预算时先折叠最旧的工具输出，再发本轮请求。
            if (transcriptBudgetTokens !== undefined && transcriptBudgetTokens > 0) {
              const compacted = compactTranscript(messages, {
                budgetTokens: transcriptBudgetTokens,
                fixedTokens: fixedTranscriptTokens,
              });
              if (compacted.elidedCount > 0) {
                messages = compacted.messages;
                console.log(
                  `[OpenAIResponsesRuntime] Compacted transcript: ~${compacted.tokensBefore} → ~${compacted.tokensAfter} est. tokens ` +
                    `(elided ${compacted.elidedCount} items)`
                );
                if (!compacted.budgetMet) {
                  warnTranscriptBudgetMiss(compacted.tokensAfter);
                }
              } else if (!compacted.budgetMet) {
                // best effort：保留项本身已超预算，折叠无法继续压低体积（每次会话只提示一次）。
                warnTranscriptBudgetMiss(compacted.tokensAfter);
              }
            }

            // 逐轮变化的预算提示只挂在本次请求的末尾，不改动已缓存的 transcript 前缀。
            // 这里传 transcript 的快照：请求发出后循环会继续往 messages 里追加
            // assistant/toolResult，如果直接共享数组，调用方拿到的 context 会被后续轮次改写。
            const context: Context = {
              // 旧实现每个请求都带默认 instructions（有会话预算时再追加预算段落）。
              systemPrompt: systemPromptText,
              messages: turnBudgetNote
                ? [...messages, { role: 'user', content: turnBudgetNote, timestamp: Date.now() }]
                : [...messages],
              ...(piTools ? { tools: piTools } : {}),
            };

            let assistant: AssistantMessage | undefined;
            for (let attempt = 0; ; attempt++) {
              assistant = undefined;
              let partial: AssistantMessage | undefined;
              let reportedUsage: RuntimeUsage | undefined;
              const watchdog = createStreamIdleWatchdog(abortController.signal);
              const transport = createProviderTransport();
              try {
                throwIfAborted(abortController.signal);
                for await (const event of watchdog.wrap(
                  streamFn(
                    model,
                    context,
                    buildOptions({
                      fetch: transport.fetch,
                      signal: watchdog.signal,
                      onProviderStreamEvent: (event) => {
                        watchdog.touch();
                        reportedUsage = normalizeProviderUsage(event) ?? reportedUsage;
                      },
                    })
                  )
                )) {
                  if ('partial' in event) partial = event.partial;
                  if (event.type === 'done') {
                    assistant = event.message;
                    break;
                  }
                  if (event.type === 'error') {
                    assistant = event.error;
                    break;
                  }
                }
                throwIfAborted(abortController.signal);
                if (!assistant)
                  throw new Error('OpenAI Responses runtime stream ended without a response');
                if (assistant.stopReason === 'aborted')
                  throw createAbortError(assistant.errorMessage);
                if (assistant.stopReason === 'error')
                  throw createProviderError(
                    assistant.errorMessage || 'pi-ai completion error',
                    transport.retryAfterMs
                  );
              } catch (error) {
                throwIfAborted(abortController.signal, error);
                watchdog.dispose();
                lastUsage = mergeUsage(
                  lastUsage,
                  reportedUsage ?? normalizeUsage(assistant ?? partial)
                );
                if (attempt >= DEFAULT_PROVIDER_MAX_RETRIES) {
                  yield {
                    type: 'result',
                    status: 'error',
                    usage: lastUsage,
                    error: error instanceof Error ? error.message : String(error),
                  };
                  return;
                }
                const delayMs = calculateRetryDelayMs(attempt + 1, {
                  retryAfterMs: transport.retryAfterMs ?? getRetryAfterMs(error),
                });
                console.warn(
                  `[OpenAIResponsesRuntime] Stream request retry ${attempt + 1}/${DEFAULT_PROVIDER_MAX_RETRIES} in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`
                );
                if (!(await waitForRetry(delayMs, abortController.signal))) {
                  throwIfAborted(abortController.signal);
                }
                continue;
              } finally {
                watchdog.dispose();
              }
              lastUsage = mergeUsage(lastUsage, reportedUsage ?? normalizeUsage(assistant));
              break;
            }

            const responseText = extractAssistantText(assistant);
            messages.push(assistant);

            if (responseText) {
              lastText = responseText;
              yield {
                type: 'assistant.text',
                text: responseText,
              };
            }

            const toolCalls = assistant.content.filter((block) => block.type === 'toolCall');

            /**
             * 输出预算被推理吃光时，消息里的 tool call 参数可能被截断或串位，
             * 这类调用不能交给工具执行。上游在 0.88 里把「未完成的 tool call」改成直接让流
             * 失败（issue #9974）；本地能判定的是 stopReason=length 这一条路径。
             * 按 incomplete 返回交给编排层处理，并标记本轮已结束，避免再补一条 error_max_turns。
             */
            if (assistant.stopReason === 'length') {
              promptFinished = true;
              yield {
                type: 'result',
                status: 'incomplete',
                rawStopReason: assistant.rawStopReason,
                ...(responseText ? { text: responseText } : {}),
                usage: lastUsage,
              };
              break;
            }

            if (toolCalls.length === 0) {
              promptFinished = true;
            }

            if (toolCalls.length === 0 && !responseText) {
              yield {
                type: 'result',
                status: 'error_empty_output',
                usage: lastUsage,
                error: 'OpenAI Responses stream completed without text or tool calls',
              };
              break;
            }

            if (toolCalls.length === 0) {
              yield {
                type: 'result',
                status: 'success',
                text: responseText,
                usage: lastUsage,
              };
              break;
            }

            for (const toolCall of toolCalls) {
              throwIfAborted(abortController.signal);
              yield { type: 'activity', event: `function_call:${toolCall.name}` };
              throwIfAborted(abortController.signal);
              const toolResult: ToolResultMessage = {
                role: 'toolResult',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [],
                isError: false,
                timestamp: Date.now(),
              };

              if (!toolsByName.has(toolCall.name)) {
                toolResult.content = [
                  { type: 'text', text: `Tool "${toolCall.name}" is not available.` },
                ];
                toolResult.isError = true;
                messages.push(toolResult);
                continue;
              }

              if (closing && !completionBudget!.toolNames.includes(toolCall.name)) {
                toolResult.content = [
                  {
                    type: 'text',
                    text: 'Context tools are unavailable in the closing phase. Finish from existing evidence or call report_incomplete.',
                  },
                ];
                toolResult.isError = true;
                messages.push(toolResult);
                continue;
              }

              const runtimeTool = toolsByName.get(toolCall.name)!;
              try {
                const args = normalizeToolArguments(toolCall.arguments);
                const result = await runtimeTool.execute(args);
                toolResult.content = [{ type: 'text', text: toolResultToOutput(result) }];
              } catch (error) {
                throwIfAborted(abortController.signal, error);
                const message = error instanceof Error ? error.message : String(error);
                toolResult.content = [
                  { type: 'text', text: `Tool "${toolCall.name}" failed: ${message}` },
                ];
                toolResult.isError = true;
              }

              messages.push(toolResult);
            }
          }

          throwIfAborted(abortController.signal);
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
