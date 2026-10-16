import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';

import {
  TRANSCRIPT_ELISION_PREFIX,
  compactTranscript,
  estimateMessageTokens,
  estimateTranscriptTokens,
} from '../../src/runtime/transcript-budget.js';

function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 } as unknown as Message;
}

function assistantMessage(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.3-codex',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  } as unknown as Message;
}

function toolResultMessage(id: string, text: string): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'Read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 3,
  } as unknown as Message;
}

function assistantThinkingMessage(thinking: string): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'summary',
        // pi-ai 发送的是 thinkingSignature 解析出的 reasoning item
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_1',
          content: [{ type: 'reasoning_text', text: thinking }],
        }),
      },
      { type: 'text', text: 'working' },
    ],
    api: 'openai-responses',
    provider: 'openai',
    model: 'deepseek-v4.1-flash',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  } as unknown as Message;
}

const BIG_OUTPUT = 'a'.repeat(20000); // ASCII ≈ 5000 tokens per result

describe('transcript budget estimation', () => {
  it('estimates ASCII content around four characters per token', () => {
    expect(estimateMessageTokens(userMessage('a'.repeat(400)))).toBe(100);
  });

  it('counts wide characters as at least one token each', () => {
    const tokens = estimateMessageTokens(userMessage('課'.repeat(100)));
    expect(tokens).toBeGreaterThanOrEqual(100);
  });

  it('includes the fixed prompt and tool schema tokens', () => {
    const withoutFixed = estimateTranscriptTokens([userMessage('hello')]);
    const withFixed = estimateTranscriptTokens([userMessage('hello')], 500);
    expect(withFixed - withoutFixed).toBe(500);
  });
});

