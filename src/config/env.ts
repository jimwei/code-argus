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
/**
 * `openai-responses` 运行时的协议栈实现：
 * - `sdk`（缺省）：改造前自维护的 OpenAI SDK 实现
 * - `pi-ai`：委托给 @earendil-works/pi-ai（需要显式开启）
 */
export type OpenAIResponsesImpl = 'pi-ai' | 'sdk';

export const DEFAULT_OPENAI_RESPONSE_IMPL: OpenAIResponsesImpl = 'sdk';

/**
 * pi-ai 路径的会话 transcript 预算（估算 token）。超过预算时最旧的工具输出
 * 会被折叠成占位文本，避免长会话把每次请求越滚越大；`0` 表示禁用。
 */
export const DEFAULT_TRANSCRIPT_BUDGET_TOKENS = 160_000;

/** pi-ai 词汇表里的推理档位；用于给验证阶段做降档。 */
const REASONING_EFFORT_RANKS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 两套实现都认识的推理档位（外加显式关闭推理的 `none`）。 */
const REASONING_EFFORT_VALUES = new Set<string>(['none', ...REASONING_EFFORT_RANKS]);

export interface ClaudeAuthConfig {
  apiKey: string;
  baseUrl?: string;
  source: 'argus' | 'claude-oauth' | 'anthropic-api' | 'config';
}

export interface OpenAIAuthConfig {
  apiKey: string;
  baseUrl?: string;
  source: 'argus' | 'openai-api';
  /**
   * 仅决定 pi-ai 构造首条指令时使用的角色（developer / system）；运行时随后会把
   * 该指令搬到顶层 `instructions` 字段，因此该开关不再改变出站请求，标记为废弃。
   * 读自 ARGUS_OPENAI_SUPPORTS_DEVELOPER_ROLE，未设置时按 true 处理。
   */
  supportsDeveloperRole?: boolean;
  /**
   * 选用哪套 Responses 协议栈实现，读自 ARGUS_OPENAI_RESPONSE_IMPL，
   * 缺省 `sdk`。仅对 `openai-responses` 运行时生效。
   */
  responseImpl?: OpenAIResponsesImpl;
  /**
   * pi-ai 路径的 transcript 预算，读自 ARGUS_TRANSCRIPT_BUDGET_TOKENS，
   * 缺省 160000；`0` 表示禁用（字段缺省）。
   */
  transcriptBudgetTokens?: number;
}

/**
 * 解析布尔型环境变量。取值不合法时回退到默认值，避免拼写错误静默改变行为。
 */
function resolveBooleanEnv(raw: string | undefined, fallback: boolean, name: string): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  console.warn(`[ArgusRuntimeConfig] Unsupported ${name} "${value}", falling back to ${fallback}`);
  return fallback;
}

/**
 * 解析 `ARGUS_OPENAI_RESPONSE_IMPL`。取值不合法时回退到默认实现并告警，
 * 避免拼写错误让部署静默切走实现。
 */
function resolveOpenAIResponsesImpl(raw: string | undefined): OpenAIResponsesImpl {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return DEFAULT_OPENAI_RESPONSE_IMPL;
  }

  if (value === 'pi-ai' || value === 'sdk') {
    return value;
  }

  console.warn(
    `[ArgusRuntimeConfig] Unsupported ARGUS_OPENAI_RESPONSE_IMPL "${value}", falling back to ${DEFAULT_OPENAI_RESPONSE_IMPL}`
  );
  return DEFAULT_OPENAI_RESPONSE_IMPL;
}

/**
 * 解析 `ARGUS_TRANSCRIPT_BUDGET_TOKENS`：正整数为预算，`0`/负数表示禁用，
 * 非法值回退默认并告警。
 */
function resolveTranscriptBudgetTokens(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_TRANSCRIPT_BUDGET_TOKENS;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || `${parsed}` !== value) {
    console.warn(
      `[ArgusRuntimeConfig] Unsupported ARGUS_TRANSCRIPT_BUDGET_TOKENS "${value}", falling back to ${DEFAULT_TRANSCRIPT_BUDGET_TOKENS}`
    );
    return DEFAULT_TRANSCRIPT_BUDGET_TOKENS;
  }

  return parsed > 0 ? parsed : undefined;
}

/**
 * 验证阶段的推理强度：主流程档位高于 medium 时默认降到 medium，
 * 其余情况沿用主流程档位；`ARGUS_VALIDATOR_REASONING_EFFORT` 可显式覆盖。
 */
