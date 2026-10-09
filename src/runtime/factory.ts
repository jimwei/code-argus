import {
  DEFAULT_OPENAI_RESPONSE_IMPL,
  loadArgusRuntimeConfig,
  type ArgusRuntimeConfig,
} from '../config/env.js';
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
       * 所以编排层无需感知差异。缺省走自维护的 `sdk` 实现，显式声明 `pi-ai` 才切到 pi-ai。
       */
      if ((config.openai?.responseImpl ?? DEFAULT_OPENAI_RESPONSE_IMPL) === 'sdk') {
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
