import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  escalateMaxOutputTokens,
  toPiTool,
  toThinkingLevel,
} from '../../src/runtime/openai-responses.js';
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
        usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
      },
    ]);

    expect(calls[0]!.model.baseUrl).toBe('https://gateway.test/v1');
    expect(calls[0]!.options?.reasoning).toBe('high');
    expect(calls[0]!.options?.apiKey).toBe('test-key');
    // 改造前 SDK 默认重试 2 次；pi-ai 默认 0，必须显式传回
    expect(calls[0]!.options?.maxRetries).toBe(2);
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
    const events = await collectEvents(
      runtime.execute({ prompt: 'Review', cwd: '.', maxTurns: 2 })
    );

    expect(events).toEqual([
      {
        type: 'result',
        status: 'error',
        usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4 },
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

  it('declares strict tool mode and the gateway max_output_tokens capability to pi-ai', () => {
    const runtime = new OpenAIResponsesRuntime(config, { streamSimple: vi.fn() });
    expect(runtime.model.compat).toEqual({
      supportsStrictMode: true,
      supportsMaxOutputTokens: true,
      supportsDeveloperRole: true,
    });

    const limitedRuntime = new OpenAIResponsesRuntime(
      { ...config, openai: { ...config.openai!, supportsMaxOutputTokens: false } },
      { streamSimple: vi.fn() }
    );
    expect(limitedRuntime.model.compat?.supportsMaxOutputTokens).toBe(false);

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

  it('escalates the output budget once when reasoning exhausted it', async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValueOnce(
        createAssistantMessage({
          content: [{ type: 'thinking', thinking: 'scratchpad' }],
          stopReason: 'length',
          rawStopReason: 'incomplete.max_output_tokens',
        })
      )
      .mockResolvedValueOnce(
        createAssistantMessage({ content: [{ type: 'text', text: 'recovered' }] })
      );
    const runtime = new OpenAIResponsesRuntime(config, { completeSimple });

    const result = await runtime.generateText({ prompt: 'Summarize', maxOutputTokens: 512 });

    expect(result.text).toBe('recovered');
    expect(completeSimple.mock.calls[1]![2]).toMatchObject({ maxTokens: 2048 });
    // 两次尝试的 token 都要计入用量
    expect(result.usage).toEqual({ inputTokens: 24, cachedInputTokens: 4, outputTokens: 8 });
  });

  it('stops escalating once the local ceiling is reached', async () => {
    const completeSimple = vi.fn(async () =>
      createAssistantMessage({
        content: [{ type: 'thinking', thinking: 'scratchpad' }],
        stopReason: 'length',
        rawStopReason: 'incomplete.max_output_tokens',
      })
    );
    const runtime = new OpenAIResponsesRuntime(config, { completeSimple });

    await expect(
      runtime.generateText({ prompt: 'Summarize', maxOutputTokens: 8192 })
    ).rejects.toThrow(/without text output/);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('does not escalate when the gateway rejects max_output_tokens anyway', async () => {
    const completeSimple = vi.fn(async () =>
      createAssistantMessage({
        content: [{ type: 'thinking', thinking: 'scratchpad' }],
        stopReason: 'length',
        rawStopReason: 'incomplete.max_output_tokens',
      })
    );
    const runtime = new OpenAIResponsesRuntime(
      { ...config, openai: { ...config.openai!, supportsMaxOutputTokens: false } },
      { completeSimple }
    );

    // pi-ai 不会发送该参数，重试只会重复同一个请求
    await expect(
      runtime.generateText({ prompt: 'Summarize', maxOutputTokens: 512 })
    ).rejects.toThrow(/without text output/);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('escalates and caps the budget inside the documented policy window', () => {
    expect(escalateMaxOutputTokens(512)).toBe(2048);
    expect(escalateMaxOutputTokens(2048)).toBe(4096);
    expect(escalateMaxOutputTokens(8192)).toBeUndefined();
    expect(escalateMaxOutputTokens(-1)).toBeUndefined();
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
    await expect(runtime.generateText({ prompt: 'Summarize' })).rejects.toMatchObject({
      message: 'OpenAI API error (500): upstream failed',
      status: 500,
    });
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
