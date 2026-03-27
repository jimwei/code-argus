# PR Draft: Dual Runtime Foundation

## Summary

This change adds the first provider-neutral runtime foundation for `code-argus`, allowing the review pipeline to run on either:

- `claude-agent`
- `openai-responses`

The OpenAI path uses the official `openai` SDK and the Responses API. Review modules no longer call provider SDKs directly; provider-specific code is isolated under `src/runtime/*`.

## Scope

- added runtime-aware env/config loading
- added runtime factory and normalized runtime contracts
- implemented Claude runtime adapter
- implemented OpenAI Responses runtime adapter
- migrated orchestrator, validator, fix verifier, and custom agent execution to `runtime.execute()`
- migrated selector, matcher, and realtime deduplicator to `runtime.generateText()`
- updated tests and documentation for dual-runtime behavior

## Operational Contract

- `ARGUS_RUNTIME` is controlled only by global environment variables
- OpenAI credentials are controlled only by environment variables
- the local config file still stores Claude-compatible `api-key` and `base-url`
- `model` remains a shared fallback field
- when using `ARGUS_RUNTIME=openai-responses`, set `ARGUS_MODEL` explicitly

## Verification

Verified in this worktree:

- `$env:NODE_OPTIONS='--max-old-space-size=4096'; npm run type-check`
- `$env:NODE_OPTIONS='--max-old-space-size=4096'; npm run test:run`

Latest result:

- 22 test files passed
- 186 tests passed

## Manual Smoke Test Status

Claude smoke test:

- not run in this session
- blocked by missing credentials in the local environment

OpenAI smoke test:

- not run in this session
- blocked by missing `OPENAI_API_KEY` / `ARGUS_OPENAI_API_KEY` in the local environment

## Suggested Smoke Commands

### OpenAI

```bash
export ARGUS_RUNTIME=openai-responses
export OPENAI_API_KEY=your-api-key
export ARGUS_MODEL=gpt-5

argus review /path/to/repo feature-branch main --review-mode=fast --json-logs
```

### Claude

```bash
export ARGUS_RUNTIME=claude-agent
export ANTHROPIC_API_KEY=your-api-key

argus review /path/to/repo feature-branch main --review-mode=fast --json-logs
```

## Risks and Follow-ups

- real-provider smoke tests still need to be completed before merge
- OpenAI model selection should stay explicit in automation to avoid provider/model mismatch
- future provider work should preserve `src/runtime/*` as the only provider boundary
