import { loadArgusRuntimeConfig, type ArgusRuntimeConfig } from '../config/env.js';
import { ClaudeAgentRuntime } from './claude-agent.js';
import { OpenAIResponsesRuntime } from './openai-responses.js';
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

      return new OpenAIResponsesRuntime(config);
    },
  };
}

export function createRuntimeFromEnv(
  factory: RuntimeFactory = createRuntimeFactory()
): AgentRuntime {
  return factory.create(loadArgusRuntimeConfig());
}
