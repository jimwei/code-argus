/**
 * 会话 transcript 预算与折叠。
 *
 * pi-ai 路径每轮都会把完整 transcript 发回上游（`store: false`），长会话的
 * 单次请求会随轮数近似二次方增长：payroll 实测单个 agent 会话末次调用约
 * 16 万 token。这里在超过预算时把最旧的工具输出折叠成占位文本、并把较早回合的
 * 思考块整块移除（pi-ai 依 `thinkingSignature` 重放推理项，是体积的主要来源），
 * 保留最近若干条工具输出、最近若干条 assistant 回合与全部 user 消息：
 * - 折叠是 `best effort`：无法达到低水位时保持原文并返回 `budgetMet: false`，
 *   避免每轮改写历史；但一次能省下 max({@link DEFAULT_MIN_FOLD_TOKENS}, 溢出量一半)
 *   以上时仍会折叠，以免上下文无界增长（此时 `budgetMet` 可能仍为 false）。最近 N 条工具输出 +
 *   全部 user 消息 + 最近 N 条 assistant 回合的思考块始终保留；
 * - 占位文本保留 tool 名与调用 ID，function_call / function_call_output 配对不变；
 * - 代价说明：每次折叠都会改写历史内容，缓存只能匹配到首个改写点之前；
 *   两次折叠之间前缀稳定，不保证整个会话只失效一次。是否净收益取决于网关的
 *   cached token 折扣与折叠后的剩余轮数，请结合 cached/input 计数验证；
 *   折叠可以降低上下文占用；保留项持续超预算时，仍可能触发 provider 上下文超限。
 */

import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';

/** 折叠占位文本前缀（同时用于测试与线上排查）。 */
export const TRANSCRIPT_ELISION_PREFIX = '[tool output elided to bound transcript size]';

// 内部标记不参与 JSON 序列化；对象 spread 仍会保留它，避免后续轮次重复改写占位文本。
const ELIDED_TOOL_RESULT = Symbol('elidedToolResult');
type ElidedToolResultMessage = ToolResultMessage & { [ELIDED_TOOL_RESULT]: true };

/** 默认折叠目标：预算的比例，避免刚折叠完又立刻触发下一轮折叠。 */
export const DEFAULT_TRANSCRIPT_LOW_WATERMARK_RATIO = 0.6;

/** 默认保留最近多少条工具输出不参与折叠。 */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 6;

/** 默认保留最近多少条 assistant 消息的思考块；更早的回合整块移除。 */
export const DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES = 4;

/**
 * 低水位不可达时仍允许折叠的最小节省量（估算 token）。
 * 达不到水位时全部折叠也压不回 60%，但什么都不折会让上下文无界增长（实测单请求
 * 24 万 token）；只要一次能省下这么多，就接受"改写历史换取有界体积"。
 */
export const DEFAULT_MIN_FOLD_TOKENS = 8_000;

export interface TranscriptBudgetOptions {
  /** 估算 token 预算；<= 0 时不折叠。 */
  budgetTokens: number;
  /** system prompt + 工具 schema 等固定部分的估算 token。 */
  fixedTokens?: number;
  /** 折叠目标占预算的比例（缺省 {@link DEFAULT_TRANSCRIPT_LOW_WATERMARK_RATIO}）。 */
  lowWatermarkRatio?: number;
  /** 保留最近 N 条工具输出（缺省 {@link DEFAULT_KEEP_RECENT_TOOL_RESULTS}）。 */
  keepRecentToolResults?: number;
  /** 保留最近 N 条 assistant 消息的思考块（缺省 {@link DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES}）。 */
  keepRecentAssistantMessages?: number;
  /**
   * 低水位不可达时仍允许折叠的最小节省量（缺省 {@link DEFAULT_MIN_FOLD_TOKENS}）；
   * 实际门槛取它与溢出量一半的较大者。
   */
  minFoldTokens?: number;
}

export interface CompactTranscriptResult {
  messages: Message[];
  elidedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** 折叠后是否已降到预算以内；保留项本身超预算时为 false（best effort）。 */
  budgetMet: boolean;
}

/**
 * 逐字符估算：ASCII 按 4 字符/token，非 ASCII（CJK 等）按 1 字符/token 保守估计。
 * 比 pi-ai 内部的 3.5 字符/token 更保守，避免中文/日文内容低估上下文体积。
 */
export function estimateTextTokens(text: string): number {
  let asciiChars = 0;
  let wideChars = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) {
      wideChars += 1;
    } else {
      asciiChars += 1;
    }
  }

  return Math.ceil(asciiChars / 4 + wideChars);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'thinking') {
      // pi-ai 只把 `thinkingSignature` 解析出的 reasoning item 发回上游；块里展示用的
      // `thinking` 文本不会上线，因此按 signature 计体积（无 signature 的块实际不发送）。
      if (typeof record.thinkingSignature === 'string') {
        parts.push(record.thinkingSignature);
      }
    } else if (record.arguments !== undefined) {
      try {
        parts.push(JSON.stringify(record.arguments) ?? '');
      } catch {
        // 不可序列化的参数忽略即可，只影响估算精度。
      }
    }
  }

  return parts.join('\n');
}

/** 估算单条消息的 token 数。 */
export function estimateMessageTokens(message: Message): number {
  return estimateTextTokens(contentToText((message as { content?: unknown }).content));
}

/** 估算整个 transcript 的 token 数（含固定部分）。 */
export function estimateTranscriptTokens(messages: Message[], fixedTokens = 0): number {
  let tokens = fixedTokens;
  for (const message of messages) {
    tokens += estimateMessageTokens(message);
  }

  return tokens;
}

