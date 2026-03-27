# Review Agent Runtime Design

## Summary

`code-argus` now runs review workflows through a provider-neutral runtime abstraction. The review layer no longer calls provider SDKs directly. Claude and OpenAI integrations are isolated under `src/runtime/*`.

Supported runtimes:

- `claude-agent`
- `openai-responses`

Runtime selection is global and env-only through `ARGUS_RUNTIME`.

## Goals

- Support both Claude and OpenAI without forking the review pipeline
- Keep the existing Claude path working
- Add OpenAI via the official SDK and the Responses API
- Make provider switching operationally simple
- Keep provider-specific complexity out of `src/review/*`

## Non-goals

- Per-command runtime switching
- Provider selection stored in the local config file
- Multiple providers active in the same review run

## Layered Architecture

```text
CLI / config / env
        |
        v
runtime factory
        |
        +--> ClaudeAgentRuntime
        |
        +--> OpenAIResponsesRuntime
                |
                v
review pipeline
  - streaming orchestrator
  - streaming validator
  - fix verifier
  - custom agent executor
  - agent selector
  - matcher
  - realtime deduplicator
```

## Runtime Contract

The runtime boundary exposes two capabilities:

### `execute()`

Used for agent-like multi-turn execution.

Responsibilities:

- accept prompt input
- run the provider loop
- expose normalized runtime events
- bridge tool calls
- stop cleanly through `close()`

### `generateText()`

Used for lightweight single-turn judgments.

Current consumers:

- agent selector
- custom-agent matcher
- realtime deduplicator

## Event Model

Runtime events are normalized to a common shape:

- `assistant.text`
- `activity`
- `result`

This keeps orchestration and validation logic independent from provider-specific streaming formats.

## Provider Implementations

### Claude runtime

File:

- `src/runtime/claude-agent.ts`

Implementation notes:

- uses `@anthropic-ai/claude-agent-sdk` for multi-turn execution
- uses `@anthropic-ai/sdk` for lightweight single-turn text generation
- preserves Claude tool execution semantics through the runtime bridge

### OpenAI runtime

File:

- `src/runtime/openai-responses.ts`

Implementation notes:

- uses the official `openai` SDK
- uses the Responses API for both single-turn text generation and tool-capable execution
- resolves tool calls in a runtime-managed loop until completion or `maxTurns` exhaustion

## Tool Bridge

The review pipeline defines tools in a provider-neutral way and passes them into the runtime. Each runtime is responsible for exposing those tools in the provider-specific format.

This is the key mechanism that allows:

- built-in review agents
- validator
- fix verifier
- custom agents

to stay on the same pipeline while using different providers underneath.

## Review Pipeline Integration

The following modules now consume the runtime abstraction instead of provider SDKs directly:

- `src/review/streaming-orchestrator.ts`
- `src/review/streaming-validator.ts`
- `src/review/fix-verifier.ts`
- `src/review/custom-agents/executor.ts`
- `src/review/agent-selector.ts`
- `src/review/custom-agents/matcher.ts`
- `src/review/realtime-deduplicator.ts`

Provider-specific code should remain confined to:

- `src/runtime/claude-agent.ts`
- `src/runtime/openai-responses.ts`

## Config and Operational Contract

Runtime and credential rules:

- `ARGUS_RUNTIME` is env-only
- OpenAI credentials are env-only
- Claude credentials can come from env or the existing Argus config fallback
- the local config file still stores Claude-compatible `api-key` and `base-url`
- `model` remains a shared fallback field

Recommended operational contract:

- set `ARGUS_RUNTIME` explicitly in every automation environment
- set `ARGUS_MODEL` explicitly when `ARGUS_RUNTIME=openai-responses`
- do not rely on config-file provider switching

## Testing Strategy

Coverage in this branch focuses on:

- runtime config loading
- runtime factory selection
- execution event normalization
- runtime bridges for orchestrator, validator, fix verifier, selector, matcher, and deduplicator

Still required outside unit tests:

- manual Claude end-to-end smoke test
- manual OpenAI end-to-end smoke test

## Remaining Risks

- OpenAI end-to-end behavior still requires verification with real credentials
- provider defaults should be kept explicit to avoid model/runtime mismatch
- documentation must continue to treat `src/runtime/*` as the provider boundary
