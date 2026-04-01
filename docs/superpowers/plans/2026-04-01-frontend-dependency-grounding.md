# Frontend Dependency Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground frontend review and validation prompts with dependency versions from the current repo snapshot so reviewers avoid suggesting APIs that require newer package versions than the project actually uses.

**Architecture:** Add a small dependency-context extractor inside `code-argus` that inspects the active review worktree, finds the nearest frontend package roots for changed files, and resolves a compact dependency version snapshot from `package.json` plus `package-lock.json` or `pnpm-lock.yaml`. Inject the resulting summary into reviewer and validator prompts instead of relying on runtime file-reading tools, so Claude and OpenAI runtimes behave consistently.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem APIs, existing `yaml` dependency for pnpm lock parsing

---

### Task 1: Define dependency grounding module and fixture coverage

**Files:**

- Create: `src/review/dependency-context/types.ts`
- Create: `src/review/dependency-context/extractor.ts`
- Create: `tests/review/dependency-context.test.ts`

- [ ] **Step 1: Write failing tests for dependency context extraction**

Cover at least:

- nearest `package.json` resolution for nested frontend files
- npm `package-lock.json` resolved version extraction
- pnpm `pnpm-lock.yaml` resolved version extraction
- fallback to declared version when exact lock version is unavailable
- non-frontend or ungrounded diffs returning no dependency context

- [ ] **Step 2: Run the new dependency-context tests and verify they fail**

Run: `npm run test:run -- tests/review/dependency-context.test.ts`
Expected: FAIL because extractor module and behavior do not exist yet

- [ ] **Step 3: Implement minimal dependency context extractor**

Implement:

- frontend file/package-root detection from changed file paths
- import-specifier collection from diff hunks when available
- compact package snapshot model with declared and resolved versions
- npm and pnpm lock readers with safe fallbacks

- [ ] **Step 4: Re-run dependency-context tests and verify they pass**

Run: `npm run test:run -- tests/review/dependency-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/dependency-context tests/review/dependency-context.test.ts
git commit -m "feat: extract frontend dependency grounding context"
```

### Task 2: Inject dependency grounding into reviewer prompts

**Files:**

- Modify: `src/review/prompts/streaming.ts`
- Modify: `src/review/streaming-orchestrator.ts`
- Modify: `tests/review/streaming-prompts.test.ts`
- Modify: `tests/review/streaming-orchestrator-runtime.test.ts`

- [ ] **Step 1: Write failing tests for reviewer prompt injection**

Add tests that prove:

- `buildStreamingUserPrompt(...)` renders a dependency section when provided
- runtime bridge passes dependency grounding into the reviewer prompt for frontend changes
- prompt guidance explicitly forbids suggesting newer-version APIs without stating an upgrade requirement

- [ ] **Step 2: Run the focused reviewer prompt tests and verify they fail**

Run: `npm run test:run -- tests/review/streaming-prompts.test.ts tests/review/streaming-orchestrator-runtime.test.ts`
Expected: FAIL because dependency grounding is not yet present in prompt assembly

- [ ] **Step 3: Implement minimal reviewer prompt injection**

Wire the extractor result into review context and add a concise `Frontend Dependency Versions` section only when data exists.

- [ ] **Step 4: Re-run focused reviewer prompt tests and verify they pass**

Run: `npm run test:run -- tests/review/streaming-prompts.test.ts tests/review/streaming-orchestrator-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/prompts/streaming.ts src/review/streaming-orchestrator.ts tests/review/streaming-prompts.test.ts tests/review/streaming-orchestrator-runtime.test.ts
git commit -m "feat: ground frontend reviewer prompts with dependency versions"
```

### Task 3: Inject dependency grounding into validator prompts

**Files:**

- Modify: `src/review/streaming-validator.ts`
- Modify: `tests/review/streaming-validator-runtime.test.ts`

- [ ] **Step 1: Write failing tests for validator grounding**

Add tests that prove:

- validator prompt stream includes dependency grounding for frontend issues when context exists
- validator prompt text explicitly rejects version-sensitive API guidance that exceeds grounded versions unless an upgrade is stated

- [ ] **Step 2: Run focused validator tests and verify they fail**

Run: `npm run test:run -- tests/review/streaming-validator-runtime.test.ts`
Expected: FAIL because validator prompts do not yet include dependency grounding

- [ ] **Step 3: Implement minimal validator grounding injection**

Pass the precomputed dependency context into validator sessions and include only the relevant package-root slice for the issue being validated.

- [ ] **Step 4: Re-run focused validator tests and verify they pass**

Run: `npm run test:run -- tests/review/streaming-validator-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/streaming-validator.ts tests/review/streaming-validator-runtime.test.ts
git commit -m "feat: ground frontend validator prompts with dependency versions"
```

### Task 4: Run focused regression suite

**Files:**

- Verify only

- [ ] **Step 1: Run the dependency grounding and prompt-focused suite**

Run: `npm run test:run -- tests/review/dependency-context.test.ts tests/review/streaming-prompts.test.ts tests/review/streaming-orchestrator-runtime.test.ts tests/review/streaming-validator-runtime.test.ts`
Expected: PASS

- [ ] **Step 2: Run a broader safety regression suite**

Run: `npm run test:run -- tests/runtime/execution.test.ts tests/review/validation-prompts.test.ts tests/review/agent-selector.test.ts`
Expected: PASS

- [ ] **Step 3: Commit final verification-only changes if needed**

```bash
git status --short
```
