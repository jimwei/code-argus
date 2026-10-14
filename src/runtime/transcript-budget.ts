/**
 * 会话 transcript 预算与折叠。
 *
 * pi-ai 路径每轮都会把完整 transcript 发回上游（`store: false`），长会话的
 * 单次请求会随轮数近似二次方增长：payroll 实测单个 agent 会话末次调用约
 * 16 万 token。这里在超过预算时把最旧的工具输出折叠成占位文本，保留
 * 最近若干条与全部 user/assistant 消息：
 * - 折叠是 `best effort`：无法达到低水位时保持原文并返回 `budgetMet: false`，
 *   避免每轮改写历史；最近 N 条工具输出 + 全部 user/assistant 消息始终保留；
 * - 占位文本保留 tool 名与调用 ID，function_call / function_call_output 配对不变；
 * - 代价说明：每次折叠都会改写历史内容，缓存只能匹配到首个改写点之前；
 *   两次折叠之间前缀稳定，不保证整个会话只失效一次。是否净收益取决于网关的
 *   cached token 折扣与折叠后的剩余轮数，请结合 cached/input 计数验证；
 *   折叠可以降低上下文占用；无法达到低水位时不折叠，仍可能触发 provider 上下文超限。
 */

import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';

/** 折叠占位文本前缀（同时用于测试与线上排查）。 */
export const TRANSCRIPT_ELISION_PREFIX = '[tool output elided to bound transcript size]';

/** 默认折叠目标：预算的比例，避免刚折叠完又立刻触发下一轮折叠。 */
export const DEFAULT_TRANSCRIPT_LOW_WATERMARK_RATIO = 0.6;

/** 默认保留最近多少条工具输出不参与折叠。 */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 6;

export interface TranscriptBudgetOptions {
  /** 估算 token 预算；<= 0 时不折叠。 */
  budgetTokens: number;
  /** system prompt + 工具 schema 等固定部分的估算 token。 */
  fixedTokens?: number;
  /** 折叠目标占预算的比例（缺省 {@link DEFAULT_TRANSCRIPT_LOW_WATERMARK_RATIO}）。 */
  lowWatermarkRatio?: number;
  /** 保留最近 N 条工具输出（缺省 {@link DEFAULT_KEEP_RECENT_TOOL_RESULTS}）。 */
  keepRecentToolResults?: number;
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
    } else if (typeof record.thinking === 'string') {
      parts.push(record.thinking);
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

function buildElidedToolResult(message: ToolResultMessage): ToolResultMessage {
  const removedChars = contentToText(message.content).length;
  return {
    ...message,
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
 * 超过预算时按「最旧优先」折叠工具输出，直到低于低水位或没有可折叠项。
 * 返回新的消息数组（未触发折叠时原样返回）。
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
  const target = Math.max(0, Math.floor(options.budgetTokens * lowWatermarkRatio));

  const toolResultIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if ((messages[index] as { role?: string }).role === 'toolResult') {
      toolResultIndexes.push(index);
    }
  }

  const foldableIndexes = toolResultIndexes.slice(
    0,
    Math.max(0, toolResultIndexes.length - keepRecentToolResults)
  );
  if (foldableIndexes.length === 0) {
    return {
      messages,
      elidedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      budgetMet: false,
    };
  }

  const next = messages.slice();
  // 先确认能达到低水位；不可达时不做部分折叠，以保留稳定的缓存前缀。
  const replacements = foldableIndexes
    .map((index) => {
      const original = messages[index] as ToolResultMessage;
      const elided = buildElidedToolResult(original);
      return {
        index,
        elided,
        saving: estimateMessageTokens(original) - estimateMessageTokens(elided),
      };
    })
    .filter(({ saving }) => saving > 0);
  const minimumTokens = tokensBefore - replacements.reduce((sum, entry) => sum + entry.saving, 0);
  if (minimumTokens > target) {
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
