import { describe, expect, it, vi } from 'vitest';

const { openAIConstructor } = vi.hoisted(() => ({
  openAIConstructor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(options: unknown) {
      openAIConstructor(options);
    }
  },
}));

import { createRuntimeFactory } from '../../src/runtime/factory.js';
import type { ArgusRuntimeConfig } from '../../src/config/env.js';

describe('runtime factory', () => {
  it('creates a Claude runtime for claude-agent config', () => {
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

    const runtime = createRuntimeFactory().create(config);

    expect(runtime.kind).toBe('claude-agent');
    expect(runtime.config).toEqual(config);
  });

  it('creates an OpenAI runtime for openai-responses config', () => {
    const config: ArgusRuntimeConfig = {
      runtime: 'openai-responses',
      models: {
        main: 'gpt-5.3-codex',
        light: 'gpt-5-mini',
        validator: 'gpt-5.3-codex',
      },
      openai: {
        apiKey: 'openai-key',
        baseUrl: 'https://openai-proxy.test',
        source: 'argus',
      },
    };

    const runtime = createRuntimeFactory().create(config);

    expect(runtime.kind).toBe('openai-responses');
    expect(runtime.config).toEqual(config);
    expect(openAIConstructor).toHaveBeenCalledWith({
      apiKey: 'openai-key',
      baseURL: 'https://openai-proxy.test',
    });
  });
});
