import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const {
  anthropicMessagesCreateMock,
  queryMock,
  createSdkMcpServerMock,
  toolMock,
  loadArgusRuntimeConfigMock,
} = vi.hoisted(() => ({
  anthropicMessagesCreateMock: vi.fn(),
  queryMock: vi.fn(),
  createSdkMcpServerMock: vi.fn((server: unknown) => server),
  toolMock: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
  loadArgusRuntimeConfigMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  tool: toolMock,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: anthropicMessagesCreateMock,
    };
  },
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    loadArgusRuntimeConfig: loadArgusRuntimeConfigMock,
  };
});

import {
  ClaudeAgentRuntime,
  OpenAIResponsesRuntime,
  createRuntimeFromEnv,
} from '../../src/runtime/index.js';
import { toPiTool, toThinkingLevel } from '../../src/runtime/openai-responses.js';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import type { ArgusRuntimeConfig } from '../../src/config/env.js';
import type { RuntimeToolDefinition } from '../../src/runtime/types.js';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';

beforeEach(() => {
  anthropicMessagesCreateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function finishRetries<T>(pending: Promise<T>): Promise<T> {
  const observed = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  const outcome = await observed;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

function createAsyncStream(messages: unknown[], onReturn?: () => void) {
  const returnMock = vi.fn(async () => {
    onReturn?.();
    return { done: true, value: undefined };
  });

  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    return: returnMock,
  };
}

describe('runtime execution', () => {
  it('normalizes Claude Agent SDK messages and wraps runtime tools', async () => {
    const stream = createAsyncStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First assistant message' },
            { type: 'tool_use', id: 'tool-1', name: 'report_issue', input: {} },
          ],
        },
      },
      { type: 'stream_event', subtype: 'turn_progress' },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 7,
          output_tokens: 5,
        },
        result: 'Final output',
      },
    ]);
    queryMock.mockReturnValue(stream);

    const config: ArgusRuntimeConfig = {
      runtime: 'claude-agent',
      models: {
        main: 'claude-main',
        light: 'claude-light',
        validator: 'claude-validator',
      },
      claude: {
        apiKey: 'claude-key',
        source: 'argus',
      },
    };

    const executeTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'Issue recorded' }],
    });

    const runtime = new ClaudeAgentRuntime(config);
    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 12,
      settingSources: ['project'],
      toolNamespace: 'custom-agent-tools',
      tools: [
        {
          name: 'report_issue',
          description: 'Capture an issue',
          inputSchema: {
            file: z.string(),
            line_start: z.number(),
          },
          execute: executeTool,
        },
      ],
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    expect(queryMock).toHaveBeenCalledWith({
      prompt: 'Review this diff',
      options: expect.objectContaining({
        cwd: 'C:\\repo',
        maxTurns: 12,
        model: 'claude-main',
        settingSources: ['project'],
        mcpServers: {
          'custom-agent-tools': expect.any(Object),
        },
      }),
    });

    expect(createSdkMcpServerMock).toHaveBeenCalledWith({
      name: 'custom-agent-tools',
      version: '1.0.0',
      tools: expect.any(Array),
    });

    expect(toolMock).toHaveBeenCalledWith(
      'report_issue',
      'Capture an issue',
      expect.objectContaining({
        file: expect.any(Object),
        line_start: expect.any(Object),
      }),
      expect.any(Function)
    );

    const wrappedToolHandler = toolMock.mock.calls[0]?.[3];
    const toolResult = await wrappedToolHandler?.({
      file: 'src/example.ts',
      line_start: 4,
    });

    expect(executeTool).toHaveBeenCalledWith({
      file: 'src/example.ts',
      line_start: 4,
    });
    expect(toolResult).toEqual({
      content: [{ type: 'text', text: 'Issue recorded' }],
    });

    expect(events).toEqual([
      {
        type: 'assistant.text',
        text: 'First assistant message',
      },
      {
        type: 'activity',
        event: 'turn_progress',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Final output',
        usage: {
          inputTokens: 7,
          outputTokens: 5,
        },
      },
    ]);

    await execution.close();
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it('creates a runtime from the active env configuration', () => {
    loadArgusRuntimeConfigMock.mockReturnValue({
      runtime: 'claude-agent',
      models: {
        main: 'claude-main',
        light: 'claude-light',
        validator: 'claude-validator',
      },
      claude: {
        apiKey: 'claude-key',
        source: 'argus',
      },
    } satisfies ArgusRuntimeConfig);

    const runtime = createRuntimeFromEnv();

    expect(loadArgusRuntimeConfigMock).toHaveBeenCalledTimes(1);
    expect(runtime.kind).toBe('claude-agent');
    expect(runtime.config.models.main).toBe('claude-main');
  });

  it('generates plain text through the Claude runtime abstraction', async () => {
    anthropicMessagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"agents":["logic-reviewer"]}',
        },
      ],
      usage: {
        input_tokens: 6,
        output_tokens: 4,
      },
    });

    const runtime = new ClaudeAgentRuntime(
      {
        runtime: 'claude-agent',
        models: {
          main: 'claude-main',
          light: 'claude-light',
          validator: 'claude-validator',
        },
        claude: {
          apiKey: 'claude-key',
          source: 'argus',
        },
      },
      {
        messages: {
          create: anthropicMessagesCreateMock,
        },
      } as any
    );

    const result = await runtime.generateText({
      model: 'claude-light',
      maxOutputTokens: 256,
      prompt: 'Choose agents',
    });

    expect(anthropicMessagesCreateMock).toHaveBeenCalledWith({
      model: 'claude-light',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Choose agents' }],
    });
    expect(result).toEqual({
      text: '{"agents":["logic-reviewer"]}',
      usage: {
        inputTokens: 6,
        outputTokens: 4,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAI Responses runtime on pi-ai
//
// 旧实现自己解析 SSE / 续链 / 兼容网关；现在这些都在 @earendil-works/pi-ai 内部，
// 这里只验证编排契约：工具循环、预算、收尾阶段、用量与事件形状。
// ---------------------------------------------------------------------------

type PiStreamCall = {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
};

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.3-codex',
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
    ...overrides,
  };
}

function createPiStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as AssistantMessageEventStream;
}