function buildElidedToolResult(message: ToolResultMessage): ElidedToolResultMessage {
  const removedChars = contentToText(message.content).length;
  return {
    ...message,
    [ELIDED_TOOL_RESULT]: true,
    content: [
      {
        type: 'text',
        text:
          `${TRANSCRIPT_ELISION_PREFIX} tool=${message.toolName} ` +
          `call=${message.toolCallId} removedChars=${removedChars}`,
      },
    ],
  };
}

/**
 * 整块移除旧回合的思考块。pi-ai 依据 `thinkingSignature` 重放推理项（`block.thinking`
 * 文本并不直接上线），因此只有移除整块才真正缩小出站请求；改写文本会造成"估算变小、
 * 请求不变"的假节省。
 *
 * 工具调用的 `fc_*` item id 保持不动：实测（103 网关）"删推理、留 id"形态被接受
 * （12 次折叠、0 个非 200），而"连同 id 一起删"的形态会被网关以 400 拒绝。
 * 官方 OpenAI 对 reasoning-item 配对的校验语义仍未验证，严格部署如遇 400 可把
 * `ARGUS_TRANSCRIPT_BUDGET_TOKENS` 调大或设为 0 关闭折叠。
 */
function buildElidedAssistantThinking(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type !== 'thinking'),
  };
}

/**
 * 超过预算时按「最旧优先」折叠工具输出与旧思考块，直到低于低水位或没有可折叠项。
 * 长会话的体积主要来自逐轮重放的 thinking 文本，只折工具输出无法把 transcript 压回
 * 水位（此时旧实现一个都不折、上下文继续无界增长）。返回新的消息数组（未触发折叠时原样返回）。
 */
export function compactTranscript(
  messages: Message[],
  options: TranscriptBudgetOptions
): CompactTranscriptResult {
  const fixedTokens = options.fixedTokens ?? 0;
  const tokensBefore = estimateTranscriptTokens(messages, fixedTokens);

  if (options.budgetTokens <= 0 || tokensBefore <= options.budgetTokens) {
    return {
      messages,
      elidedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      budgetMet: true,
    };
  }

  const lowWatermarkRatio = options.lowWatermarkRatio ?? DEFAULT_TRANSCRIPT_LOW_WATERMARK_RATIO;
  const keepRecentToolResults = options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const keepRecentAssistantMessages =
    options.keepRecentAssistantMessages ?? DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES;
  const minFoldTokens = options.minFoldTokens ?? DEFAULT_MIN_FOLD_TOKENS;
  const target = Math.max(0, Math.floor(options.budgetTokens * lowWatermarkRatio));

  const toolResultIndexes: number[] = [];
  const assistantIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const role = (messages[index] as { role?: string }).role;
    if (role === 'toolResult') {
      toolResultIndexes.push(index);
    } else if (role === 'assistant') {
      assistantIndexes.push(index);
    }
  }

  const foldableToolResults = toolResultIndexes
    .slice(0, Math.max(0, toolResultIndexes.length - keepRecentToolResults))
    .filter((index) => !(messages[index] as Partial<ElidedToolResultMessage>)[ELIDED_TOOL_RESULT]);
  const foldableAssistantMessages = assistantIndexes
    .slice(0, Math.max(0, assistantIndexes.length - keepRecentAssistantMessages))
    .filter((index) =>
      ((messages[index] as AssistantMessage).content ?? []).some(
        (block) => block.type === 'thinking'
      )
    );
  if (foldableToolResults.length === 0 && foldableAssistantMessages.length === 0) {
    return {
      messages,
      elidedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      budgetMet: false,
    };
  }

  const next = messages.slice();
  // 先算总节省：能达到低水位最好；达不到时只有省得够多才折叠，兼顾缓存前缀稳定。
  const replacements = [
    ...foldableToolResults.map((index) => {
      const original = messages[index] as ToolResultMessage;
      const elided = buildElidedToolResult(original);
      return {
        index,
        elided,
        saving: estimateMessageTokens(original) - estimateMessageTokens(elided),
      };
    }),
    ...foldableAssistantMessages.map((index) => {
      const original = messages[index] as AssistantMessage;
      const elided = buildElidedAssistantThinking(original);
      return {
        index,
        elided,
        saving: estimateMessageTokens(original) - estimateMessageTokens(elided),
      };
    }),
  ]
    .filter(({ saving }) => saving > 0)
    .sort((a, b) => a.index - b.index);
  const totalSaving = replacements.reduce((sum, entry) => sum + entry.saving, 0);
  const minimumTokens = tokensBefore - totalSaving;
  // 能达到低水位就折；达不到时，只要一次能省下足够多也折，避免上下文无界增长。
  const overflow = tokensBefore - options.budgetTokens;
  const worthwhile = totalSaving >= Math.max(minFoldTokens, Math.ceil(overflow / 2));
  if (minimumTokens > target && !worthwhile) {
    return { messages, elidedCount: 0, tokensBefore, tokensAfter: tokensBefore, budgetMet: false };
  }
  let currentTokens = tokensBefore;
  let elidedCount = 0;

  for (const { index, elided, saving } of replacements) {
    if (currentTokens <= target) {
      break;
    }

    next[index] = elided;
    currentTokens -= saving;
    elidedCount += 1;
  }

  if (elidedCount === 0) {
    return {
      messages,
      elidedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      budgetMet: false,
    };
  }

  const tokensAfter = estimateTranscriptTokens(next, fixedTokens);
  return {
    messages: next,
    elidedCount,
    tokensBefore,
    tokensAfter,
    budgetMet: tokensAfter <= options.budgetTokens,
  };
}
