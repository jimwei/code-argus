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
- Multi-round validation to reduce false positives
- Fast review mode for lower-latency feedback
- Realtime deduplication with rule-based filtering plus semantic verification
- Incremental review by branch or commit range
- Project standards extraction from ESLint, TypeScript, and Prettier config
- Custom rules, custom agents, and `.argusignore`
- JSON event stream output for CI/CD and external integrations

## Installation

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
export ARGUS_MODEL=gpt-5
export ARGUS_LIGHT_MODEL=gpt-5-mini
export ARGUS_VALIDATOR_MODEL=gpt-5
```

You can also persist the default main model:

```bash
argus config set model gpt-5
```

Notes:

- `model` is a shared fallback and is not provider-specific
- `api-key` and `base-url` in config remain Claude-compatible fields
- When using `openai-responses`, explicitly setting `ARGUS_MODEL` is recommended

### Environment variable summary

| Purpose               | Variables                                       |
| --------------------- | ----------------------------------------------- |
| Runtime selection     | `ARGUS_RUNTIME`                                 |
| Main model            | `ARGUS_MODEL`                                   |
| Light model           | `ARGUS_LIGHT_MODEL`                             |
| Validator model       | `ARGUS_VALIDATOR_MODEL`                         |
| Claude API key        | `ARGUS_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` |
| Claude OAuth or proxy | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`   |
| Claude base URL       | `ARGUS_ANTHROPIC_BASE_URL`                      |
| OpenAI API key        | `ARGUS_OPENAI_API_KEY` / `OPENAI_API_KEY`       |
| OpenAI base URL       | `ARGUS_OPENAI_BASE_URL` / `OPENAI_BASE_URL`     |

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

| Option                     | Description                                       |
| -------------------------- | ------------------------------------------------- | ------------------------ |
| `--json-logs`              | Emit NDJSON events for service integration        |
| `--language=<zh            | en>`                                              | Set output language      |
| `--review-mode=<normal     | fast>`                                            | Control validation depth |
| `--skip-validation`        | Skip validation for faster output                 |
| `--verbose`                | Emit extra debug information                      |
| `--config-dir=<path>`      | Auto-load rules, agents, and `.argusignore`       |
| `--rules-dir=<path>`       | Add a custom rules directory                      |
| `--agents-dir=<path>`      | Add a custom agents directory                     |
| `--previous-review=<file>` | Load a previous review and verify fixes           |
| `--no-verify-fixes`        | Disable fix verification                          |
| `--pr-context=<file>`      | Inject PR business context, for example Jira data |
| `--local`                  | Use local branches and skip `git fetch`           |
| `--require-worktree`       | Require worktree creation or fail                 |
| `--diff-file=<path>`       | Read diff input from a file                       |
| `--diff-stdin`             | Read diff input from stdin                        |
| `--commits=<sha1,sha2>`    | Review only the specified commits                 |
| `--no-smart-merge-filter`  | Disable smart merge filtering                     |

### Review modes

| Mode     | Description                                       |
| -------- | ------------------------------------------------- |
| `normal` | Default mode with 5 progressive validation rounds |
| `fast`   | Faster mode with 2 compressed validation rounds   |

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

## JSON Event Stream

With `--json-logs`, progress and the final report are emitted to `stderr` as NDJSON:

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
