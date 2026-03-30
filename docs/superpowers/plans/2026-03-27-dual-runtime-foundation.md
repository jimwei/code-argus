# Dual Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first implementation slice for dual runtime support so `code-argus` can select `claude-agent` or `openai-responses` via global env, while keeping the current Claude path working and preparing for later OpenAI runtime wiring.

**Architecture:** Start with the smallest stable foundation: fix the current env-related baseline test break, refactor `src/config/env.ts` into a runtime-aware config module, add a minimal runtime abstraction layer, and wire startup/model access through the new config accessors without changing the CLI contract. Keep Claude as the only fully functional runtime in this slice; OpenAI is introduced as a validated configuration and runtime scaffold, not a completed reviewer execution path.

**Tech Stack:** TypeScript, Vitest, Node.js, Claude Agent SDK, planned OpenAI official SDK integration via Responses API, existing Argus CLI/runtime architecture

---

### Task 1: Stabilize the baseline around the env module

**Files:**

- Modify: `tests/review/realtime-deduplicator.test.ts`
- Create: `tests/config/env.test.ts`

- [ ] **Step 1: Add a focused failing test for the current env mock contract**

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  getApiKey: () => 'test-api-key',
}));

it('constructs the deduplicator with the env mock contract', async () => {
  const { RealtimeDeduplicator } = await import('../../src/review/realtime-deduplicator.js');
  expect(() => new RealtimeDeduplicator({ verbose: false })).not.toThrow();
});
```

- [ ] **Step 2: Run the focused test to verify the current failure**

Run: `npm run test:run -- tests/review/realtime-deduplicator.test.ts`
Expected: FAIL with missing `getBaseUrl` export from the mocked `src/config/env.js`

- [ ] **Step 3: Fix the env mock contract in the existing realtime deduplicator test**

```ts
vi.mock('../../src/config/env.js', () => ({
  getApiKey: () => 'test-api-key',
  getBaseUrl: () => undefined,
}));
```

- [ ] **Step 4: Re-run the focused realtime deduplicator test**

Run: `npm run test:run -- tests/review/realtime-deduplicator.test.ts`
Expected: PASS

- [ ] **Step 5: Create focused red tests for the new runtime-aware config API**

```ts
describe('loadArgusRuntimeConfig', () => {
  it('loads claude-agent runtime from ARGUS_RUNTIME with anthropic env', () => {
    // set env, assert runtime + model resolution
  });

  it('loads openai-responses runtime from ARGUS_RUNTIME with openai env', () => {
    // set env, assert runtime + model resolution
  });

  it('falls back light and validator models to ARGUS_MODEL', () => {
    // set only main model, assert fallback values
  });

  it('throws for unsupported runtime values', () => {
    // set ARGUS_RUNTIME=bad, assert throw
  });
});
```

- [ ] **Step 6: Run the new env test file to verify it fails for missing API**

Run: `npm run test:run -- tests/config/env.test.ts`
Expected: FAIL because the new runtime-aware config functions do not exist yet

- [ ] **Step 7: Commit the baseline stabilization changes**

```bash
git add tests/review/realtime-deduplicator.test.ts tests/config/env.test.ts
git commit -m "test: add runtime config baseline coverage"
```

### Task 2: Refactor env configuration into a runtime-aware config entry point

**Files:**

- Modify: `src/config/env.ts`
- Modify: `src/config/store.ts`
- Test: `tests/config/env.test.ts`

- [ ] **Step 1: Write the failing env tests for runtime-aware config behavior**

```ts
expect(loadArgusRuntimeConfig()).toEqual({
  runtime: 'claude-agent',
  models: {
    main: 'claude-opus-4-5-20251101',
    light: 'claude-opus-4-5-20251101',
    validator: 'claude-opus-4-5-20251101',
  },
  claude: {
    apiKey: 'test-key',
    source: 'argus',
  },
});
```

- [ ] **Step 2: Run the env tests to verify the expected red state**

Run: `npm run test:run -- tests/config/env.test.ts`
Expected: FAIL because `loadArgusRuntimeConfig`, `getRuntimeModel`, and `initializeProviderEnv` are not implemented

- [ ] **Step 3: Implement the runtime-aware config API in `src/config/env.ts`**

```ts
export type ArgusRuntimeType = 'claude-agent' | 'openai-responses';