function doneEvent(message: AssistantMessage): AssistantMessageEvent {
  const reason =
    message.stopReason === 'length' || message.stopReason === 'toolUse'
      ? message.stopReason
      : 'stop';
  return { type: 'done', reason, message };
}

function toolCallEvent(
  name: string,
  id: string,
  args: Record<string, unknown>
): AssistantMessageEvent {
  return {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: { type: 'toolCall', id, name, arguments: args },
    partial: createAssistantMessage(),
  };
}

function toolCallMessage(
  name: string,
  id: string,
  args: Record<string, unknown>
): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'toolCall', id, name, arguments: args }],
    stopReason: 'toolUse',
  });
}

function createTool(
  name: string,
  execute: RuntimeToolDefinition['execute'],
  inputSchema: RuntimeToolDefinition['inputSchema'] = {
    title: z.string().nullable(),
    line: z.number().optional(),
  }
): RuntimeToolDefinition {
  return { name, description: `${name} tool`, inputSchema, execute };
}

async function collectEvents(execution: AsyncIterable<unknown>) {
  const events: any[] = [];
  for await (const event of execution) {
    events.push(event);
  }
  return events;
}

describe('openai-responses runtime (pi-ai)', () => {
  const config: ArgusRuntimeConfig = {
    runtime: 'openai-responses',
    models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
    reasoningEffort: 'high',
    openai: { apiKey: 'test-key', baseUrl: 'https://gateway.test', source: 'argus' },
  };

  it('executes tool calls, feeds results back and normalizes the final result', async () => {
    const calls: PiStreamCall[] = [];
    const report = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'issue recorded' }],
    }));
    const streams = [
      createPiStream([
        toolCallEvent('report_issue', 'call_1', { title: 'bug' }),
        doneEvent(toolCallMessage('report_issue', 'call_1', { title: 'bug' })),
      ]),
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'Reviewed.' }] })),
      ]),
    ];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({
        prompt: 'Review the diff',
        cwd: '.',
        maxTurns: 4,
        tools: [createTool('report_issue', report)],
      })
    );

    expect(report).toHaveBeenCalledWith({ title: 'bug' });
    expect(events).toEqual([
      { type: 'activity', event: 'function_call:report_issue' },
      { type: 'assistant.text', text: 'Reviewed.' },
      {
        type: 'result',
        status: 'success',
        text: 'Reviewed.',
        usage: { inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 },
      },
    ]);

    expect(calls[0]!.model.baseUrl).toBe('https://gateway.test/v1');
    expect(calls[0]!.options?.reasoning).toBe('high');
    expect(calls[0]!.options?.apiKey).toBe('test-key');
    // Runtime owns retries; each pi-ai attempt issues one request.
    expect(calls[0]!.options?.maxRetries).toBe(0);
    // 旧实现每个请求都带默认 instructions
    expect(calls[0]!.context.systemPrompt).toBe(
      'Follow the user instructions and tool definitions exactly.'
    );
    expect(calls[1]!.context.messages.at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'report_issue',
      content: [{ type: 'text', text: 'issue recorded' }],
      isError: false,
    });
  });

  it('supports async prompt streams for multi-turn sessions', async () => {
    const seenPrompts: string[] = [];
    const streamSimple = vi.fn((_model: Model<Api>, context: Context) => {
      const last = context.messages.at(-1) as { role: string; content?: string } | undefined;
      if (last?.role === 'user' && typeof last.content === 'string') {
        seenPrompts.push(last.content);
      }
      return createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'ack' }] })),
      ]);
    });

    async function* prompts() {
      yield 'first prompt';
      yield 'second prompt';
    }

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({ prompt: prompts(), cwd: '.', maxTurns: 4 })
    );

    expect(seenPrompts).toEqual(['first prompt', 'second prompt']);
    expect(events.filter((event: any) => event.type === 'result')).toHaveLength(2);
  });

  it.each(['stop', 'length', 'error', 'empty', 'maxTurns', 'throw', 'missing'])(
    'counts earlier tool turns when the final turn ends with %s',
    async (ending) => {
      vi.useFakeTimers();
      const first = toolCallMessage('read', 'call_1|fc_1', { title: 'fixture' });
      const final = createAssistantMessage({
        content:
          ending === 'maxTurns'
            ? first.content
            : ending === 'empty'
              ? []
              : [{ type: 'text', text: 'done' }],
        stopReason: ending === 'length' ? 'length' : ending === 'error' ? 'error' : 'stop',
      });
      const streamSimple = vi
        .fn()
        .mockReturnValueOnce(createPiStream([doneEvent(first)]))
        .mockImplementationOnce(() => {
          if (ending === 'throw') throw new Error('connection lost');
          return createPiStream(ending === 'missing' ? [] : [doneEvent(final)]);
        });
      const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
      const events = await finishRetries(
        collectEvents(
          runtime.execute({
            prompt: 'Review',
            cwd: '.',
            maxTurns: 2,
            tools: [createTool('read', async () => ({ content: [{ type: 'text', text: 'ok' }] }))],
          })
        )
      );
      const countedTurns = ending === 'throw' || ending === 'missing' ? 1 : 2;
      expect(events.at(-1)?.usage).toEqual({
        inputTokens: 12 * countedTurns,
        cachedInputTokens: 2 * countedTurns,
        outputTokens: 4 * countedTurns,
      });
    }
  );

  it('reports disjoint prompt usage for streamed validator challenge rounds', async () => {
    const streamSimple = vi
      .fn()
      .mockReturnValueOnce(createPiStream([doneEvent(toolCallMessage('read', 'call_1', {}))]))
      .mockReturnValueOnce(createPiStream([doneEvent(createAssistantMessage())]))
      .mockReturnValueOnce(createPiStream([doneEvent(createAssistantMessage())]));
    async function* prompts() {
      yield 'first';
      yield 'challenge';
    }
    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({
        prompt: prompts(),
        cwd: '.',
        maxTurns: 3,
        tools: [createTool('read', async () => ({ content: [{ type: 'text', text: 'ok' }] }))],
      })
    );
    expect(events.filter((event) => event.type === 'result').map((event) => event.usage)).toEqual([
      { inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 },
      { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
    ]);
  });

  it('replays pi-ai native reasoning blocks', async () => {
    const calls: PiStreamCall[] = [];
    const report = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const streams = [
      createPiStream([
        toolCallEvent('report_issue', 'call_1', { title: 'bug' }),
        doneEvent(
          createAssistantMessage({
            content: [
              {
                type: 'thinking',
                thinking: 'internal reasoning',
                thinkingSignature: '{"type":"reasoning","id":"rs_1"}',
              },
              { type: 'toolCall', id: 'call_1', name: 'report_issue', arguments: { title: 'bug' } },
            ],
            stopReason: 'toolUse',
          })
        ),
      ]),
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'Reviewed.' }] })),
      ]),
    ];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 4,
        tools: [createTool('report_issue', report)],
      })
    );

    const onPayload = calls[0]!.options?.onPayload;
    expect(typeof onPayload).toBe('function');
    const adjusted = onPayload!(
      {
        input: [
          { role: 'developer', content: 'Review budget: 41 requests for this review.' },
          { role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
        ],
        reasoning: { effort: 'high', summary: 'auto' },
        store: false,
      },
      calls[0]!.model
    );
    expect(adjusted).toEqual({
      instructions: 'Review budget: 41 requests for this review.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Review' }] }],
      reasoning: { effort: 'high', summary: 'auto' },
      store: false,
    });
    const replayed = calls[1]!.context.messages.find((message) => message.role === 'assistant');
    expect(replayed?.content.some((block) => block.type === 'thinking')).toBe(true);
  });

  it('preserves transcript prefixes and warns once when the low watermark is unreachable', async () => {
    const budgetConfig: ArgusRuntimeConfig = {
      ...config,
      openai: { ...config.openai!, transcriptBudgetTokens: 3000 },
    };
    const read = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'z'.repeat(8000) }],
    }));
    const calls: PiStreamCall[] = [];
    const streams: AssistantMessageEventStream[] = [];
    for (let i = 1; i <= 8; i++) {
      streams.push(
        createPiStream([
          toolCallEvent('read', `call_${i}`, { title: `t${i}` }),
          doneEvent(
            createAssistantMessage({
              content: [
                { type: 'toolCall', id: `call_${i}`, name: 'read', arguments: { title: `t${i}` } },
              ],
              stopReason: 'toolUse',
            })
          ),
        ])
      );
    }
    streams.push(
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'Reviewed.' }] })),
      ])
    );
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = new OpenAIResponsesRuntime(budgetConfig, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 12,
        tools: [createTool('read', read)],
      })
    );

    const finalToolResults = calls
      .at(-1)!
      .context.messages.filter((message) => message.role === 'toolResult');
    expect(finalToolResults).toHaveLength(8);
    const firstText = (finalToolResults[0]!.content as Array<{ text?: string }>)[0]!.text!;
    const lastText = (finalToolResults.at(-1)!.content as Array<{ text?: string }>)[0]!.text!;
    expect(firstText).toBe('z'.repeat(8000));
    expect(lastText.startsWith('z')).toBe(true);
    // 保留的最近 6 条本身超预算：不部分折叠，每次会话只告警一次。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('best effort'));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps the folded prefix stable on the next request when the low watermark is reachable', async () => {
    const budgetConfig: ArgusRuntimeConfig = {
      ...config,
      openai: { ...config.openai!, transcriptBudgetTokens: 3000 },
    };
    const read = vi.fn(async () => ({
      content: [
        { type: 'text' as const, text: read.mock.calls.length === 1 ? 'z'.repeat(16000) : 'ok' },
      ],
    }));
    const calls: PiStreamCall[] = [];
    const streams = Array.from({ length: 8 }, (_, index) =>
      createPiStream([doneEvent(toolCallMessage('read', `call_${index + 1}`, {}))])
    );
    streams.push(
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'Reviewed.' }] })),
      ])
    );
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );
    const runtime = new OpenAIResponsesRuntime(budgetConfig, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 10,
        tools: [createTool('read', read)],
      })
    );

    const foldedMessages = calls[7]!.context.messages;
    const toolResults = foldedMessages.filter((message) => message.role === 'toolResult');
    expect(toolResults).toHaveLength(7);
    expect(toolResults[0]).toMatchObject({ toolCallId: 'call_1', toolName: 'read' });
    expect((toolResults[0]!.content as Array<{ text?: string }>)[0]!.text).toContain(
      'removedChars=16000'
    );
    expect(
      toolResults
        .slice(1)
        .every((message) => (message.content as Array<{ text?: string }>)[0]?.text === 'ok')
    ).toBe(true);
    expect(calls[8]!.context.messages.slice(0, foldedMessages.length)).toEqual(foldedMessages);
  });

  it('normalizes tool schemas for strict mode and converts null tool args to undefined', async () => {
    const calls: PiStreamCall[] = [];
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const streams = [
      createPiStream([doneEvent(toolCallMessage('inspect', 'call_1', { title: null, line: 3 }))]),
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'done' }] })),
      ]),
    ];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 4,
        tools: [createTool('inspect', execute)],
      })
    );

    const schema = calls[0]!.context.tools![0]!.parameters as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required as string[])).toEqual(new Set(['title', 'line']));
    expect(execute).toHaveBeenCalledWith({ title: undefined, line: 3 });
  });

  it('blocks context tools in the closing phase but keeps reporting tools available', async () => {
    const read = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'evidence' }] }));
    const streamSimple = vi.fn(() =>
      createPiStream([doneEvent(toolCallMessage('read', 'call_1', { title: 'a' }))])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 1,
        tools: [createTool('read', read), createTool('report_issue', read)],
        completionBudget: { reserveTurns: 1, toolNames: ['report_issue'] },
      })
    );

    expect(read).not.toHaveBeenCalled();
    const messages = streamSimple.mock.calls.length;
    expect(messages).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'error_max_turns' });
  });

  it('reports max-turn exhaustion while tools keep being requested', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const streamSimple = vi.fn(() =>
      createPiStream([doneEvent(toolCallMessage('read', 'call_1', { title: 'a' }))])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 2,
        tools: [createTool('read', execute)],
      })
    );

    expect(streamSimple).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      status: 'error_max_turns',
      error: 'OpenAI Responses runtime exhausted maxTurns while resolving tool calls',
    });
  });

  it('does not run tool calls that the output budget cut short', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const streamSimple = vi.fn(() =>
      createPiStream([
        doneEvent(
          createAssistantMessage({
            content: [
              // 参数可能被截断或串位：这样的调用不能交给工具执行
              { type: 'toolCall', id: 'call_1', name: 'read', arguments: { title: 'trunc' } },
            ],
            stopReason: 'length',
            rawStopReason: 'incomplete.max_output_tokens',
          })
        ),
      ])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 1,
        tools: [createTool('read', execute)],
      })
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'result',
        status: 'incomplete',
        rawStopReason: 'incomplete.max_output_tokens',
        usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
      },
    ]);
    expect(streamSimple).toHaveBeenCalledTimes(1);
  });

  it('reports completed turns with no text or tool calls as an error', async () => {
    const streamSimple = vi.fn(() =>
      createPiStream([doneEvent(createAssistantMessage({ content: [] }))])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 2 })
    );

    expect(events).toEqual([
      {
        type: 'result',
        status: 'error_empty_output',
        usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
        error: 'OpenAI Responses stream completed without text or tool calls',
      },
    ]);
  });

  it('surfaces assistant failures as an error result', async () => {
    vi.useFakeTimers();
    const streamSimple = vi.fn(() =>
      createPiStream([
        {
          type: 'error',
          reason: 'error',
          error: createAssistantMessage({
            content: [],
            stopReason: 'error',
            errorMessage: 'OpenAI API error (429): rate limited',
          }),
        },
      ])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await finishRetries(
      collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 2 }))
    );

    expect(events).toEqual([
      {
        type: 'result',
        status: 'error',
        usage: { inputTokens: 36, cachedInputTokens: 6, outputTokens: 12 },
        error: 'OpenAI API error (429): rate limited',
      },
    ]);
  });

  it('throws AbortError instead of returning a result event when the turn is aborted', async () => {
    const streamSimple = vi.fn(() =>
      createPiStream([
        {
          type: 'error',
          reason: 'aborted',
          error: createAssistantMessage({ content: [], stopReason: 'aborted' }),
        },
      ])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });

    await expect(
      collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 2 }))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a truncated turn without text as incomplete rather than empty output', async () => {
    const streamSimple = vi.fn(() =>
      createPiStream([
        doneEvent(
          createAssistantMessage({
            content: [{ type: 'thinking', thinking: 'scratchpad' }],
            stopReason: 'length',
            rawStopReason: 'incomplete.max_output_tokens',
          })
        ),
      ])
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    const events = await collectEvents(
      runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 2 })
    );

    expect(events).toEqual([
      {
        type: 'result',
        status: 'incomplete',
        rawStopReason: 'incomplete.max_output_tokens',
        usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
      },
    ]);
  });

  it('declares strict tools and never lets pi-ai send max_output_tokens', () => {
    const runtime = new OpenAIResponsesRuntime(config, { streamSimple: vi.fn() });
    expect(runtime.model.compat).toEqual({
      supportsStrictMode: true,
      // 整个 pi-ai 路径不发送 max_output_tokens：32k 上限被长推理吃光会触发整轮 agent 重试
      supportsMaxOutputTokens: false,
      supportsDeveloperRole: true,
    });

    const systemRoleRuntime = new OpenAIResponsesRuntime(
      { ...config, openai: { ...config.openai!, supportsDeveloperRole: false } },
      { streamSimple: vi.fn() }
    );
    expect(systemRoleRuntime.model.compat?.supportsDeveloperRole).toBe(false);
  });

  it('strips $schema and marks optional tool properties nullable for strict mode', async () => {
    const calls: PiStreamCall[] = [];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return createPiStream([
          doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'ok' }] })),
        ]);
      }
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 2,
        tools: [
          createTool('inspect', async () => ({ content: [{ type: 'text', text: 'ok' }] }), {
            requiredValue: z.string(),
            nested: z.object({ id: z.string().optional() }),
          }),
        ],
      })
    );

    const schema = calls[0]!.context.tools![0]!.parameters as Record<string, any>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['requiredValue', 'nested']);
    expect(schema.properties.requiredValue.type).toBe('string');
    // 嵌套 object 同样被归一化，且可选字段被显式标成 nullable
    expect(schema.properties.nested.additionalProperties).toBe(false);
    expect(schema.properties.nested.required).toEqual(['id']);
    expect(schema.properties.nested.properties.id.type).toEqual(['string', 'null']);
  });

  it('does not abort an externally managed AbortController when execution is closed', async () => {
    const externalAbortController = new AbortController();
    const streamSimple = vi.fn(() => createPiStream([doneEvent(createAssistantMessage())]));
    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });

    const execution = runtime.execute({
      prompt: 'Review',
      cwd: '.',
      maxTurns: 2,
      abortController: externalAbortController,
    });

    await execution.close();

    expect(externalAbortController.signal.aborted).toBe(false);
    expect(streamSimple).not.toHaveBeenCalled();
  });
});

