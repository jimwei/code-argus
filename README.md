# code-argus

AI-powered automated code review CLI with multi-agent orchestration and dual Claude/OpenAI runtime support.

English | [README.zh-CN](./README.zh-CN.md)

## Overview

`code-argus` reviews Git diffs with an agent-based pipeline that finds issues, validates them, deduplicates overlaps, and emits a structured report.

This branch adds the first production-ready dual runtime foundation:

- Two runtime families are supported: `claude-agent` and `openai-responses`
- Runtime selection is controlled only through the global `ARGUS_RUNTIME` environment variable
- The OpenAI path uses the official `openai` SDK and the Responses API
- The Claude path continues to use `@anthropic-ai/claude-agent-sdk`
- Provider-specific SDK usage is isolated under `src/runtime/*`

## Features

- Multi-agent parallel review for security, logic, performance, and style
- Smart agent selection based on the changed file set
- Large PR segmentation, with each segment's File Change Analysis limited to files in that segment's diff
- Multi-round validation to reduce false positives
- Fast review mode for lower-latency feedback
- Realtime deduplication with rule-based filtering plus semantic verification
- Incremental review by branch or commit range
- Project standards extraction from ESLint, TypeScript, and Prettier config
- Custom rules, custom agents, and `.argusignore`
- JSON event stream output for CI/CD and external integrations

## Installation

Requires Node.js 22 or later (the OpenAI Responses runtime depends on `openai` v7,
which requires Node 22+).

### Global install

```bash
npm install -g code-argus
```

### Using `npx`

```bash
npx code-argus review /path/to/repo feature-branch main
```

### From source

```bash
git clone https://github.com/Edric-Li/code-argus.git
cd code-argus/core
npm install
npm run build
npm link
```

## Quick Start

### Claude runtime

```bash
export ARGUS_RUNTIME=claude-agent
export ANTHROPIC_API_KEY=your-api-key

argus review /path/to/repo feature-branch main
```

### OpenAI runtime

```bash
export ARGUS_RUNTIME=openai-responses
export OPENAI_API_KEY=your-api-key
export ARGUS_MODEL=gpt-5

argus review /path/to/repo feature-branch main
```

## 审核策略与可配置主 reviewer

`multi` 是默认审核策略，保留安全、逻辑、性能和风格等内置 reviewer 的分工。`single` 使用一个主 reviewer 做综合审核，同时保留按规则匹配的 supplemental custom agents；它不会关闭验证、去重或修复验证。审核策略与 `--review-mode=normal|fast` 正交：normal/fast 决定验证轮次，不决定 reviewer 数量。

```bash
# 默认 multi；环境变量留空也使用 multi
export ARGUS_REVIEW_STRATEGY=single
# 可选，留空使用随包内置的综合 reviewer YAML 与 prompt
export ARGUS_PRIMARY_REVIEWER=/config/team-primary.yaml

argus review /path/to/repo feature-branch main --review-mode=fast
# CLI 显式参数优先于环境变量；--primary-reviewer= 显式选择内置定义
argus review /path/to/repo feature-branch main --review-strategy=single --primary-reviewer=/config/team-primary.yaml
```

主定义使用 custom agent YAML 格式，运行标识为 `custom:<name>`。主 reviewer 必须启用，并会忽略触发条件而必跑；同一个定义作为主 reviewer 后，不会再作为 supplemental agent 重复执行。其他 custom agents 仍按各自触发规则运行。multi 策略不使用主定义路径。非法策略、主定义文件不可读或定义不合法会直接失败。

```yaml
name: team-primary
description: 综合检查业务逻辑、安全和可维护性
prompt_file: ./team-primary.md
max_turns: 80
```

`prompt_file` 相对于 YAML 文件所在目录解析，也支持绝对路径；它与内联 `prompt` 二选一。主定义省略触发配置即可。`max_turns` 可选，必须是 24 到 500 的整数；省略时按变更文件数动态计算综合审核预算，重试可能使用更大预算，并受 500 轮上限约束。预算增加会提高调用时间和 token 成本，不能保证模型在预算内完成。补充 agent 继续使用现有预算策略。