describe('compactTranscript', () => {
  it('leaves transcripts below the budget untouched', () => {
    const messages = [userMessage('hello'), toolResultMessage('call_1', 'small output')];
    const result = compactTranscript(messages, { budgetTokens: 10_000 });

    expect(result.elidedCount).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  it('elides the oldest tool outputs first and keeps the newest ones intact', () => {
    const messages: Message[] = [userMessage('review this diff')];
    for (let i = 1; i <= 8; i++) {
      messages.push(toolResultMessage(`call_${i}`, `${BIG_OUTPUT}-${i}`));
    }

    const result = compactTranscript(messages, {
      budgetTokens: 20_000,
      lowWatermarkRatio: 0.6,
      keepRecentToolResults: 2,
    });

    expect(result.elidedCount).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.budgetMet).toBe(true);

    const elided = result.messages.filter(
      (message) =>
        message.role === 'toolResult' &&
        (message.content as Array<{ text?: string }>)[0]?.text?.startsWith(
          TRANSCRIPT_ELISION_PREFIX
        )
    );
    const kept = result.messages.filter(
      (message) =>
        message.role === 'toolResult' &&
        !(message.content as Array<{ text?: string }>)[0]?.text?.startsWith(
          TRANSCRIPT_ELISION_PREFIX
        )
    );

    // 最旧的先被折叠，最近的 keepRecentToolResults 条保持原样。
    expect(elided).toHaveLength(6);
    expect(kept).toHaveLength(2);
    expect((result.messages[1]!.content as Array<{ text?: string }>)[0]?.text).toContain('call_1');
    expect((result.messages[7]!.content as Array<{ text?: string }>)[0]?.text).toBe(
      `${BIG_OUTPUT}-7`
    );
    expect((result.messages[8]!.content as Array<{ text?: string }>)[0]?.text).toBe(
      `${BIG_OUTPUT}-8`
    );
  });

  it('never elides user or assistant messages', () => {
    const messages: Message[] = [
      userMessage('diff context'),
      toolResultMessage('call_1', BIG_OUTPUT),
      assistantMessage('intermediate summary'),
      toolResultMessage('call_2', BIG_OUTPUT),
      toolResultMessage('call_3', BIG_OUTPUT),
    ];

    const result = compactTranscript(messages, {
      budgetTokens: 12_000,
      lowWatermarkRatio: 0.5,
      keepRecentToolResults: 1,
    });

    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.elidedCount).toBe(2);
  });

  it('stops once the low watermark is reached', () => {
    const messages: Message[] = [userMessage('start')];
    for (let i = 1; i <= 10; i++) {
      messages.push(toolResultMessage(`call_${i}`, `${BIG_OUTPUT}-${i}`));
    }

    const result = compactTranscript(messages, {
      budgetTokens: 20_000,
      lowWatermarkRatio: 0.5,
      keepRecentToolResults: 1,
    });

    // 目标 10000 tokens，从约 50000 起折叠：每折叠一条省约 5000 tokens。
    expect(result.tokensAfter).toBeLessThanOrEqual(10_000);
    expect(result.elidedCount).toBeGreaterThanOrEqual(8);
    expect(result.elidedCount).toBeLessThanOrEqual(9);
    expect(result.budgetMet).toBe(true);
  });

  it('reports budgetMet=false when the preserved messages alone exceed the budget', () => {
    const messages: Message[] = [
      toolResultMessage('call_1', BIG_OUTPUT),
      toolResultMessage('call_2', BIG_OUTPUT),
      toolResultMessage('call_3', BIG_OUTPUT),
    ];

    const result = compactTranscript(messages, {
      budgetTokens: 1_000,
      lowWatermarkRatio: 0.5,
      keepRecentToolResults: 2,
    });

    // 保留项超预算时不改写历史，避免随后每轮反复折叠。
    expect(result.elidedCount).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.budgetMet).toBe(false);
    expect(result.tokensAfter).toBeGreaterThan(1_000);
  });

  it('does not rewrite a growing transcript when the low watermark is unreachable', () => {
    let messages = [userMessage('u'.repeat(2800))];
    for (let i = 0; i < 8; i++) {
      messages.push(toolResultMessage(`call_${i}`, 'x'.repeat(400)));
    }
    for (let turn = 0; turn < 4; turn++) {
      const result = compactTranscript(messages, { budgetTokens: 1000 });
      expect(result.messages).toBe(messages);
      expect(result.elidedCount).toBe(0);
      expect(result.budgetMet).toBe(false);
      messages = [...result.messages, toolResultMessage(`next_${turn}`, 'x'.repeat(400))];
    }
  });

  it('requires low-watermark headroom even when folding could just meet the budget', () => {
    const messages = [userMessage('u'.repeat(2800))];
    for (let i = 0; i < 8; i++) messages.push(toolResultMessage(`call_${i}`, 'x'.repeat(400)));
    const result = compactTranscript(messages, { budgetTokens: 1400 });
    expect(result.messages).toBe(messages);
    expect(result.elidedCount).toBe(0);
    expect(result.budgetMet).toBe(false);
  });

  it('drops old thinking blocks entirely and keeps the newest assistant turns intact', () => {
    const thinking = 't'.repeat(25_000);
    const messages: Message[] = [userMessage('diff context')];
    for (let i = 1; i <= 6; i++) {
      messages.push(assistantThinkingMessage(`${thinking}-${i}`));
    }

    const result = compactTranscript(messages, {
      budgetTokens: 30_000,
      lowWatermarkRatio: 0.5,
      keepRecentAssistantMessages: 2,
    });

    const assistants = result.messages.filter((message) => message.role === 'assistant');
    // 旧回合的思考块整块移除：pi-ai 从 thinkingSignature 重放推理项，只有移除才真正缩小请求。
    expect(result.elidedCount).toBe(4);
    expect(
      (assistants[0]!.content as Array<{ type: string }>).some((block) => block.type === 'thinking')
    ).toBe(false);
    const lastThinking = (
      assistants[assistants.length - 1]!.content as Array<{ type: string; thinking?: string }>
    ).find((block) => block.type === 'thinking');
    expect(lastThinking).toBeDefined();
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
  });

  it('folds worthwhile savings even when the low watermark is unreachable', () => {
    const thinking = 't'.repeat(80_000);
    const messages: Message[] = [userMessage('x'.repeat(40_000))];
    for (let i = 1; i <= 5; i++) messages.push(assistantThinkingMessage(`${thinking}-${i}`));

    const result = compactTranscript(messages, {
      budgetTokens: 30_000,
      lowWatermarkRatio: 0.5,
      keepRecentAssistantMessages: 1,
    });

    // 保留项（10k 提示词 + 最近一条 20k 思考）本身就超过 15k 的低水位，
    // 但只要一次能省下可观体积，就折叠而不是放任上下文无界增长。
    expect(result.elidedCount).toBe(4);
    expect(result.messages).not.toBe(messages);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });
});