function resolveValidatorReasoningEffort(mainEffort: string | undefined): string | undefined {
  const rawOverride = process.env.ARGUS_VALIDATOR_REASONING_EFFORT?.trim();
  if (rawOverride) {
    const override = rawOverride.toLowerCase();
    if (REASONING_EFFORT_VALUES.has(override)) {
      return override;
    }

    // 拼写错误或不在词表里的取值会一路透传给上游并让每个验证请求失败，
    // 这里回退到默认降档策略（与 ARGUS_REASONING_EFFORT 的容错方向一致）。
    console.warn(
      `[ArgusRuntimeConfig] Unsupported ARGUS_VALIDATOR_REASONING_EFFORT "${rawOverride}", ` +
        'falling back to the default validator policy'
    );
  }

  if (!mainEffort) {
    return undefined;
  }

  const rank = REASONING_EFFORT_RANKS.indexOf(
    mainEffort as (typeof REASONING_EFFORT_RANKS)[number]
  );
  if (rank === -1) {
    // 未知档位原样透传（与主流程一致，由 runtime 决定行为）。
    return mainEffort;
  }

  return rank > REASONING_EFFORT_RANKS.indexOf('medium') ? 'medium' : mainEffort;
}

export interface ArgusRuntimeConfig {
  runtime: ArgusRuntimeType;
  models: {
    main: string;
    light: string;
    validator: string;
  };
  /**
   * Single global reasoning effort forwarded to the OpenAI Responses runtime.
   * Read from ARGUS_REASONING_EFFORT; unset means "let the provider decide".
   */
  reasoningEffort?: string;
  /**
   * 验证阶段的推理强度（主流程高于 medium 时缺省降档到 medium）。
   * 读自 ARGUS_VALIDATOR_REASONING_EFFORT；主流程未配置时缺省不设置。
   */
  validatorReasoningEffort?: string;
  claude?: ClaudeAuthConfig;
  openai?: OpenAIAuthConfig;
}

/**
 * Backwards-compatible alias kept for existing Anthropic-facing callers.
 */
export type AuthConfig = ClaudeAuthConfig;

export function getArgusRuntimeType(): ArgusRuntimeType {
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
  const responseImpl = resolveOpenAIResponsesImpl(process.env.ARGUS_OPENAI_RESPONSE_IMPL);
  const supportsDeveloperRole = resolveBooleanEnv(
    process.env.ARGUS_OPENAI_SUPPORTS_DEVELOPER_ROLE,
    true,
    'ARGUS_OPENAI_SUPPORTS_DEVELOPER_ROLE'
  );
  const transcriptBudgetTokens = resolveTranscriptBudgetTokens(
    process.env.ARGUS_TRANSCRIPT_BUDGET_TOKENS
  );
  const argusApiKey = process.env.ARGUS_OPENAI_API_KEY;
  if (argusApiKey) {
    return {
      apiKey: argusApiKey,
      baseUrl: process.env.ARGUS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
      source: 'argus',
      supportsDeveloperRole,
      responseImpl,
      ...(transcriptBudgetTokens !== undefined ? { transcriptBudgetTokens } : {}),
    };
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (openaiApiKey) {
    return {
      apiKey: openaiApiKey,
      baseUrl: process.env.ARGUS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
      source: 'openai-api',
      supportsDeveloperRole,
      responseImpl,
      ...(transcriptBudgetTokens !== undefined ? { transcriptBudgetTokens } : {}),
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

  if (runtime === 'claude-agent') {
    return (
      process.env.ARGUS_MODEL ||
      process.env.ARGUS_ANTHROPIC_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      config.model ||
      DEFAULT_AGENT_MODEL
    );
  }

  return (
    process.env.ARGUS_OPENAI_MODEL || process.env.ARGUS_MODEL || config.model || DEFAULT_AGENT_MODEL
  );
}

/**
 * Single global reasoning effort for the OpenAI Responses runtime.
 * Kept as a raw string so new provider values pass through untouched.
 */
export function getReasoningEffort(): string | undefined {
  const effort = process.env.ARGUS_REASONING_EFFORT?.trim();
  return effort ? effort : undefined;
}

export function loadArgusRuntimeConfig(): ArgusRuntimeConfig {
  const runtime = getArgusRuntimeType();
  const mainModel = getMainModel(runtime);
  const lightModel = process.env.ARGUS_LIGHT_MODEL || mainModel || DEFAULT_LIGHT_MODEL;
  const validatorModel = process.env.ARGUS_VALIDATOR_MODEL || mainModel;
  const reasoningEffort = getReasoningEffort();
  const validatorReasoningEffort = resolveValidatorReasoningEffort(reasoningEffort);

  if (runtime === 'claude-agent') {
    return {
      runtime,
      models: {
        main: mainModel,
        light: lightModel,
        validator: validatorModel,
      },
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(validatorReasoningEffort ? { validatorReasoningEffort } : {}),
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
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(validatorReasoningEffort ? { validatorReasoningEffort } : {}),
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