包内综合定义包含 severity 分级标准：确认的安全回归——尤其是 diff 移除或弱化既有校验、且不可信输入仍可达的情况——不低于 `error`；`suggestion` 只用于非缺陷的可选改进，缺陷不能降级到该级别。

主 reviewer 或补充审核因预算耗尽、缺少证据等原因未完成时，报告的 `metadata.review_complete` 为 `false`，`incomplete_reasons` 列出原因，已报告的部分 findings 会保留。validator 崩溃并耗尽恢复重试、问题缺少 `file` 等结构性错误同样会标记为不完整；缺少有效位置的 finding 不会进入验证，也不会把未处理队列当作成功的 clean 结果。可读报告会明确“审核不完整”，不能把零 findings 当作完整 clean 结论。`metadata.review_strategy`、`primary_reviewer`、`reviewer_max_turns` 记录实际策略、主 reviewer 标识和执行预算，便于核验。

## Runtime and Authentication

### Runtime selection

The active runtime is selected globally through environment variables:

```bash
# Default
export ARGUS_RUNTIME=claude-agent

# Switch to OpenAI Responses
export ARGUS_RUNTIME=openai-responses
```

Operational rules:

- `ARGUS_RUNTIME` is env-only
- The `argus config` command does not persist the runtime
- Provider switching on the same machine is done by changing environment variables

### Claude credentials

Claude runtime credentials are resolved in this order:

1. `ARGUS_ANTHROPIC_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`
3. `ANTHROPIC_API_KEY`
4. `argus config set api-key ...`

Examples:

```bash
# Environment variable
export ANTHROPIC_API_KEY=your-api-key

# .env file
echo "ANTHROPIC_API_KEY=your-api-key" > .env

# Argus config fallback
argus config set api-key sk-ant-xxx
```

Optional Claude base URL:

```bash
export ARGUS_ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

OAuth-style Claude-compatible setup:

```bash
export ANTHROPIC_BASE_URL=https://your-claude-compatible-endpoint
export ANTHROPIC_AUTH_TOKEN=your-token
```

### OpenAI credentials

OpenAI runtime credentials are env-only and resolved in this order:

1. `ARGUS_OPENAI_API_KEY`
2. `OPENAI_API_KEY`

Examples:

```bash
# Standard OpenAI env var
export OPENAI_API_KEY=your-api-key

