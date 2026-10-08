import { loadArgusRuntimeConfig, type ArgusRuntimeConfig } from '../config/env.js';
import { ClaudeAgentRuntime } from './claude-agent.js';
import { OpenAIResponsesRuntime } from './openai-responses.js';
import { OpenAIResponsesSdkRuntime } from './openai-responses-sdk.js';
import type { AgentRuntime } from './types.js';

export interface RuntimeFactory {
  create(config: ArgusRuntimeConfig): AgentRuntime;
}

export function createRuntimeFactory(): RuntimeFactory {
  return {
    create(config: ArgusRuntimeConfig): AgentRuntime {
      if (config.runtime === 'claude-agent') {
        return new ClaudeAgentRuntime(config);
      }

      /**
       * 两套实现共享同一个 `AgentRuntime` 契约与同一组事件状态
       * （success / incomplete / error / error_empty_output / error_max_turns），
       * 所以编排层无需感知差异。缺省走 pi-ai，显式声明 `sdk` 时回到自维护实现。
       */
      if (config.openai?.responseImpl === 'sdk') {
        return new OpenAIResponsesSdkRuntime(config);
      }

      return new OpenAIResponsesRuntime(config);
    },
  };
}

export function createRuntimeFromEnv(
  factory: RuntimeFactory = createRuntimeFactory()
): AgentRuntime {
  return factory.create(loadArgusRuntimeConfig());
}
