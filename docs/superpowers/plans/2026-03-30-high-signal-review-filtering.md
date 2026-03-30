# High-Signal Review Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce low-value style, maintainability, and best-practice performance findings in final review output while lowering validator token spend.

**Architecture:** Tighten issue generation guidance, add deterministic soft-issue filtering in validation and aggregation, and keep the change local to `code-argus` without schema changes. The first iteration relies on existing `category`, `severity`, `confidence`, and `validation_status` fields so `pr-manager` can consume results unchanged.

**Tech Stack:** TypeScript, Vitest, markdown prompt/rule files

---

### Task 1: Lock Down Aggregation Expectations

**Files:**

- Modify: `tests/review/aggregator.test.ts`
- Modify: `src/review/aggregator.ts`

- [ ] Add failing tests for default soft-issue filtering and uncertain issue exclusion.
- [ ] Run the targeted aggregator tests and confirm the new expectations fail for the current implementation.
- [ ] Implement the minimal aggregation policy changes.
- [ ] Re-run the aggregator tests until they pass.

### Task 2: Add Validator Policy Coverage

**Files:**

- Modify: `tests/review/streaming-validator-runtime.test.ts`
- Modify: `src/review/constants.ts`
- Modify: `src/review/streaming-validator.ts`

- [ ] Add failing tests for soft `suggestion` issues being auto-rejected and for soft `warning` issues using stricter entry thresholds.
- [ ] Run the targeted validator tests and confirm the failures are caused by missing policy.
- [ ] Implement category-aware validation policy and keep hard findings behavior intact.
- [ ] Re-run the targeted validator tests until they pass.

### Task 3: Tighten Prompt and Rule Guidance

**Files:**

- Modify: `src/review/prompts/streaming.ts`
- Modify: `src/review/rules/defaults/style.md`
- Modify: `src/review/rules/defaults/performance.md`
- Modify: `src/review/prompts/templates/maintainability-validation.md`
- Modify: `tests/review/validation-prompts.test.ts`

- [ ] Add failing prompt/rule tests for the new “high-signal only” guidance.
- [ ] Run the prompt-focused tests and confirm they fail on the current wording.
- [ ] Update prompt and markdown rule text to suppress low-value style, maintainability, and best-practice performance findings.
- [ ] Re-run the prompt tests until they pass.

### Task 4: Wire Orchestrator Defaults and Verify

**Files:**

- Modify: `src/review/streaming-orchestrator.ts`
- Modify: `tests/review/streaming-orchestrator-runtime.test.ts`

- [ ] Add failing tests proving orchestrator aggregation uses the stricter defaults.
- [ ] Run the orchestrator-targeted tests and confirm failure.
- [ ] Implement the minimal orchestration changes.
- [ ] Re-run the targeted review test suite and confirm it passes.

### Task 5: Final Verification

**Files:**

- Modify: none unless verification exposes regressions

- [ ] Run focused review tests covering aggregator, validator, prompts, and orchestrator.
- [ ] Run `npm run type-check`.
- [ ] Summarize behavior changes, residual risks, and any follow-up tuning needed.