# Argus-specific env var
export ARGUS_OPENAI_API_KEY=your-api-key
```

Optional OpenAI base URL:

```bash
export ARGUS_OPENAI_BASE_URL=https://your-openai-compatible-endpoint
```

or:

```bash
export OPENAI_BASE_URL=https://your-openai-compatible-endpoint
```

### Model configuration

Shared model-related environment variables:

```bash
export ARGUS_OPENAI_MODEL=gpt-5
export ARGUS_MODEL=gpt-5
export ARGUS_LIGHT_MODEL=gpt-5-mini
export ARGUS_VALIDATOR_MODEL=gpt-5
export ARGUS_REASONING_EFFORT=medium
export ARGUS_VALIDATOR_REASONING_EFFORT=medium
```

You can also persist the default main model:

```bash
argus config set model gpt-5
```

Notes:

- `model` is a shared fallback and is not provider-specific
- `api-key` and `base-url` in config remain Claude-compatible fields
- When using `openai-responses`, `ARGUS_OPENAI_MODEL` takes precedence over `ARGUS_MODEL`
  and becomes the source for the main/light/validator slots unless a slot override is set
- `ARGUS_REASONING_EFFORT` is a single global value passed to every OpenAI Responses
  request (`minimal`, `low`, `medium`, `high`, ...); unset keeps the provider default
- `ARGUS_REASONING_EFFORT` must use one of `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`. pi-ai clamps an unknown level to the first entry of its vocabulary
  (`off`, i.e. `reasoning.effort=none`) instead of reporting an error, so the runtime
  validates the value and falls back to the provider default (with a one-time warning)
  rather than silently disabling reasoning
- Validator sessions, including fix verification, default to `medium` reasoning whenever
  `ARGUS_REASONING_EFFORT` is
  higher than `medium` (the validator model itself keeps using `ARGUS_VALIDATOR_MODEL`).
  Set `ARGUS_VALIDATOR_REASONING_EFFORT` to override; when no main effort is configured
  the validator keeps the provider default
- The following bullets, through the `systemPrompt` note, describe the `pi-ai` implementation
  (`ARGUS_OPENAI_RESPONSE_IMPL=pi-ai`)
- `openai-responses` traffic goes through `@earendil-works/pi-ai`, which always sends
  `store: false` plus the full transcript. The whole `pi-ai` path omits
  `max_output_tokens` (the SDK path never sent one on agent turns either): a
  reasoning-heavy turn can exhaust a fixed output cap, and an `incomplete` response
  can make the orchestrator retry the whole agent. Explicit `maxOutputTokens` budgets on light-path
  calls (agent selector / dedup / matcher) are ignored on this path
- The pi-ai runtime replays native reasoning blocks exactly like the SDK implementation:
  `reasoning.summary` / `include: ["reasoning.encrypted_content"]` stay in the payload and
  historical thinking blocks are written back to the transcript (older ones may later be
  dropped by transcript folding, see below). There is no reasoning-replay mode setting;
  native reasoning replay is always enabled
- The pi-ai runtime also lifts the session instructions from the leading `developer`
  input message into the top-level `instructions` field, matching the SDK request shape.
- `ARGUS_TRANSCRIPT_BUDGET_TOKENS` (default `160000`, `0` disables) bounds the pi-ai
  transcript on a best-effort basis: once the estimated request size crosses the
  budget, the oldest tool outputs are folded (and the thinking blocks of older assistant
  turns are dropped — pi-ai replays reasoning from `thinkingSignature`, so they dominate
  long sessions) toward 60% of it. The most recent six tool outputs, the most recent four
  assistant turns and all user messages are preserved, so tool-call pairing stays
  intact. Folding proceeds when it can reach the low watermark, or when one pass can
  save at least `max(8k, half the overflow)` estimated tokens even if that watermark is
  unreachable. Otherwise history is preserved. If the request remains over budget
  after the compaction check, a warning is emitted once per session. Previously folded
  tool results remain unchanged in later folds. Each fold can invalidate the cached
  suffix after the first newly changed item; the prefix is stable between folds,
  not necessarily for the rest of the session. The budget is not a hard context limit: if retained
  content stays above the low watermark, compaction may stay inactive until requests
  exceed the provider context limit. The default
  160k leaves estimated 32k output headroom inside the 200k window when the budget is
  met; verify net cost using cached/input counters if cached tokens are cheap
- The runtime sends a `systemPrompt` on every request (the reviewer budget text is
  appended when a completion budget is present)
- Both Responses implementations report all provider-reported usage across tool turns
  for each prompt in `result.usage`, including earlier turns when a later request fails.
  Subsequent streamed prompts have disjoint usage, so validators can sum their results
  without double counting. Cache rate is cached input divided by input (which already
  includes cached input). Unreported usage from transport/provider-internal retries
  cannot be recovered and is not included
- See [reasoning replay and transcript budget](docs/reasoning-replay-probe-2026-10-14.md)
  for current behavior and compatibility limits. Official strict-interface item-pairing
  compatibility remains unverified
- The [pi-ai vs SDK review A/B report](docs/pi-ai-vs-sdk-review-ab-2026-10-16.md)
  records the current build on prm-g1-103: four fixed PR snapshots, both implementations,
  serial runs with a 40-minute cap
- A turn truncated by the output budget (`stopReason=length`) is reported as
  `incomplete` and its tool calls are **not** executed: their arguments may be cut off
  or mixed up (upstream fixed the same class of bug for unfinished Responses tool calls
  in #9974)
- `ARGUS_OPENAI_RESPONSE_IMPL` selects which protocol stack backs the `openai-responses`
  runtime: `sdk` (default, the self-maintained `openai` SDK implementation) or `pi-ai`
  (`@earendil-works/pi-ai` pinned to `1.4.0`, opt-in). Both share the same
  `AgentRuntime` contract and event statuses, so nothing else in the pipeline changes;
  an unknown value falls back to `sdk` with a warning

### Environment variable summary

| Purpose                         | Variables                                       |
| ------------------------------- | ----------------------------------------------- |
| Runtime selection               | `ARGUS_RUNTIME`                                 |
| OpenAI Responses protocol stack | `ARGUS_OPENAI_RESPONSE_IMPL`                    |
| OpenAI shared model             | `ARGUS_OPENAI_MODEL`                            |
| Main model                      | `ARGUS_MODEL`                                   |
| Light model                     | `ARGUS_LIGHT_MODEL`                             |
| Validator model                 | `ARGUS_VALIDATOR_MODEL`                         |
| Reasoning effort                | `ARGUS_REASONING_EFFORT`                        |
| Validator reasoning effort      | `ARGUS_VALIDATOR_REASONING_EFFORT`              |
| pi-ai transcript budget         | `ARGUS_TRANSCRIPT_BUDGET_TOKENS`                |
| Claude API key                  | `ARGUS_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` |
| Claude OAuth or proxy           | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`   |
| Claude base URL                 | `ARGUS_ANTHROPIC_BASE_URL`                      |
| OpenAI API key                  | `ARGUS_OPENAI_API_KEY` / `OPENAI_API_KEY`       |
| OpenAI base URL                 | `ARGUS_OPENAI_BASE_URL` / `OPENAI_BASE_URL`     |

