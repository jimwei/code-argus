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

/** 网关真实上下文长度不可知；pi-ai 用它裁剪 maxTokens。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** 未显式指定输出上限时的模型上限（同时是升档重试的天花板）。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * 推理长度波动会让同一请求偶尔吃光输出预算：上游以 `incomplete`
 * （`incomplete_details.reason=max_output_tokens`）结束且没有任何文本。
 * 这里保留改造前的一次升档重试，区间沿用 [2048, 8192]。
 */
const ESCALATED_MAX_OUTPUT_TOKENS_FLOOR = 2048;
const ESCALATED_MAX_OUTPUT_TOKENS_CEILING = 8192;

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
  modelId: string = config.models.main
): Model<'openai-responses'> {
  const baseUrl = (config.openai?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const hasReasoning = Boolean(config.reasoningEffort);

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
      // 部分自建网关（Codex 协议网关）会拒绝 max_output_tokens：由
      // ARGUS_OPENAI_SUPPORTS_MAX_OUTPUT_TOKENS 声明，默认沿用 OpenAI 行为。
      supportsMaxOutputTokens: config.openai?.supportsMaxOutputTokens ?? true,
    },
  };
}

/**
 * ARGUS_REASONING_EFFORT → pi-ai thinking level。
 * pi-ai 的 ThinkingLevel 没有 `off`：`none` 与「未配置」都不传档位，
 * 两者的差别由 `model.reasoning` 是否声明决定。
 */
