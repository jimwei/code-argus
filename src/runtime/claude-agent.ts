import Anthropic from '@anthropic-ai/sdk';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';

import type { ArgusRuntimeConfig } from '../config/env.js';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeExecuteOptions,
  RuntimeExecution,
  RuntimeGenerateTextOptions,
  RuntimeGenerateTextResult,
  RuntimeResultEvent,
  RuntimeToolDefinition,
} from './types.js';

type ClaudeQueryPrompt = Parameters<typeof query>[0]['prompt'];
type ClaudePromptMessage = {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
  parent_tool_use_id: null;
  session_id: string;
};

function createToolServer(namespace: string, tools: RuntimeToolDefinition[]) {
  return createSdkMcpServer({
    name: namespace,
    version: '1.0.0',
    tools: tools.map((runtimeTool) =>
      tool(runtimeTool.name, runtimeTool.description, runtimeTool.inputSchema, (args) =>
        runtimeTool.execute(args)
      )
    ),
  });
}

function normalizeAssistantMessage(message: SDKAssistantMessage): RuntimeEvent[] {
  return message.message.content.flatMap((block) =>
    block.type === 'text'
      ? [
          {
            type: 'assistant.text' as const,
            text: block.text,
          },
        ]
      : []
  );
}

function normalizeResultMessage(message: SDKResultMessage): RuntimeResultEvent {
  const usage = message.usage
    ? {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      }
    : undefined;
  const error = 'error' in message && typeof message.error === 'string' ? message.error : undefined;
  const text =
    'result' in message && typeof message.result === 'string' ? message.result : undefined;

  return {
    type: 'result',
    status: message.subtype,
    text,
    usage,
    error,
  };
}

function normalizeClaudeMessage(message: unknown): RuntimeEvent[] {
  const runtimeMessage = message as {
    type?: string;
    subtype?: string;
  };

  if (runtimeMessage.type === 'assistant') {
    return normalizeAssistantMessage(message as SDKAssistantMessage);
  }

  if (runtimeMessage.type === 'result') {
    return [normalizeResultMessage(message as SDKResultMessage)];
  }

  if (runtimeMessage.type === 'stream_event' || runtimeMessage.type === 'tool_progress') {
    return [
      {
        type: 'activity',
        event: runtimeMessage.subtype || runtimeMessage.type,
      },
    ];
  }

  return [];
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

  throw new Error('Claude runtime requires prompt items to resolve to text content');
}

function createClaudePrompt(
  prompt: RuntimeExecuteOptions['prompt'],
  sessionRef: { id: string }
): ClaudeQueryPrompt {
  if (!isAsyncIterablePrompt(prompt)) {
    return prompt as ClaudeQueryPrompt;
  }

  return (async function* (): AsyncGenerator<ClaudePromptMessage> {
    for await (const promptItem of prompt) {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: getPromptText(promptItem),
        },
        parent_tool_use_id: null,
        session_id: sessionRef.id,
      };
    }
  })() as ClaudeQueryPrompt;
}

function extractClaudeText(response: { content: unknown[] }): string {
  return response.content
    .flatMap((block) => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return [block.text];
      }

      return [];
    })
    .join('');
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly kind = 'claude-agent';
  readonly textClient: Anthropic;

  constructor(
    readonly config: ArgusRuntimeConfig,
    textClient?: Anthropic
  ) {
    if (!config.claude) {
      throw new Error('Claude runtime requires claude credentials in the runtime config');
    }

    this.textClient =
      textClient ||
      new Anthropic({
        apiKey: config.claude.apiKey,
        ...(config.claude.baseUrl ? { baseURL: config.claude.baseUrl } : {}),
      });
  }

  async generateText(options: RuntimeGenerateTextOptions): Promise<RuntimeGenerateTextResult> {
    const request = {
      model: options.model || this.config.models.main,
      max_tokens: options.maxOutputTokens ?? 1024,
      messages: [
        {
          role: 'user' as const,
          content: options.prompt,
        },
      ],
    };
    const response = options.abortController
      ? await this.textClient.messages.create(request, {
          signal: options.abortController.signal,
        })
      : await this.textClient.messages.create(request);

    return {
      text: extractClaudeText(response as { content: unknown[] }),
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
    };
  }

  execute(options: RuntimeExecuteOptions): RuntimeExecution {
    const toolNamespace = options.toolNamespace || 'argus-runtime-tools';
    const toolServer =
      options.tools && options.tools.length > 0
        ? createToolServer(toolNamespace, options.tools)
        : undefined;
    const sessionRef = { id: '' };
    const queryStream = query({
      prompt: createClaudePrompt(options.prompt, sessionRef),
      options: {
        cwd: options.cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: options.maxTurns,
        model: options.model || this.config.models.main,
        ...(options.settingSources
          ? { settingSources: options.settingSources as SettingSource[] }
          : {}),
        ...(toolServer ? { mcpServers: { [toolNamespace]: toolServer } } : {}),
        ...(options.abortController ? { abortController: options.abortController } : {}),
      },
    });

    let closed = false;

    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of queryStream) {
          if (
            message &&
            typeof message === 'object' &&
            'session_id' in message &&
            typeof message.session_id === 'string'
          ) {
            sessionRef.id = message.session_id;
          }

          for (const event of normalizeClaudeMessage(message)) {
            yield event;
          }
        }
      },
      async close() {
        if (closed) {
          return;
        }

        closed = true;
        await queryStream.return?.(undefined);
      },
    };
  }
}
