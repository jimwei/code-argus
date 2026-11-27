import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArgusRuntimeConfig } from '../../src/config/env.js';
import { OpenAIResponsesRuntime } from '../../src/runtime/openai-responses.js';
import type { RuntimeEvent, RuntimeExecution } from '../../src/runtime/types.js';

const config: ArgusRuntimeConfig = {
  runtime: 'openai-responses',
  models: { main: 'gpt-6.2-sol', light: 'gpt-6.2-sol', validator: 'gpt-6.2-sol' },
  reasoningEffort: 'high',
  openai: { apiKey: 'test-key', baseUrl: 'https://gateway.test/v1', source: 'argus' },
};

const enabled = {
  ...config,
  openai: { ...config.openai!, promptCacheKeyEnabled: true },
};

const options = { prompt: 'Review the example', cwd: '.', maxTurns: 3 };

async function collect(execution: RuntimeExecution): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of execution) events.push(event);
  return events;
}

function sse(...events: object[]): InstanceType<typeof globalThis.Response> {
  return new globalThis.Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}

function terminal(output: object[] = []) {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_fixture',
      status: 'completed',
      output,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  };
}

function textResponse(): InstanceType<typeof globalThis.Response> {
  return sse(
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Reviewed' },
    terminal()
  );
}

function toolResponse(sequence = 1): InstanceType<typeof globalThis.Response> {
  const item = {
    type: 'function_call',
    id: `fc_${sequence}`,
    call_id: `call_${sequence}`,
    name: 'lookup_fixture',
    arguments: '{}',
  };
  return sse(
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: item.id,
      delta: '{}',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    terminal([item])
  );
}

afterEach(() => vi.restoreAllMocks());