export interface ArgusRuntimeConfig {
  runtime: ArgusRuntimeType;
  models: {
    main: string;
    light: string;
    validator: string;
  };
  claude?: {
    apiKey: string;
    baseUrl?: string;
    source: 'argus' | 'claude-oauth' | 'anthropic-api' | 'config';
  };
  openai?: {
    apiKey: string;
    baseUrl?: string;
    source: 'argus' | 'openai-api';
  };
}

export function loadArgusRuntimeConfig(): ArgusRuntimeConfig {
  /* ... */
}
export function getRuntimeModel(kind: 'main' | 'light' | 'validator'): string {
  /* ... */
}
export function initializeProviderEnv(): void {
  /* ... */
}
```

- [ ] **Step 4: Keep backwards-compatible helpers backed by the new config**

```ts
export function getApiKey(): string {
  /* claude only */
}
export function getBaseUrl(): string | undefined {
  /* claude only */
}
export function getModel(): string | undefined {
  /* main model */
}
export function initializeEnv(): void {
  initializeProviderEnv();
}
```

- [ ] **Step 5: Extend `src/config/store.ts` comments/types only as needed**

```ts
export interface ArgusConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}
```

Keep config-file persistence scoped to the existing Claude-compatible fields in this slice.

- [ ] **Step 6: Re-run the env tests**

Run: `npm run test:run -- tests/config/env.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the runtime-aware env refactor**

```bash
git add src/config/env.ts src/config/store.ts tests/config/env.test.ts
git commit -m "feat: add runtime-aware env configuration"
```

### Task 3: Add minimal runtime abstractions for future provider wiring

**Files:**

- Create: `src/runtime/types.ts`
- Create: `src/runtime/factory.ts`
- Create: `src/runtime/index.ts`
- Create: `tests/runtime/factory.test.ts`

- [ ] **Step 1: Write a failing test for runtime factory selection**

```ts
it('creates a Claude runtime for claude-agent config', () => {
  const runtime = createRuntimeFactory().create(claudeConfig);
  expect(runtime.kind).toBe('claude-agent');
});

it('creates an OpenAI runtime for openai-responses config', () => {
  const runtime = createRuntimeFactory().create(openaiConfig);
  expect(runtime.kind).toBe('openai-responses');
});
```

- [ ] **Step 2: Run the factory test to verify it fails**

Run: `npm run test:run -- tests/runtime/factory.test.ts`
Expected: FAIL because `src/runtime/*` does not exist yet

- [ ] **Step 3: Implement the minimal runtime interfaces and placeholder runtimes**

```ts
export interface AgentRuntime {
  kind: 'claude-agent' | 'openai-responses';
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly kind = 'claude-agent';
}

export class OpenAIResponsesRuntime implements AgentRuntime {
  readonly kind = 'openai-responses';
}
```

- [ ] **Step 4: Implement the runtime factory**

```ts
export function createRuntimeFactory() {
  return {
    create(config: ArgusRuntimeConfig): AgentRuntime {
      if (config.runtime === 'claude-agent') return new ClaudeAgentRuntime();
      return new OpenAIResponsesRuntime();
    },
  };
}
```

- [ ] **Step 5: Re-run the runtime factory tests**

Run: `npm run test:run -- tests/runtime/factory.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the runtime abstraction scaffolding**

```bash
git add src/runtime/types.ts src/runtime/factory.ts src/runtime/index.ts tests/runtime/factory.test.ts
git commit -m "feat: add runtime abstraction scaffolding"
```

### Task 4: Wire startup and model access through the new runtime-aware config

**Files:**

- Modify: `src/index.ts`
- Modify: `src/review/agent-selector.ts`
- Modify: `src/review/realtime-deduplicator.ts`
- Modify: `src/review/custom-agents/matcher.ts`
- Test: `tests/review/agent-selector.test.ts`
- Test: `tests/review/realtime-deduplicator.test.ts`

- [ ] **Step 1: Add failing tests that prove model selection comes from runtime-aware config helpers**

```ts
vi.mock('../../src/config/env.js', () => ({
  getRuntimeModel: (kind: string) => (kind === 'light' ? 'test-light-model' : 'test-main-model'),
  getApiKey: () => 'test-api-key',
  getBaseUrl: () => undefined,
}));
```

- [ ] **Step 2: Run the affected review tests to verify the red state**

Run: `npm run test:run -- tests/review/agent-selector.test.ts tests/review/realtime-deduplicator.test.ts`
Expected: FAIL because review modules still import hardcoded model constants

- [ ] **Step 3: Update startup to initialize provider env through the new config path**

```ts
import { initializeProviderEnv } from './config/env.js';