## Configuration Management

Config is stored at:

```bash
~/.argus/config.json
```

Common commands:

```bash
argus config set api-key sk-ant-xxx
argus config set base-url https://proxy.example.com
argus config set model claude-sonnet-4-5-20250929

argus config list
argus config get api-key
argus config path
argus config delete base-url
```

Current config semantics:

- `api-key`: Claude runtime fallback API key
- `base-url`: Claude-compatible base URL
- `model`: shared main-model fallback

Environment variables take precedence over config values.

## Commands and Usage

### Command format

```bash
argus <command> [options]
```

### Main commands

| Command   | Description                        |
| --------- | ---------------------------------- |
| `review`  | Run AI code review on a repository |
| `config`  | Manage local configuration         |
| `upgrade` | Upgrade to the latest release      |

### `review` command format

```bash
argus review <repoPath> <source> <target> [options]
```

Arguments:

| Argument   | Description                      |
| ---------- | -------------------------------- |
| `repoPath` | Path to the Git repository       |
| `source`   | Source branch name or commit SHA |
| `target`   | Target branch name or commit SHA |

Reference auto-detection:

- Branch names use three-dot diff: `origin/target...origin/source`
- Commit SHAs use two-dot diff: `target..source`

## Common Options

| Option                        | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| `--json-logs`                 | Emit NDJSON events for service integration                                  |
| `--language=<zh               | en>`                                                                        | Set output language      |
| `--review-mode=<normal        | fast>`                                                                      | Control validation depth |
| `--validation-rounds=<n>`     | Validation rounds per issue (1..5; default: fast 2, normal 5)               |
| `--validation-max-turns=<n>`  | Per-issue validation turn budget (1..300; default 30)                       |
| `--validation-read-limit=<n>` | Lines per validator Read call (60..400; default 140; openai-responses only) |
| `--skip-validation`           | Skip validation for faster output                                           |
| `--verbose`                   | Emit extra debug information                                                |
| `--config-dir=<path>`         | Auto-load rules, agents, and `.argusignore`                                 |
| `--rules-dir=<path>`          | Add a custom rules directory                                                |
| `--agents-dir=<path>`         | Add a custom agents directory                                               |
| `--previous-review=<file>`    | Load a previous review and verify fixes                                     |
| `--no-verify-fixes`           | Disable fix verification                                                    |
| `--pr-context=<file>`         | Inject PR business context, for example Jira data                           |
| `--local`                     | Use local branches and skip `git fetch`                                     |
| `--require-worktree`          | Require worktree creation or fail                                           |
| `--diff-file=<path>`          | Read diff input from a file                                                 |
| `--diff-stdin`                | Read diff input from stdin                                                  |
| `--commits=<sha1,sha2>`       | Review only the specified commits                                           |
| `--no-smart-merge-filter`     | Disable smart merge filtering                                               |