describe('pi-ai Responses prompt cache key on the wire', () => {
  it('does not send a key by default, when disabled, or for standalone generateText', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textResponse());
    await collect(new OpenAIResponsesRuntime(config).execute(options));
    await collect(
      new OpenAIResponsesRuntime({
        ...config,
        openai: { ...config.openai!, promptCacheKeyEnabled: false },
      }).execute(options)
    );
    await new OpenAIResponsesRuntime(enabled).generateText({ prompt: 'Summarize a fixture' });

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('prompt_cache_key');
    }
  });

  it('adds only an opaque JSON key without changing request headers or other fields', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textResponse());
    await collect(new OpenAIResponsesRuntime(config).execute(options));
    await collect(new OpenAIResponsesRuntime(enabled).execute(options));

    expect(fetch).toHaveBeenCalledTimes(2);
    const [, base] = fetch.mock.calls[0]!;
    const [, keyed] = fetch.mock.calls[1]!;
    const keyedBody = JSON.parse(String(keyed?.body));
    const { prompt_cache_key: cacheKey, ...rest } = keyedBody;
    expect(cacheKey).toMatch(/^argus-[a-f0-9-]{36}$/);
    expect(rest).toEqual(JSON.parse(String(base?.body)));
    const headers = new globalThis.Headers(keyed?.headers);
    expect(headers.get('session-id')).toBeNull();
    expect(headers.get('x-session-id')).toBeNull();
    expect(headers.get('session_id')).toBeNull();
    expect(headers.get('x-client-request-id')).toBeNull();
    expect(rest.instructions).toBe('Follow the user instructions and tool definitions exactly.');
  });

  it.each([false, true])(
    'only moves agent instructions into input when opted in (cache key = %s)',
    async (promptCacheKeyEnabled) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textResponse());
      const base = { ...config, openai: { ...config.openai!, promptCacheKeyEnabled } };
      const leading = new OpenAIResponsesRuntime({
        ...base,
        openai: { ...base.openai, agentInstructionsInInput: true },
      });
      const withBudget = {
        ...options,
        completionBudget: { reserveTurns: 1, toolNames: ['report_issue'] },
      };
      await collect(new OpenAIResponsesRuntime(base).execute(withBudget));
      await collect(leading.execute(withBudget));
      await leading.generateText({ prompt: 'Summarize a fixture' });

      expect(fetch).toHaveBeenCalledTimes(3);
      const [baseline, optedIn, standalone] = fetch.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body))
      );
      const {
        instructions,
        prompt_cache_key: baselineKey,
        input: baselineInput,
        ...rest
      } = baseline;
      const { prompt_cache_key: leadingKey, input: leadingInput, ...leadingRest } = optedIn;
      expect(instructions).toContain('Reserve the last 1 turns');
      expect(leadingInput).toEqual([
        { role: 'developer', content: instructions },
        ...baselineInput,
      ]);
      expect(leadingRest).toEqual(rest);
      if (promptCacheKeyEnabled) {
        expect(baselineKey).toMatch(/^argus-[a-f0-9-]{36}$/);
        expect(leadingKey).toMatch(/^argus-[a-f0-9-]{36}$/);
      } else {
        expect(baselineKey).toBeUndefined();
        expect(leadingKey).toBeUndefined();
      }
      const headers = new globalThis.Headers(fetch.mock.calls[1]?.[1]?.headers);
      for (const header of ['session-id', 'session_id', 'x-session-id', 'x-client-request-id']) {
        expect(headers.has(header)).toBe(false);
      }
      expect(standalone.instructions).toBe(
        'Follow the user instructions and tool definitions exactly.'
      );
      expect(standalone.input[0].role).toBe('user');
      expect(standalone).not.toHaveProperty('prompt_cache_key');
    }
  );

  it.each([
    { label: 'developer role is disabled', reasoningEffort: 'high', supportsDeveloperRole: false },
    { label: 'reasoning effort is unset', reasoningEffort: undefined, supportsDeveloperRole: true },
  ])(
    'preserves the system role when $label',
    async ({ reasoningEffort, supportsDeveloperRole }) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textResponse());
      await collect(
        new OpenAIResponsesRuntime({
          ...config,
          reasoningEffort,
          openai: { ...config.openai!, agentInstructionsInInput: true, supportsDeveloperRole },
        }).execute(options)
      );
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body).not.toHaveProperty('instructions');
      expect(body.input[0]).toEqual({
        role: 'system',
        content: 'Follow the user instructions and tool definitions exactly.',
      });
      if (!reasoningEffort) expect(body).not.toHaveProperty('reasoning');
    }
  );

  it('reuses the key through a tool round and provider retry, but never across executions', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => toolResponse())
      .mockImplementationOnce(
        async () =>
          new globalThis.Response(JSON.stringify({ error: { message: 'Try again' } }), {
            status: 503,
            headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
          })
      )
      .mockImplementation(async () => textResponse());
    const read = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'fixture value' }],
    }));
    const runtime = new OpenAIResponsesRuntime({
      ...enabled,
      openai: { ...enabled.openai, agentInstructionsInInput: true },
    });
    const events = await collect(
      runtime.execute({
        ...options,
        tools: [
          {
            name: 'lookup_fixture',
            description: 'Look up fixture',
            inputSchema: {},
            execute: read,
          },
        ],
      })
    );
    await Promise.all([collect(runtime.execute(options)), collect(runtime.execute(options))]);

    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'success' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(5);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const keys = bodies.map((body) => body.prompt_cache_key);
    for (const key of keys) expect(key).toMatch(/^argus-[a-f0-9-]{36}$/);
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(new Set(keys).size).toBe(3);
    for (const body of bodies) {
      expect(body).not.toHaveProperty('instructions');
      expect(body.input[0]).toEqual({
        role: 'developer',
        content: 'Follow the user instructions and tool definitions exactly.',
      });
      expect(body.input[1].role).toBe('user');
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty('previous_response_id');
    }
    expect(bodies[1].input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'function_call_output' })])
    );
    expect(bodies[2]).toEqual(bodies[1]);
  });

  it('keeps the key after transcript compaction and across validator-style streamed prompts', async () => {
    const largeToolResult = 'z'.repeat(16000);
    const read = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: largeToolResult }] });
    let requests = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      requests++;
      return requests <= 7 ? toolResponse(requests) : textResponse();
    });
    async function* prompts() {
      yield 'Review the fixture';
      yield 'Challenge that verdict';
    }
    const runtime = new OpenAIResponsesRuntime({
      ...enabled,
      openai: { ...enabled.openai, transcriptBudgetTokens: 3000 },
    });
    const events = await collect(
      runtime.execute({
        ...options,
        prompt: prompts(),
        maxTurns: 10,
        tools: [
          {
            name: 'lookup_fixture',
            description: 'Look up fixture',
            inputSchema: {},
            execute: read,
          },
        ],
      })
    );

    expect(events.filter((event) => event.type === 'result').map((event) => event.status)).toEqual([
      'success',
      'success',
    ]);
    expect(fetch).toHaveBeenCalledTimes(9);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const cacheKey = bodies[0].prompt_cache_key;
    expect(cacheKey).toMatch(/^argus-[a-f0-9-]{36}$/);
    expect(bodies.map((body) => body.prompt_cache_key)).toEqual(Array(9).fill(cacheKey));
    expect(JSON.stringify(bodies[1].input)).toContain(largeToolResult);
    expect(JSON.stringify(bodies[7].input)).not.toContain(largeToolResult);
    expect(JSON.stringify(bodies[7].input)).toContain('removedChars=16000');
    expect(JSON.stringify(bodies[8].input)).toContain('Challenge that verdict');
  });
});