initializeProviderEnv();
```

- [ ] **Step 4: Update light-model consumers to read runtime-aware model accessors**

```ts
const model = getRuntimeModel('light');
```

Apply this to:

- `src/review/agent-selector.ts`
- `src/review/custom-agents/matcher.ts`
- `src/review/realtime-deduplicator.ts`

- [ ] **Step 5: Re-run the affected review tests**

Run: `npm run test:run -- tests/review/agent-selector.test.ts tests/review/realtime-deduplicator.test.ts`
Expected: PASS

- [ ] **Step 6: Run the focused config + runtime + review test set**

Run: `npm run test:run -- tests/config/env.test.ts tests/runtime/factory.test.ts tests/review/agent-selector.test.ts tests/review/realtime-deduplicator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the runtime-aware wiring**

```bash
git add src/index.ts src/review/agent-selector.ts src/review/custom-agents/matcher.ts src/review/realtime-deduplicator.ts
git commit -m "refactor: wire runtime-aware startup and light model access"
```

### Task 5: Verify the first slice and document remaining scope

**Files:**

- Modify: `docs/superpowers/plans/2026-03-27-dual-runtime-foundation.md`

- [x] **Step 1: Run targeted verification for the completed slice**

Run: `npm run test:run -- tests/config/env.test.ts tests/runtime/factory.test.ts tests/review/agent-selector.test.ts tests/review/realtime-deduplicator.test.ts`
Expected: PASS

- [x] **Step 2: Run static checks for the touched code**

Run: `npm run type-check`
Expected: PASS

- [x] **Step 3: Update this plan with completed checkboxes and note deferred work**

```md
- [x] Baseline env test stabilized
- [x] Runtime-aware env configuration added
- [x] Runtime abstraction scaffold added
- [x] OpenAI Responses reviewer runtime wiring completed
- [x] Tool bridge and streaming event adapter completed
- [x] Validator / fix-verifier runtime migration completed
- [x] Lightweight selector / matcher / deduplicator LLM calls now route through runtime
- [ ] Manual smoke test against real Claude and OpenAI credentials
- [ ] Broader docs cleanup outside README / CLI help / this plan
```

- [ ] **Step 4: Commit the verification and plan status update**

```bash
git add docs/superpowers/plans/2026-03-27-dual-runtime-foundation.md
git commit -m "docs: update dual runtime foundation plan status"
```

---

## Progress Update

Completed in `feature/dual-runtime-foundation`:

- [x] Runtime-aware env configuration and runtime factory scaffold landed
- [x] Added runtime execution and lightweight text-generation interfaces, normalized runtime events, and `createRuntimeFromEnv()`
- [x] Implemented Claude and OpenAI runtime adapters for both agent execution and single-turn text generation
- [x] Wired built-in agents, custom agent executor, validator, and fix verifier onto `runtime.execute()`
- [x] Routed agent selector, custom-agent matcher, and realtime deduplicator through the active runtime instead of direct Anthropic SDK calls
- [x] Constrained remaining provider-specific code to `src/runtime/claude-agent.ts` and `src/runtime/openai-responses.ts`
- [x] Added regression coverage for runtime execution plus review-module runtime bridges

Fresh verification on March 27, 2026 (PowerShell commands run in this worktree):

- [x] `$env:NODE_OPTIONS='--max-old-space-size=4096'; npm run test:run`
- [x] `$env:NODE_OPTIONS='--max-old-space-size=4096'; npm run type-check`

Deferred next steps:

- [ ] Run a manual end-to-end smoke test with real Claude credentials
- [ ] Run a manual end-to-end smoke test with real OpenAI Responses credentials
- [ ] Clean up remaining stale architecture docs that still describe the system as Claude-only

Blocked status in this session:

- [ ] Claude smoke test could not be run because `ANTHROPIC_API_KEY` and `ARGUS_ANTHROPIC_API_KEY` were unset in the local environment
- [ ] OpenAI smoke test could not be run because `OPENAI_API_KEY` and `ARGUS_OPENAI_API_KEY` were unset in the local environment
- [x] Remaining stale Claude-only docs were rewritten: `README.md`, `README.zh-CN.md`, `docs/review-agent-design.md`, `docs/review-agent-tasks.md`
- [x] PR draft notes were added at `docs/superpowers/plans/2026-03-27-dual-runtime-foundation-pr.md`

Note:

- [ ] Original commit steps above remain intentionally unchecked; no commit was created in this session