export function toThinkingLevel(effort: string | undefined): ThinkingLevel | undefined {
  const trimmed = effort?.trim();
  if (!trimmed || trimmed === 'none') {
    return undefined;
  }

  return trimmed as ThinkingLevel;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * 判断响应是否因为输出预算被 reasoning token 吃光而截断。
 * pi-ai 把 `incomplete_details.reason` 保留在 `rawStopReason`（如
 * `incomplete.max_output_tokens`），比只看 stopReason=length 更精确。
 */
export function isOutputBudgetExhausted(message: AssistantMessage): boolean {
  return message.rawStopReason?.includes('max_output_tokens') ?? false;
}

/**
 * 预算耗尽重试时使用的 maxTokens：在 [2048, 8192] 本地策略区间内按调用方预算翻倍。
 * 已达本地上限、或调用方预算非法时返回 undefined 表示不重试。
 */
export function escalateMaxOutputTokens(maxOutputTokens: number): number | undefined {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    return undefined;
  }

  const escalated = Math.min(
    ESCALATED_MAX_OUTPUT_TOKENS_CEILING,
    Math.max(ESCALATED_MAX_OUTPUT_TOKENS_FLOOR, maxOutputTokens * 2)
  );

  return escalated > maxOutputTokens ? escalated : undefined;
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
 * 用户中断要抛 AbortError（而不是把 aborted 当成普通 result 返回），
 * streaming-orchestrator 依赖 `error.name === 'AbortError'` 走优雅退出分支。
 */
function createAbortError(message?: string): Error {
  const error = new Error(message || 'OpenAI Responses runtime aborted');
  error.name = 'AbortError';
  return error;
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

  private buildStreamOptions(extra: SimpleStreamOptions = {}): SimpleStreamOptions {
    const reasoning = toThinkingLevel(this.config.reasoningEffort);
    return {
      apiKey: this.apiKey,
      ...(reasoning ? { reasoning } : {}),
      ...extra,
    };
  }

  async generateText(options: RuntimeGenerateTextOptions): Promise<RuntimeGenerateTextResult> {
    const model = options.model ? buildPiModel(this.config, options.model) : this.model;
    const context: Context = {
      messages: [{ role: 'user', content: options.prompt, timestamp: Date.now() }],
    };
    const baseOptions = this.buildStreamOptions({
      ...(options.maxOutputTokens ? { maxTokens: options.maxOutputTokens } : {}),
      ...(options.abortController ? { signal: options.abortController.signal } : {}),
    });

    let message = await this.completeFn(model, context, baseOptions);
    let spentUsage: RuntimeUsage | undefined;
    let retriedOutputBudget = false;

    const escalatedMaxOutputTokens = options.maxOutputTokens
      ? escalateMaxOutputTokens(options.maxOutputTokens)
      : undefined;

    if (
      !extractAssistantText(message) &&
      escalatedMaxOutputTokens !== undefined &&
      isOutputBudgetExhausted(message)
    ) {
      // 推理长度波动会让同一请求偶尔吃光输出预算；升档重试一次，避免整条调用直接失败。
      spentUsage = normalizeUsage(message);
      const exhaustedMessage = message;
      retriedOutputBudget = true;
      try {
        message = await this.completeFn(model, context, {
          ...baseOptions,
          maxTokens: escalatedMaxOutputTokens,
        });
      } catch (retryFailure) {
        throw buildNoTextError(
          exhaustedMessage,
          { attempts: 2, tokensUsed: totalTokens(spentUsage) },
          retryFailure
        );
      }
    }

    if (message.stopReason === 'aborted') {
      throw createAbortError(message.errorMessage);
    }

    if (message.stopReason === 'error') {
      throw new Error(message.errorMessage || 'pi-ai completion error');
    }

    const text = extractAssistantText(message);
    if (!text) {
      throw buildNoTextError(message, {
        attempts: retriedOutputBudget ? 2 : 1,
        tokensUsed: totalTokens(spentUsage) + totalTokens(normalizeUsage(message)),
      });
    }

    return {
      text,
      usage: mergeUsage(spentUsage, normalizeUsage(message)),
    };
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
    const model = options.model ? buildPiModel(this.config, options.model) : this.model;
    const streamFn = this.streamFn;
    const buildOptions = this.buildStreamOptions.bind(this);

    let closed = false;

    return {
      async *[Symbol.asyncIterator]() {
        const messages: Message[] = [];
        let remainingTurns = totalTurns;

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

            // 逐轮变化的预算提示只挂在本次请求的末尾，不改动已缓存的 transcript 前缀。
            // 这里传 transcript 的快照：请求发出后循环会继续往 messages 里追加
            // assistant/toolResult，如果直接共享数组，调用方拿到的 context 会被后续轮次改写。
            const context: Context = {
              ...(stableInstructions ? { systemPrompt: stableInstructions } : {}),
              messages: turnBudgetNote
                ? [...messages, { role: 'user', content: turnBudgetNote, timestamp: Date.now() }]
                : [...messages],
              ...(piTools ? { tools: piTools } : {}),
            };

            let assistant: AssistantMessage | undefined;
            try {
              for await (const event of streamFn(
                model,
                context,
                buildOptions({ signal: abortController.signal })
              )) {
                if (event.type === 'done') {
                  assistant = event.message;
                } else if (event.type === 'error') {
                  assistant = event.error;
                } else if (event.type === 'toolcall_end') {
                  yield {
                    type: 'activity',
                    event: `function_call:${event.toolCall.name}`,
                  };
                }
              }
            } catch (error) {
              // 用户中断继续向上抛，其余错误按 result 事件返回，保持事件契约。
              if (error instanceof Error && error.name === 'AbortError') {
                throw error;
              }

              yield {
                type: 'result',
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              };
              return;
            }

            if (!assistant) {
              yield {
                type: 'result',
                status: 'error',
                error: 'OpenAI Responses runtime stream ended without a response',
              };
              return;
            }

            lastUsage = normalizeUsage(assistant);
            const responseText = extractAssistantText(assistant);
            messages.push(assistant);

            if (responseText) {
              lastText = responseText;
              yield {
                type: 'assistant.text',
                text: responseText,
              };
            }

            if (assistant.stopReason === 'aborted') {
              throw createAbortError(assistant.errorMessage);
            }

            if (assistant.stopReason === 'error') {
              yield {
                type: 'result',
                status: 'error',
                ...(responseText ? { text: responseText } : {}),
                usage: lastUsage,
                error: assistant.errorMessage || 'pi-ai completion error',
              };
              return;
            }

            const toolCalls = assistant.content.filter((block) => block.type === 'toolCall');
            if (toolCalls.length === 0) {
              promptFinished = true;
            }

            if (toolCalls.length === 0 && !responseText) {
              if (assistant.stopReason === 'length') {
                // 输出预算被吃光但没有正文：保持改造前的 incomplete 语义（可被重试/降级）。
                yield {
                  type: 'result',
                  status: 'incomplete',
                  rawStopReason: assistant.rawStopReason,
                  usage: lastUsage,
                };
                break;
              }

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
                status: assistant.stopReason === 'length' ? 'incomplete' : 'success',
                text: responseText,
                usage: lastUsage,
              };
              break;
            }

            for (const toolCall of toolCalls) {
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
                const message = error instanceof Error ? error.message : String(error);
                toolResult.content = [
                  { type: 'text', text: `Tool "${toolCall.name}" failed: ${message}` },
                ];
                toolResult.isError = true;
              }

              messages.push(toolResult);
            }
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
