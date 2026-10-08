import { describe, expect, it } from 'vitest';

import { createRuntimeFactory } from '../../src/runtime/factory.js';
import type { ArgusRuntimeConfig } from '../../src/config/env.js';
import type { OpenAIResponsesRuntime } from '../../src/runtime/openai-responses.js';
import { OpenAIResponsesSdkRuntime } from '../../src/runtime/openai-responses-sdk.js';

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

  it('creates a pi-ai backed OpenAI runtime for openai-responses config', () => {
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
    // 运行时不再持有 OpenAI SDK client，而是把网关配置交给 pi-ai 的模型描述。
    const model = (runtime as OpenAIResponsesRuntime).model;
    expect(model.api).toBe('openai-responses');
    expect(model.id).toBe('gpt-5.3-codex');
    expect(model.baseUrl).toBe('https://openai-proxy.test/v1');
  });

  it('creates the SDK backed OpenAI runtime when ARGUS_OPENAI_RESPONSE_IMPL=sdk', () => {
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
        responseImpl: 'sdk',
      },
    };

    const runtime = createRuntimeFactory().create(config);

    expect(runtime).toBeInstanceOf(OpenAIResponsesSdkRuntime);
    expect(runtime.kind).toBe('openai-responses');
    expect(runtime.config).toEqual(config);
  });
});
