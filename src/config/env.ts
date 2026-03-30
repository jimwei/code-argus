/**
 * Environment configuration for Argus runtimes.
 *
 * The current implementation supports two runtime families:
 * - claude-agent
 * - openai-responses
 *
 * Claude remains the default runtime for backwards compatibility.
 */

import { DEFAULT_AGENT_MODEL, DEFAULT_LIGHT_MODEL } from '../review/constants.js';
import { loadConfig } from './store.js';

export type ArgusRuntimeType = 'claude-agent' | 'openai-responses';
export type ArgusRuntimeModelKind = 'main' | 'light' | 'validator';

export interface ClaudeAuthConfig {
  apiKey: string;
  baseUrl?: string;
  source: 'argus' | 'claude-oauth' | 'anthropic-api' | 'config';
}

export interface OpenAIAuthConfig {
  apiKey: string;
  baseUrl?: string;
  source: 'argus' | 'openai-api';
}

export interface ArgusRuntimeConfig {
  runtime: ArgusRuntimeType;
  models: {
    main: string;
    light: string;
    validator: string;
  };
  claude?: ClaudeAuthConfig;
  openai?: OpenAIAuthConfig;
}

/**
 * Backwards-compatible alias kept for existing Anthropic-facing callers.
 */
export type AuthConfig = ClaudeAuthConfig;

function getRuntime(): ArgusRuntimeType {
  const runtime = process.env.ARGUS_RUNTIME?.trim() || 'claude-agent';
  if (runtime === 'claude-agent' || runtime === 'openai-responses') {
    return runtime;
  }

  throw new Error(`Unsupported ARGUS_RUNTIME: ${runtime}`);
}

function getClaudeAuthConfig(): ClaudeAuthConfig {
  const config = loadConfig();

  const argusApiKey = process.env.ARGUS_ANTHROPIC_API_KEY;
  if (argusApiKey) {
    return {
      apiKey: argusApiKey,
      baseUrl: process.env.ARGUS_ANTHROPIC_BASE_URL,
      source: 'argus',
    };
  }

  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicBaseUrl && anthropicAuthToken) {
    return {
      apiKey: anthropicAuthToken,
      baseUrl: anthropicBaseUrl,
      source: 'claude-oauth',
    };
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicApiKey) {
    return {
      apiKey: anthropicApiKey,
      baseUrl: process.env.ARGUS_ANTHROPIC_BASE_URL,
      source: 'anthropic-api',
    };
  }

  if (config.apiKey) {
    return {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      source: 'config',
    };
  }

  throw new Error(
    `No Claude credentials configured. Please set one of the following:
  1. ARGUS_ANTHROPIC_API_KEY
  2. ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
  3. ANTHROPIC_API_KEY
  4. Run 'argus config set apiKey <your-key>' to save to config file`
  );
}

function getOpenAIAuthConfig(): OpenAIAuthConfig {
  const argusApiKey = process.env.ARGUS_OPENAI_API_KEY;
  if (argusApiKey) {
    return {
      apiKey: argusApiKey,
      baseUrl: process.env.ARGUS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
      source: 'argus',
    };
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (openaiApiKey) {
    return {
      apiKey: openaiApiKey,
      baseUrl: process.env.ARGUS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
      source: 'openai-api',
    };
  }

  throw new Error(
    `No OpenAI credentials configured. Please set one of the following:
  1. ARGUS_OPENAI_API_KEY
  2. OPENAI_API_KEY`
  );
}

function getMainModel(runtime: ArgusRuntimeType): string {
  const config = loadConfig();

  return (
    process.env.ARGUS_MODEL ||
    (runtime === 'claude-agent'
      ? process.env.ARGUS_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || config.model
      : config.model) ||
    DEFAULT_AGENT_MODEL
  );
}

export function loadArgusRuntimeConfig(): ArgusRuntimeConfig {
  const runtime = getRuntime();
  const mainModel = getMainModel(runtime);
  const lightModel = process.env.ARGUS_LIGHT_MODEL || mainModel || DEFAULT_LIGHT_MODEL;
  const validatorModel = process.env.ARGUS_VALIDATOR_MODEL || mainModel;

  if (runtime === 'claude-agent') {
    return {
      runtime,
      models: {
        main: mainModel,
        light: lightModel,
        validator: validatorModel,
      },
      claude: getClaudeAuthConfig(),
    };
  }

  return {
    runtime,
    models: {
      main: mainModel,
      light: lightModel,
      validator: validatorModel,
    },
    openai: getOpenAIAuthConfig(),
  };
}

export function initializeProviderEnv(): void {
  try {
    const config = loadArgusRuntimeConfig();

    if (config.runtime === 'claude-agent' && config.claude) {
      process.env.ANTHROPIC_API_KEY = config.claude.apiKey;
      if (config.claude.baseUrl) {
        process.env.ANTHROPIC_BASE_URL = config.claude.baseUrl;
      }
      process.env.ANTHROPIC_MODEL = config.models.main;

      if (config.claude.source === 'argus') {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
      return;
    }

    if (config.runtime === 'openai-responses' && config.openai) {
      process.env.OPENAI_API_KEY = config.openai.apiKey;
      if (config.openai.baseUrl) {
        process.env.OPENAI_BASE_URL = config.openai.baseUrl;
      }
    }
  } catch {
    // Defer validation errors until credentials are actually required.
  }
}

/**
 * Backwards-compatible initializer retained for existing startup code.
 */
export function initializeEnv(): void {
  initializeProviderEnv();
}

export function getAuthConfig(): AuthConfig {
  const config = loadArgusRuntimeConfig();
  if (!config.claude) {
    throw new Error('Claude authentication is unavailable for the active runtime');
  }
  return config.claude;
}

export function getApiKey(): string {
  return getAuthConfig().apiKey;
}

export function getBaseUrl(): string | undefined {
  return getAuthConfig().baseUrl;
}

export function getRuntimeModel(kind: ArgusRuntimeModelKind): string {
  return loadArgusRuntimeConfig().models[kind];
}

export function getModel(): string | undefined {
  return getRuntimeModel('main');
}