describe('openai-responses text generation (pi-ai)', () => {
  const config: ArgusRuntimeConfig = {
    runtime: 'openai-responses',
    models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
    reasoningEffort: 'high',
    openai: { apiKey: 'test-key', source: 'argus' },
  };

  it('generates plain text and forwards the reasoning effort', async () => {
    const completeSimple = vi.fn(async () =>
      createAssistantMessage({ content: [{ type: 'text', text: 'summary' }] })
    );
    const runtime = new OpenAIResponsesRuntime(config, { completeSimple });

    const result = await runtime.generateText({ prompt: 'Summarize', maxOutputTokens: 512 });

    expect(result).toEqual({
      text: 'summary',
      usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
    });
    expect(completeSimple.mock.calls[0]![2]).toMatchObject({
      apiKey: 'test-key',
      maxTokens: 512,
      reasoning: 'high',
    });
  });

  it('throws when the model returns no text', async () => {
    const completeSimple = vi.fn(async () =>
      createAssistantMessage({
        content: [{ type: 'thinking', thinking: 'scratchpad' }],
        stopReason: 'length',
      })
    );
    const runtime = new OpenAIResponsesRuntime(config, { completeSimple });

    await expect(
      runtime.generateText({ prompt: 'Summarize', maxOutputTokens: 512 })
    ).rejects.toThrow(/without text output/);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('maps reasoning effort through the documented thinking level vocabulary', () => {
    expect(toThinkingLevel('none')).toBeUndefined();
    expect(toThinkingLevel(undefined)).toBeUndefined();
    expect(toThinkingLevel('max')).toBe('max');
  });

  it('ignores an unsupported reasoning effort instead of letting pi-ai clamp it to minimal', async () => {
    const calls: PiStreamCall[] = [];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return createPiStream([
          doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'ok' }] })),
        ]);
      }
    );
    const unknownConfig: ArgusRuntimeConfig = { ...config, reasoningEffort: 'hgih' };

    const runtime = new OpenAIResponsesRuntime(unknownConfig, { streamSimple });
    await collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 }));

    expect(toThinkingLevel('hgih')).toBeUndefined();
    // 未识别时不声明 reasoning，pi-ai 就不会把未知档位钳成 minimal
    expect(runtime.model.reasoning).toBe(false);
    expect(calls[0]!.options?.reasoning).toBeUndefined();

    // 显式 none 仍要声明 reasoning（pi-ai 会写 effort=none）
    expect(
      new OpenAIResponsesRuntime(
        { ...config, reasoningEffort: 'none' },
        { completeSimple: vi.fn() }
      ).model.reasoning
    ).toBe(true);
  });

  it('declares json_schema constrained sampling so pi-ai actually sends strict tools', () => {
    const tool = createTool('inspect', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const [converted] = convertResponsesTools([toPiTool(tool)], { supportsStrictMode: true });

    // pi-ai 的 defaultStrict 是 false，只有 constrainedSampling 才能让 strict 变成 true
    expect(converted?.strict).toBe(true);
    expect(converted?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('sends the legacy default instructions and surfaces the provider status on errors', async () => {
    vi.useFakeTimers();
    const calls: PiStreamCall[] = [];
    const completeSimple = vi.fn(
      async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return createAssistantMessage({
          content: [],
          stopReason: 'error',
          errorMessage: 'OpenAI API error (500): upstream failed',
        });
      }
    );
    const runtime = new OpenAIResponsesRuntime(config, { completeSimple });

    // realtime-deduplicator 之类的调用方按 error.status 判断是否重试
    await finishRetries(
      expect(runtime.generateText({ prompt: 'Summarize' })).rejects.toMatchObject({
        message: 'OpenAI API error (500): upstream failed',
        status: 500,
      })
    );
    expect(calls[0]!.context.systemPrompt).toBe(
      'Follow the user instructions and tool definitions exactly.'
    );
  });
});

describe('review completion budget (pi-ai)', () => {
  const config: ArgusRuntimeConfig = {
    runtime: 'openai-responses',
    models: { main: 'test', light: 'test', validator: 'test' },
    openai: { apiKey: 'test', source: 'argus' },
  };

  it('does not turn a successful final allowed request into max-turn failure', async () => {
    const streamSimple = vi.fn(() =>
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'no issues' }] })),
      ])
    );
    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });

    const events = await collectEvents(
      runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 })
    );

    expect(
      events.filter((event: any) => event.type === 'result').map((event: any) => event.status)
    ).toEqual(['success']);
  });

  it('keeps the prompt prefix byte-identical across turns so the provider cache can hit', async () => {
    const calls: PiStreamCall[] = [];
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const streams = [
      createPiStream([doneEvent(toolCallMessage('read', 'call_1', { title: 'a' }))]),
      createPiStream([doneEvent(toolCallMessage('read', 'call_2', { title: 'b' }))]),
      createPiStream([doneEvent(toolCallMessage('read', 'call_3', { title: 'c' }))]),
      createPiStream([
        doneEvent(createAssistantMessage({ content: [{ type: 'text', text: 'done' }] })),
      ]),
    ];
    const streamSimple = vi.fn(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return streams.shift()!;
      }
    );

    const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
    await collectEvents(
      runtime.execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 4,
        tools: [createTool('read', execute)],
        completionBudget: { reserveTurns: 1, toolNames: ['report_issue'] },
      })
    );

    // 1) instructions 每一轮完全一致
    const instructions = calls.map((call) => call.context.systemPrompt);
    expect(new Set(instructions).size).toBe(1);
    expect(instructions[0]).toContain('Reserve the last 1 turns for reporting');
    expect(instructions[0]).toContain('Follow the user instructions and tool definitions exactly');

    // 2) tools 定义每一轮完全一致
    const toolSignatures = calls.map((call) =>
      JSON.stringify(call.context.tools?.map((tool) => tool.name))
    );
    expect(new Set(toolSignatures).size).toBe(1);

    // 3) 原始 prompt 仍是前缀，逐轮变化的预算提示只出现在末尾
    const firstMessages = calls[0]!.context.messages;
    expect(firstMessages[0]).toMatchObject({ role: 'user', content: 'Review' });
    expect(String((firstMessages.at(-1) as { content?: string }).content)).toContain(
      '4 requests remaining'
    );

    const secondMessages = calls[1]!.context.messages;
    expect(secondMessages[0]).toMatchObject({ role: 'user', content: 'Review' });
    expect(String((secondMessages.at(-1) as { content?: string }).content)).toContain(
      '3 requests remaining'
    );
    // 预算提示只作为请求末尾的临时消息：transcript 本身仍是
    // user → assistant(toolCall) → toolResult，原始 prompt 依旧是第一个元素。
    expect(secondMessages.slice(0, 3).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
    ]);
    expect((secondMessages[1] as { content: Array<{ type: string }> }).content[0]!.type).toBe(
      'toolCall'
    );

    // maxTurns=4 且 reserveTurns=1：第 4 轮才进入收尾阶段
    const closingMessages = calls[3]!.context.messages;
    expect(String((closingMessages.at(-1) as { content?: string }).content)).toContain(
      'closing phase'
    );
  });
});