### Review modes

| Mode     | Description                                       |
| -------- | ------------------------------------------------- |
| `normal` | Default mode with 5 progressive validation rounds |
| `fast`   | Faster mode with 2 compressed validation rounds   |

Validation cost tuning: `--validation-rounds`, `--validation-max-turns` and
`--validation-read-limit` (or `ARGUS_VALIDATION_ROUNDS`, `ARGUS_VALIDATION_MAX_TURNS`,
`ARGUS_VALIDATION_READ_LIMIT`) override the mode defaults per run. In `single` mode the
validator is often the largest token consumer, so lower the rounds/turn budget or widen the
Read window deliberately and measure the effect before changing production defaults.

## Examples

### Branch-based review

```bash
argus review /path/to/repo feature-branch main
```

### Commit-based incremental review

```bash
argus review /path/to/repo abc1234 def5678
```

### OpenAI runtime with English output

```bash
export ARGUS_RUNTIME=openai-responses
export OPENAI_API_KEY=your-api-key
export ARGUS_MODEL=gpt-5

argus review /path/to/repo feature-branch main --language=en
```

### Fast mode with JSON logs

```bash
argus review /repo feature main --review-mode=fast --json-logs
```

### CI-oriented quick check

```bash
argus review /repo feature main --skip-validation --json-logs
```

### Fix verification

```bash
argus review /repo feature main --previous-review=./review-1.json
```

### PR context

```bash
argus review /repo feature main --pr-context=./pr-context.json
```

### External diff input

```bash
argus review /repo --diff-file=./pr.diff
```

```bash
curl -s "https://bitbucket.example.com/api/..." | argus review /repo --diff-stdin
```

## Configuration Directory Convention

When `--config-dir` is used, Argus auto-loads:

- `rules/`
- `agents/`
- `.argusignore`

Example:

```text
.ai-review/
|- .argusignore
|- rules/
|  |- global.md
|  |- security.md
|  |- logic.md
|  `- checklist.yaml
`- agents/
   `- api-security.yaml
```

### `.argusignore`

`.argusignore` uses gitignore-like syntax to filter files before review.

```gitignore
# Test files
*.test.ts
*.spec.ts
**/__tests__/**

# Documentation
docs/**
*.md

# Build artifacts
dist/**
build/**

# Generated code
**/*.generated.ts

# Keep critical tests
!critical.test.ts
```

### Repository context tool limits

Agents explore the repository with the built-in `Read`, `Grep`, and `Glob` tools. Every tool result is replayed to the model on later turns, so these tools are bounded by default to keep one oversized file from exhausting the provider context window:

| Tool          | Default limit                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Read`        | ~64 KB per call; oversized lines are clipped and the result reports the next `offset` to continue from                   |
| `Grep`        | ~48 KB per call; matched lines are truncated to 400 characters                                                           |
| `Grep`/`Glob` | generated bundles (`*.min.js`, `iconfont.js`, `*.map`), lockfiles, binary assets, and files larger than 1 MB are skipped |

`Read` still opens an excluded file when its path is requested explicitly, the returned content is just bounded. Embedders can override the budgets with `createRepoContextTools(repoPath, { readByteLimit, grepByteLimit, grepLineCharLimit, maxIndexedFileBytes, excludedFilePatterns })`.

## JSON Event Stream

With `--json-logs`, progress and the final report are emitted to `stderr` as NDJSON:

The final report metadata includes provider prompt-cache usage when the runtime reports it:

