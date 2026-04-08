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

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(_options: unknown) {}
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
import type { ArgusRuntimeConfig } from '../../src/config/env.js';

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

type MockOpenAIResponse = {
  id: string;
  status?: string | null;
  output?: Array<Record<string, any>>;
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    message?: string;
  } | null;
};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createOpenAIResponseStream(
  response: MockOpenAIResponse,
  options: { textChunks?: string[] } = {}
) {
  let sequenceNumber = 1;
  const events: Array<Record<string, any>> = [
    {
      type: 'response.created',
      sequence_number: sequenceNumber++,
      response: {
        id: response.id,
        status: 'in_progress',
        output: [],
      },
    },
  ];

  const output = Array.isArray(response.output) ? response.output : [];
  for (const [outputIndex, item] of output.entries()) {
    if (item.type === 'message') {
      events.push({
        type: 'response.output_item.added',
        sequence_number: sequenceNumber++,
        output_index: outputIndex,
        item: {
          ...cloneValue(item),
          content: [],
        },
      });

      const content = Array.isArray(item.content) ? item.content : [];
      for (const [contentIndex, part] of content.entries()) {
        if (part.type !== 'output_text') {
          continue;
        }

        events.push({
          type: 'response.content_part.added',
          sequence_number: sequenceNumber++,
          output_index: outputIndex,
          content_index: contentIndex,
          part: {
            ...cloneValue(part),
            text: '',
          },
        });

        const textChunks = options.textChunks ?? [part.text];
        for (const chunk of textChunks) {
          events.push({
            type: 'response.output_text.delta',
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: chunk,
          });
        }
      }

      continue;
    }

    if (item.type === 'function_call') {
      events.push({
        type: 'response.output_item.added',
        sequence_number: sequenceNumber++,
        output_index: outputIndex,
        item: {
          ...cloneValue(item),
          arguments: '',
        },
      });

      events.push({
        type: 'response.function_call_arguments.delta',
        sequence_number: sequenceNumber++,
        output_index: outputIndex,
        item_id: item.id,
        delta: item.arguments,
      });
    }
  }

  events.push({
    type:
      response.status === 'failed'
        ? 'response.failed'
        : response.status === 'incomplete'
          ? 'response.incomplete'
          : 'response.completed',
    sequence_number: sequenceNumber++,
    response: cloneValue({
      id: response.id,
      status: response.status ?? 'completed',
      output_text: response.output_text,
      output: response.output ?? [],
      usage: response.usage,
      error: response.error,
    }),
  });

  return {
    ...createAsyncStream(events),
    controller: new AbortController(),
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

  it('executes OpenAI Responses tool calls and normalizes the final result', async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_1',
        status: 'completed',
        output_text: '',
        output: [
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'report_issue',
            arguments: JSON.stringify({
              file: 'src/api/service.ts',
              line_start: 18,
              line_end: 21,
              title: 'Missing error handling',
            }),
            status: 'completed',
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        })
      )
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_2',
        status: 'completed',
        output_text: 'Done',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Done',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        })
      );

    const executeTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'Issue recorded' }],
    });

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 6,
      tools: [
        {
          name: 'report_issue',
          description: 'Capture an issue',
          inputSchema: {
            file: z.string(),
            line_start: z.number(),
            line_end: z.number(),
            title: z.string(),
          },
          execute: executeTool,
        },
      ],
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        input: 'Review this diff',
        stream: true,
        parallel_tool_calls: false,
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'report_issue',
            strict: true,
            description: 'Capture an issue',
            parameters: expect.objectContaining({
              type: 'object',
              properties: expect.objectContaining({
                file: expect.any(Object),
                line_start: expect.any(Object),
                line_end: expect.any(Object),
                title: expect.any(Object),
              }),
            }),
          }),
        ],
      }),
      expect.any(Object)
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        stream: true,
        previous_response_id: 'resp_1',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Issue recorded',
          },
        ],
      }),
      expect.any(Object)
    );

    expect(executeTool).toHaveBeenCalledWith({
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      title: 'Missing error handling',
    });

    expect(events).toEqual([
      {
        type: 'activity',
        event: 'function_call:report_issue',
      },
      {
        type: 'assistant.text',
        text: 'Done',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Done',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
        },
      },
    ]);
  });

  it('falls back to stateless tool-loop replay when previous_response_id tool follow-ups fail upstream', async () => {
    const upstreamError = Object.assign(new Error('502 Upstream request failed'), {
      status: 502,
      error: {
        message: 'Upstream request failed',
        type: 'upstream_error',
      },
    });

    const createMock = vi
      .fn()
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_1',
        status: 'completed',
        output_text: '',
        output: [
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'report_issue',
            arguments: JSON.stringify({
              file: 'src/api/service.ts',
              line_start: 18,
              line_end: 21,
              title: 'Missing error handling',
            }),
            status: 'completed',
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
        },
        })
      )
      .mockRejectedValueOnce(upstreamError)
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_2',
        status: 'completed',
        output_text: 'Done',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Done',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
        },
        })
      );

    const executeTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'Issue recorded' }],
    });

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 6,
      tools: [
        {
          name: 'report_issue',
          description: 'Capture an issue',
          inputSchema: {
            file: z.string(),
            line_start: z.number(),
            line_end: z.number(),
            title: z.string(),
          },
          execute: executeTool,
        },
      ],
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        stream: true,
        previous_response_id: 'resp_1',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Issue recorded',
          },
        ],
      }),
      expect.any(Object)
    );
    expect(createMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review this diff' }],
          },
          expect.objectContaining({
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'report_issue',
          }),
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Issue recorded',
          },
        ],
      }),
      expect.any(Object)
    );
    expect(createMock.mock.calls[2]?.[0]?.previous_response_id).toBeUndefined();

    expect(events).toEqual([
      {
        type: 'activity',
        event: 'function_call:report_issue',
      },
      {
        type: 'assistant.text',
        text: 'Done',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Done',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
        },
      },
    ]);
  });

  it('supports async prompt streams for multi-turn OpenAI Responses sessions', async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_1',
        status: 'completed',
        output_text: 'Round 1 complete',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Round 1 complete',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        })
      )
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_2',
        status: 'completed',
        output_text: 'Round 2 complete',
        output: [
          {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Round 2 complete',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 6,
          output_tokens: 3,
          total_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        })
      );

    async function* promptStream() {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: 'First validation turn',
        },
        parent_tool_use_id: null,
        session_id: '',
      };
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: 'Second validation turn',
        },
        parent_tool_use_id: null,
        session_id: 'existing-session',
      };
    }

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const execution = runtime.execute({
      prompt: promptStream(),
      cwd: 'C:\\repo',
      maxTurns: 6,
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        input: 'First validation turn',
        stream: true,
      }),
      expect.any(Object)
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        stream: true,
        previous_response_id: 'resp_1',
        input: 'Second validation turn',
      }),
      expect.any(Object)
    );

    expect(events).toEqual([
      {
        type: 'assistant.text',
        text: 'Round 1 complete',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Round 1 complete',
        usage: {
          inputTokens: 5,
          outputTokens: 2,
        },
      },
      {
        type: 'assistant.text',
        text: 'Round 2 complete',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Round 2 complete',
        usage: {
          inputTokens: 6,
          outputTokens: 3,
        },
      },
    ]);
  });

  it('normalizes OpenAI tool schemas for strict mode and converts null tool args to undefined', async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_schema_1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'report_issue',
            call_id: 'call_schema_1',
            arguments: JSON.stringify({
              file: 'src/api/service.ts',
              line_start: 18,
              line_end: 21,
              title: 'Missing error handling',
              suggestion: null,
              updated_issue: {
                title: 'Updated title',
                suggestion: null,
              },
            }),
          },
        ],
        usage: {
          input_tokens: 9,
          output_tokens: 3,
        },
        })
      )
      .mockResolvedValueOnce(
        createOpenAIResponseStream({
        id: 'resp_schema_2',
        status: 'completed',
        output_text: 'Done',
        output: [
          {
            id: 'msg_schema_2',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Done',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 4,
        },
        })
      );

    const executeTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'Issue recorded' }],
    });

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 6,
      tools: [
        {
          name: 'report_issue',
          description: 'Capture an issue',
          inputSchema: {
            file: z.string(),
            line_start: z.number(),
            line_end: z.number(),
            title: z.string(),
            suggestion: z.string().optional(),
            updated_issue: z
              .object({
                title: z.string(),
                suggestion: z.string().optional(),
              })
              .optional(),
          },
          execute: executeTool,
        },
      ],
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    const firstCall = createMock.mock.calls[0]?.[0];
    const toolParameters = firstCall?.tools?.[0]?.parameters as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, any>;
    };

    expect(toolParameters.additionalProperties).toBe(false);
    expect(toolParameters.required).toEqual(
      expect.arrayContaining([
        'file',
        'line_start',
        'line_end',
        'title',
        'suggestion',
        'updated_issue',
      ])
    );
    expect(toolParameters.properties?.suggestion?.type).toEqual(['string', 'null']);
    expect(toolParameters.properties?.updated_issue?.type).toEqual(['object', 'null']);
    expect(toolParameters.properties?.updated_issue?.additionalProperties).toBe(false);
    expect(toolParameters.properties?.updated_issue?.required).toEqual(
      expect.arrayContaining(['title', 'suggestion'])
    );
    expect(toolParameters.properties?.updated_issue?.properties?.suggestion?.type).toEqual([
      'string',
      'null',
    ]);

    expect(executeTool).toHaveBeenCalledWith({
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      title: 'Missing error handling',
      suggestion: undefined,
      updated_issue: {
        title: 'Updated title',
        suggestion: undefined,
      },
    });

    expect(events).toEqual([
      {
        type: 'activity',
        event: 'function_call:report_issue',
      },
      {
        type: 'assistant.text',
        text: 'Done',
      },
      {
        type: 'result',
        status: 'success',
        text: 'Done',
        usage: {
          inputTokens: 11,
          outputTokens: 4,
        },
      },
    ]);
  });

  it('generates plain text through the OpenAI Responses runtime abstraction', async () => {
    const createMock = vi.fn().mockResolvedValue(
      createOpenAIResponseStream({
        id: 'resp_text_1',
        status: 'completed',
        output_text: 'runtime text output',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'runtime text output',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
        },
      })
    );

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const result = await runtime.generateText({
      model: 'gpt-5-mini',
      prompt: 'Return JSON only',
    });

    expect(createMock).toHaveBeenCalledWith({
      model: 'gpt-5-mini',
      input: 'Return JSON only',
      stream: true,
    });
    expect(result).toEqual({
      text: 'runtime text output',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
      },
    });
  });

  it('reports completed OpenAI stream turns with no text or tool calls as an error', async () => {
    const createMock = vi.fn().mockResolvedValue(
      createOpenAIResponseStream({
        id: 'resp_empty_1',
        status: 'completed',
        output_text: '',
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
        },
      })
    );

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 6,
    });

    const events = [];
    for await (const event of execution) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'result',
        status: 'error_empty_output',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
        },
        error: 'OpenAI Responses stream completed without text or tool calls',
      },
    ]);
  });

  it('does not abort an externally managed AbortController when execution is closed', async () => {
    const createMock = vi.fn();

    const runtime = new OpenAIResponsesRuntime(
      {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      {
        responses: {
          create: createMock,
        },
      } as any
    );

    const externalAbortController = new AbortController();
    const execution = runtime.execute({
      prompt: 'Review this diff',
      cwd: 'C:\\repo',
      maxTurns: 6,
      abortController: externalAbortController,
    });

    await execution.close();

    expect(externalAbortController.signal.aborted).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });
});