describe('pi-ai provider recovery', () => {
  const config: ArgusRuntimeConfig = {
    runtime: 'openai-responses',
    models: { main: 'test', light: 'test', validator: 'test' },
    openai: { apiKey: 'test', source: 'argus' },
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 502, 503, 599, 'thrown'])(
    'retries every provider error %s exactly twice with built-in retries disabled',
    async (status) => {
      const error = createAssistantMessage({
        content: [],
        stopReason: 'error',
        errorMessage: `OpenAI API error (${status}): failed`,
      });
      const streamSimple = vi.fn(() => {
        if (status === 'thrown') throw 'arbitrary thrown value';
        return createPiStream([{ type: 'error', reason: 'error', error }]);
      });
      const runtime = new OpenAIResponsesRuntime(config, { streamSimple });
      const events = await finishRetries(
        collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 }))
      );
      expect(streamSimple).toHaveBeenCalledTimes(3);
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        status: 'error',
        usage:
          status === 'thrown'
            ? undefined
            : { inputTokens: 36, cachedInputTokens: 6, outputTokens: 12 },
      });
      for (const call of streamSimple.mock.calls) expect(call[2]).toMatchObject({ maxRetries: 0 });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  const runHttpRequest = (runtime: OpenAIResponsesRuntime, mode: 'text' | 'stream') =>
    mode === 'text'
      ? runtime.generateText({ prompt: 'Review' })
      : collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 }));

  const httpFailure = (headers: Record<string, string>, status = 429) =>
    new globalThis.Response(JSON.stringify({ error: { message: 'Try again later' } }), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const httpSuccess = () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
      },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Recovered' },
      {
        type: 'response.completed',
        response: {
          id: 'recovered',
          status: 'completed',
          output: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ];
    return new globalThis.Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      }
    );
  };

  it.each(['text', 'stream'] as const)(
    'preserves HTTP retry hints through real pi-ai normalization for %s requests',
    async (mode) => {
      // Preload the real adapter so the lazy provider import does not depend on timer advancement.
      await import('@earendil-works/pi-ai/api/openai-responses');
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(async () => httpFailure({ 'Retry-After': '8' }))
        .mockImplementationOnce(async () => httpFailure({}, 503))
        .mockImplementationOnce(async () => httpSuccess());
      const pending = runHttpRequest(new OpenAIResponsesRuntime(config), mode);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(7999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      // The second attempt has no hint: do not reuse the previous attempt's eight seconds.
      await vi.advanceTimersByTimeAsync(3999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(3);
      const result = await pending;
      if (mode === 'text') {
        expect(result).toMatchObject({
          text: 'Recovered',
          usage: { inputTokens: 3, outputTokens: 1 },
        });
      } else {
        expect(result).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'result', status: 'success' })])
        );
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(
    (['text', 'stream'] as const).flatMap((mode) =>
      (['milliseconds', 'date', 'capped'] as const).map((hint) => ({ mode, hint }))
    )
  )('honors $hint HTTP retry hints with the same request cap for $mode', async ({ mode, hint }) => {
    await import('@earendil-works/pi-ai/api/openai-responses');
    vi.setSystemTime(new Date('2026-10-27T06:00:00Z'));
    const delayMs = hint === 'capped' ? 10_000 : 8_000;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        httpFailure(
          hint === 'milliseconds'
            ? { 'retry-after-ms': '8000', 'retry-after': '1' }
            : { 'retry-after': hint === 'date' ? new Date(Date.now() + 8000).toUTCString() : '60' }
        )
      );
    const pending = runHttpRequest(new OpenAIResponsesRuntime(config), mode).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let calls = 1; calls < 3; calls++) {
      expect(fetch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(fetch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(calls + 1);
    }
    const result = await pending;
    if (mode === 'text') {
      // Preserve the hint on the final error for outer recovery, not just the local delay.
      expect(result).toMatchObject({
        status: 429,
        retryAfterMs: hint === 'capped' ? 60_000 : 8_000,
      });
    } else {
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'result', status: 'error' })])
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['text', 'stream'] as const)(
    'cancels a server-hinted retry wait without another %s request',
    async (mode) => {
      await import('@earendil-works/pi-ai/api/openai-responses');
      const controller = new AbortController();
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => httpFailure({ 'retry-after': '8' }));
      const runtime = new OpenAIResponsesRuntime(config);
      const pending = (
        mode === 'text'
          ? runtime.generateText({ prompt: 'Review', abortController: controller })
          : collectEvents(
              runtime.execute({
                prompt: 'Review',
                cwd: '.',
                maxTurns: 1,
                abortController: controller,
              })
            )
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort('cancel hinted retry');
      expect(await pending).toMatchObject({ name: 'AbortError', cause: 'cancel hinted retry' });
      await vi.runAllTimersAsync();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('recovers text generation after a completed empty response', async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValueOnce(createAssistantMessage({ content: [] }))
      .mockResolvedValueOnce(
        createAssistantMessage({ content: [{ type: 'text', text: 'Recovered' }] })
      );
    const result = await finishRetries(
      new OpenAIResponsesRuntime(config, { completeSimple }).generateText({ prompt: 'Summary' })
    );

    expect(result).toEqual({
      text: 'Recovered',
      usage: { inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 },
    });
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  it('retries completed empty text three times and reports attempts and accumulated usage', async () => {
    const completeSimple = vi.fn(async () => createAssistantMessage({ content: [] }));
    const error = await finishRetries(
      new OpenAIResponsesRuntime(config, { completeSimple })
        .generateText({ prompt: 'Summary' })
        .then(
          () => undefined,
          (thrown: Error) => thrown
        )
    );

    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(error?.message).toContain('attempts=3');
    expect(error?.message).toContain('tokensUsed=48');
  });

  it('shares the three-request budget between request errors and completed empty text', async () => {
    const completeSimple = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(createAssistantMessage({ content: [] }))
      .mockResolvedValueOnce(
        createAssistantMessage({ content: [{ type: 'text', text: 'Recovered' }] })
      );
    const result = await finishRetries(
      new OpenAIResponsesRuntime(config, { completeSimple }).generateText({ prompt: 'Summary' })
    );

    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      text: 'Recovered',
      usage: { inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 },
    });
  });

  it('cancels the retry after a completed empty response during backoff', async () => {
    const controller = new AbortController();
    const completeSimple = vi.fn(async () => createAssistantMessage({ content: [] }));
    const pending = new OpenAIResponsesRuntime(config, { completeSimple })
      .generateText({ prompt: 'Summary', abortController: controller })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    controller.abort('cancel empty retry');
    expect(await pending).toMatchObject({ name: 'AbortError', cause: 'cancel empty retry' });
    await vi.runAllTimersAsync();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves completed tool output across failed continuation SSE without executing failed tools', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'saved evidence' }],
    }));
    const failed = createAssistantMessage({
      content: [
        { type: 'toolCall', id: 'failed_call', name: 'read', arguments: {} },
        { type: 'text', text: 'Do not publish' },
      ],
      stopReason: 'error',
      errorMessage: 'OpenAI API error (502): failed',
    });
    const streamSimple = vi
      .fn()
      .mockReturnValueOnce(
        createPiStream([doneEvent(toolCallMessage('read', 'completed_call', {}))])
      )
      .mockReturnValueOnce(
        createPiStream([
          toolCallEvent('read', 'failed_call', {}),
          { type: 'error', reason: 'error', error: failed },
        ])
      )
      .mockReturnValueOnce(createPiStream([doneEvent(createAssistantMessage())]));
    const events = await finishRetries(
      collectEvents(
        new OpenAIResponsesRuntime(config, { streamSimple }).execute({
          prompt: 'Review',
          cwd: '.',
          maxTurns: 2,
          tools: [createTool('read', execute)],
        })
      )
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(streamSimple.mock.calls[2]![1]).toEqual(streamSimple.mock.calls[1]![1]);
    expect(streamSimple.mock.calls[2]![1].messages.at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'completed_call',
      content: [{ type: 'text', text: 'saved evidence' }],
    });
    expect(events.filter((event) => event.type === 'activity')).toEqual([
      { type: 'activity', event: 'function_call:read' },
    ]);
    expect(events.filter((event) => event.type === 'assistant.text')).toEqual([
      { type: 'assistant.text', text: 'ok' },
    ]);
    expect(events.at(-1)).toMatchObject({
      status: 'success',
      usage: { inputTokens: 36, cachedInputTokens: 6, outputTokens: 12 },
    });
  });

  it('retries EOF without a terminal and does not execute partial tool calls', async () => {
    const execute = vi.fn();
    const streamSimple = vi
      .fn()
      .mockReturnValueOnce(createPiStream([toolCallEvent('read', 'partial', {})]))
      .mockReturnValueOnce(createPiStream([doneEvent(createAssistantMessage())]));
    const events = await finishRetries(
      collectEvents(
        new OpenAIResponsesRuntime(config, { streamSimple }).execute({
          prompt: 'Review',
          cwd: '.',
          maxTurns: 1,
          tools: [createTool('read', execute)],
        })
      )
    );
    expect(execute).not.toHaveBeenCalled();
    expect(streamSimple).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'result').map((event) => event.status)).toEqual([
      'success',
    ]);
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 },
    });
  });

  it.each(['cancelled', { arbitrary: true }, 123])(
    'cancels retry backoff for reason %j',
    async (reason) => {
      const controller = new AbortController();
      const streamSimple = vi.fn(() => {
        throw new Error('network');
      });
      const pending = collectEvents(
        new OpenAIResponsesRuntime(config, { streamSimple }).execute({
          prompt: 'Review',
          cwd: '.',
          maxTurns: 1,
          abortController: controller,
        })
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      expect(await pending).toMatchObject({ name: 'AbortError', cause: reason });
      await vi.runAllTimersAsync();
      expect(streamSimple).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('bounds unresponsive stream next and return without leaking idle listeners', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const cleanup = vi.fn(() => new Promise(() => {}));
    const streamSimple = vi.fn(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: cleanup }),
        }) as AssistantMessageEventStream
    );
    const events = await finishRetries(
      collectEvents(
        new OpenAIResponsesRuntime(config, { streamSimple }).execute({
          prompt: 'Review',
          cwd: '.',
          maxTurns: 1,
          abortController: controller,
        })
      )
    );
    expect(streamSimple).toHaveBeenCalledTimes(3);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      {
        type: 'result',
        status: 'error',
        usage: undefined,
        error: 'Model stream idle timeout after 300000ms',
      },
    ]);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it('finishes at the terminal without waiting for a hung trailing iterator', async () => {
    const cleanup = vi.fn(() => new Promise(() => {}));
    const streamSimple = vi.fn(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: doneEvent(createAssistantMessage()) })
              .mockImplementation(() => new Promise(() => {})),
            return: cleanup,
          }),
        }) as AssistantMessageEventStream
    );
    const events = await collectEvents(
      new OpenAIResponsesRuntime(config, { streamSimple }).execute({
        prompt: 'Review',
        cwd: '.',
        maxTurns: 1,
      })
    );
    expect(events.at(-1)).toMatchObject({ status: 'success' });
    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['thrown', 'failed'])(
    'recovers generateText %s errors and accounts for reported failed usage',
    async (kind) => {
      const completeSimple = vi.fn();
      if (kind === 'thrown')
        completeSimple.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }));
      else
        completeSimple.mockResolvedValueOnce(
          createAssistantMessage({ stopReason: 'error', errorMessage: 'upstream failed' })
        );
      completeSimple
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(createAssistantMessage());
      const result = await finishRetries(
        new OpenAIResponsesRuntime(config, { completeSimple }).generateText({ prompt: 'Summarize' })
      );
      expect(result).toMatchObject({
        text: 'ok',
        usage: {
          inputTokens: kind === 'failed' ? 24 : 12,
          cachedInputTokens: kind === 'failed' ? 4 : 2,
          outputTokens: kind === 'failed' ? 8 : 4,
        },
      });
      expect(completeSimple).toHaveBeenCalledTimes(3);
      for (const call of completeSimple.mock.calls)
        expect(call[2]).toMatchObject({ maxRetries: 0 });
    }
  );

  it('propagates cancellation from an unresponsive generateText call', async () => {
    const controller = new AbortController();
    const completeSimple = vi.fn(() => new Promise<AssistantMessage>(() => {}));
    const pending = new OpenAIResponsesRuntime(config, { completeSimple })
      .generateText({ prompt: 'Summarize', abortController: controller })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort('user cancelled');
    expect(await pending).toMatchObject({ name: 'AbortError', cause: 'user cancelled' });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pi-ai raw provider events', () => {
  const config: ArgusRuntimeConfig = {
    runtime: 'openai-responses',
    models: { main: 'test', light: 'test', validator: 'test' },
    openai: { apiKey: 'test', source: 'argus' },
  };
  beforeEach(() => vi.useFakeTimers());

  it.each(['execute', 'generateText'])(
    'retains failed SSE usage omitted by pi-ai normalization in %s',
    async (mode) => {
      const failed = createAssistantMessage({
        stopReason: 'error',
        errorMessage: 'provider failed',
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      let attempts = 0;
      const response = (model: Model<Api>, options?: SimpleStreamOptions) => {
        attempts++;
        if (attempts === 1) {
          options?.onProviderStreamEvent?.(
            {
              type: 'response.failed',
              response: {
                usage: {
                  input_tokens: 41,
                  output_tokens: 7,
                  input_tokens_details: { cached_tokens: 9 },
                },
              },
            },
            model
          );
          return failed;
        }
        return createAssistantMessage();
      };
      const runtime = new OpenAIResponsesRuntime(config, {
        completeSimple: async (model, _context, options) => response(model, options),
        streamSimple: (model, _context, options) => {
          const message = response(model, options);
          return createPiStream(
            message.stopReason === 'error'
              ? [{ type: 'error', reason: 'error', error: message }]
              : [doneEvent(message)]
          );
        },
      });
      const result =
        mode === 'execute'
          ? (
              await finishRetries(
                collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 }))
              )
            ).at(-1)
          : await finishRetries(runtime.generateText({ prompt: 'Summary' }));
      expect(result).toMatchObject({
        usage: { inputTokens: 53, cachedInputTokens: 11, outputTokens: 11 },
      });
      expect(attempts).toBe(2);
    }
  );

  it.each(['execute', 'generateText'])(
    'refreshes idle time for raw events during a long active %s request',
    async (mode) => {
      let attempts = 0;
      const complete = async (model: Model<Api>, options?: SimpleStreamOptions) => {
        attempts++;
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 240000));
          await options?.onProviderStreamEvent?.(
            { type: 'response.in_progress', response: {} },
            model
          );
        }
        return createAssistantMessage();
      };
      const runtime = new OpenAIResponsesRuntime(config, {
        completeSimple: (model, _context, options) => complete(model, options),
        streamSimple: (model, _context, options) =>
          ({
            async *[Symbol.asyncIterator]() {
              yield doneEvent(await complete(model, options));
            },
          }) as AssistantMessageEventStream,
      });
      const result =
        mode === 'execute'
          ? (
              await finishRetries(
                collectEvents(runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 1 }))
              )
            ).at(-1)
          : await finishRetries(runtime.generateText({ prompt: 'Summary' }));
      expect(result).toMatchObject({ text: 'ok' });
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