```json
{
  "metadata": {
    "input_tokens_used": 120000,
    "cached_input_tokens_used": 80000,
    "output_tokens_used": 6000,
    "tokens_used": 126000
  }
}
```

`cachedInputTokens` is omitted from runtime events when the provider does not report a positive
cached-token count. The final aggregated metadata always includes `cached_input_tokens_used`, with
`0` used when no cache usage was reported.

```bash
argus review /repo feature main --json-logs
```

Common event types:

- `review:start`
- `phase:start`
- `agent:start`
- `agent:progress`
- `agent:complete`
- `validation:issue`
- `review:complete`
- `report`

Example:

```jsonl
{"type":"review:start","data":{"repoPath":"/repo","sourceBranch":"feature","targetBranch":"main","timestamp":"2025-01-15T10:00:00.000Z"}}
{"type":"agent:complete","data":{"agent":"security-reviewer","issuesFound":3,"timestamp":"..."}}
{"type":"report","data":{"report":{"issues":[...],"metrics":{...},"metadata":{...}},"timestamp":"..."}}
```

## PR Context File

`--pr-context` injects business context into the review flow. Typical sources are Jira, Bitbucket PR metadata, or an internal aggregation service.

```json
{
  "prTitle": "PROJ-123: Fix login validation",
  "prDescription": "Fixes the login bug...",
  "jiraIssues": [
    {
      "key": "PROJ-123",
      "type": "Bug",
      "summary": "Login fails with special chars",
      "keyPoints": ["Handle special characters in password"],
      "reviewContext": "Check input validation"
    }
  ],
  "parseStatus": "found",
  "parseMessage": "Successfully processed 1 issue"
}
```

Schema:

```text
schemas/pr-context.schema.json
```

## How It Works

The standard review flow is:

1. Build context from the diff and project standards
2. Select the necessary agents
3. Execute agents in parallel
4. Validate candidate issues
5. Optionally verify previously reported issues
6. Aggregate, deduplicate, and emit the final report

## Project Structure

This is a deliberately compact structure view that tracks the stable module boundaries:

```text
src/
|- index.ts                 # CLI entry
|- runtime/                 # Runtime abstraction and provider adapters
|  |- factory.ts
|  |- types.ts
|  |- claude-agent.ts
|  `- openai-responses.ts
|- review/                  # Orchestration, validation, dedup, reporting
|- git/                     # Git refs, diff, worktree management
|- diff/                    # External diff and incremental diff support
|- config/                  # Environment and local config
|- cli/                     # CLI output and event formatting
|- analyzer/                # Local and semantic analysis helpers
|- types/
`- utils/

schemas/
`- pr-context.schema.json
```

## Development Commands

```bash
# Development
npm run dev -- <command> ...
npm run exec src/file.ts

# Build
npm run build
npm run type-check

# Code quality
npm run lint
npm run lint:fix
npm run format
npm run format:check

# Tests
npm run test
npm run test:run
npm run test:coverage
```

## Commit Convention

Conventional Commits are recommended:

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

## License

MIT

## Reviewer completion and retry budgets

Security reviewers focus on concrete security regressions and assess whether they can
finish after an initial eight context-tool calls. A completed review may legitimately
find zero issues. Unresolved material hypotheses must be reported through
`report_incomplete`; the reviewer keeps the findings it already reported, the agent is
marked incomplete, and the review is not rated as clean.

For built-in reviewers using `openai-responses`, each request includes its remaining
budget. The final three requests are reserved for reporting and completion: `Read`,
`Grep`, and `Glob` are unavailable in that phase, while `report_issue` and
`report_incomplete` remain available. Validators and other runtime consumers do not
use this reviewer-only closing phase. Success on the last allowed request is terminal
and is not followed by a spurious max-turn error.

Retries receive bounded, explicitly partial excerpts of previous context-tool results
and errors (up to 12,000 characters before JSON encoding), so they can focus on the
remaining evidence instead of restarting broad exploration. `Grep.path` accepts either
a repository-relative directory or a single file and still honors the glob filter.
