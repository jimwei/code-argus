import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock('../../src/config/store.js', () => ({
  loadConfig: loadConfigMock,
}));

import {
  getApiKey,
  getBaseUrl,
  getModel,
  getRuntimeModel,
  initializeProviderEnv,
  loadArgusRuntimeConfig,
} from '../../src/config/env.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, ORIGINAL_ENV);
}

describe('runtime-aware env configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
    loadConfigMock.mockReturnValue({});

    delete process.env.ARGUS_RUNTIME;
    delete process.env.ARGUS_MODEL;
    delete process.env.ARGUS_LIGHT_MODEL;
    delete process.env.ARGUS_VALIDATOR_MODEL;
    delete process.env.ARGUS_ANTHROPIC_API_KEY;
    delete process.env.ARGUS_ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ARGUS_OPENAI_API_KEY;
    delete process.env.ARGUS_OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  it('loads a claude-agent runtime config from ARGUS env', () => {
    process.env.ARGUS_RUNTIME = 'claude-agent';
    process.env.ARGUS_MODEL = 'claude-main';
    process.env.ARGUS_ANTHROPIC_API_KEY = 'claude-key';
    process.env.ARGUS_ANTHROPIC_BASE_URL = 'https://anthropic-proxy.test';

    expect(loadArgusRuntimeConfig()).toEqual({
      runtime: 'claude-agent',
      models: {
        main: 'claude-main',
        light: 'claude-main',
        validator: 'claude-main',
      },
      claude: {
        apiKey: 'claude-key',
        baseUrl: 'https://anthropic-proxy.test',
        source: 'argus',
      },
    });
  });

  it('loads an openai-responses runtime config from ARGUS env', () => {
    process.env.ARGUS_RUNTIME = 'openai-responses';
    process.env.ARGUS_MODEL = 'gpt-5.3-codex';
    process.env.ARGUS_LIGHT_MODEL = 'gpt-5-mini';
    process.env.ARGUS_VALIDATOR_MODEL = 'gpt-5.3-codex';
    process.env.ARGUS_OPENAI_API_KEY = 'openai-key';
    process.env.ARGUS_OPENAI_BASE_URL = 'https://openai-proxy.test';

    expect(loadArgusRuntimeConfig()).toEqual({
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
    });
  });

  it('falls back light and validator models to the main model', () => {
    process.env.ARGUS_RUNTIME = 'openai-responses';
    process.env.ARGUS_MODEL = 'gpt-5.3-codex';
    process.env.ARGUS_OPENAI_API_KEY = 'openai-key';

    expect(getRuntimeModel('light')).toBe('gpt-5.3-codex');
    expect(getRuntimeModel('validator')).toBe('gpt-5.3-codex');
    expect(getModel()).toBe('gpt-5.3-codex');
  });

  it('initializes Anthropic provider env from the runtime config', () => {
    process.env.ARGUS_RUNTIME = 'claude-agent';
    process.env.ARGUS_MODEL = 'claude-main';
    process.env.ARGUS_ANTHROPIC_API_KEY = 'claude-key';
    process.env.ARGUS_ANTHROPIC_BASE_URL = 'https://anthropic-proxy.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token';

    initializeProviderEnv();

    expect(process.env.ANTHROPIC_API_KEY).toBe('claude-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://anthropic-proxy.test');
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-main');
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(getApiKey()).toBe('claude-key');
    expect(getBaseUrl()).toBe('https://anthropic-proxy.test');
  });

  it('initializes OpenAI provider env from the runtime config', () => {
    process.env.ARGUS_RUNTIME = 'openai-responses';
    process.env.ARGUS_MODEL = 'gpt-5.3-codex';
    process.env.ARGUS_OPENAI_API_KEY = 'openai-key';
    process.env.ARGUS_OPENAI_BASE_URL = 'https://openai-proxy.test';

    initializeProviderEnv();

    expect(process.env.OPENAI_API_KEY).toBe('openai-key');
    expect(process.env.OPENAI_BASE_URL).toBe('https://openai-proxy.test');
  });

  it('throws for unsupported runtime values', () => {
    process.env.ARGUS_RUNTIME = 'bad-runtime';
    process.env.ARGUS_MODEL = 'ignored';

    expect(() => loadArgusRuntimeConfig()).toThrow('Unsupported ARGUS_RUNTIME: bad-runtime');
  });
});
