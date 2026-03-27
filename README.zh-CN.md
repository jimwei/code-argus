# code-argus

AI 驱动的自动化代码审查 CLI，提供多 Agent 编排，并同时支持 Claude 与 OpenAI 两套运行时。

[English](./README.md) | 简体中文

## 项目概览

`code-argus` 面向 Git diff 做自动化审查，核心目标是把“发现问题、验证问题、去重、生成报告”这条链路做成可集成的 CLI。

当前版本的运行时设计重点：

- 支持双运行时：`claude-agent` 和 `openai-responses`
- 运行时切换仅通过全局环境变量 `ARGUS_RUNTIME` 控制
- OpenAI 路径基于官方 `openai` SDK 和 Responses API
- Claude 路径继续基于 `@anthropic-ai/claude-agent-sdk`
- 审查层不再直接依赖具体 Provider SDK，而是统一走运行时抽象

## 核心能力

- 多 Agent 并行审查：安全、逻辑、性能、风格等角色并发执行
- 智能 Agent 选择：根据变更文件特征自动挑选需要的 Agent
- 问题验证：通过多轮 challenge 模式降低误报
- 修复回归验证：加载历史审查结果，检查问题是否已被修复
- 实时去重：规则层快速去重 + LLM 语义去重
- 增量审查：支持按分支或按 commit 范围审查
- 项目约定感知：自动读取 ESLint / TypeScript / Prettier 等项目标准
- 自定义规则与 Agent：支持 `rules/`、`agents/`、`.argusignore`
- 服务集成：支持 JSON 事件流，便于接入 CI/CD 或外部平台

## 安装

### 全局安装

```bash
npm install -g code-argus
```

### 使用 `npx`

```bash
npx code-argus review /path/to/repo feature-branch main
```

### 从源码安装

```bash
git clone https://github.com/Edric-Li/code-argus.git
cd code-argus/core
npm install
npm run build
npm link
```

## 快速开始

### 使用 Claude 运行时

```bash
export ARGUS_RUNTIME=claude-agent
export ANTHROPIC_API_KEY=your-api-key

argus review /path/to/repo feature-branch main
```

### 使用 OpenAI 运行时

```bash
export ARGUS_RUNTIME=openai-responses
export OPENAI_API_KEY=your-api-key
export ARGUS_MODEL=gpt-5

argus review /path/to/repo feature-branch main
```

## 运行时与鉴权

### 运行时切换

运行时只通过全局环境变量控制：

```bash
# 默认值
export ARGUS_RUNTIME=claude-agent

# 切换到 OpenAI Responses
export ARGUS_RUNTIME=openai-responses
```

注意：

- `ARGUS_RUNTIME` 不写入配置文件
- CLI 的 `config` 子命令不会保存当前运行时
- 同一台机器上切换 Provider 时，直接改环境变量即可

### Claude 鉴权

Claude 运行时支持以下来源，优先级从高到低：

1. `ARGUS_ANTHROPIC_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`
3. `ANTHROPIC_API_KEY`
4. `argus config set api-key ...` 保存到本地配置文件

常见写法：

```bash
# 方式 1：环境变量
export ANTHROPIC_API_KEY=your-api-key

# 方式 2：.env 文件
echo "ANTHROPIC_API_KEY=your-api-key" > .env

# 方式 3：保存到 Argus 配置（Claude 回退路径）
argus config set api-key sk-ant-xxx
```

可选的 Claude Base URL：

```bash
export ARGUS_ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

如果使用 `ANTHROPIC_AUTH_TOKEN` 模式，则应配合：

```bash
export ANTHROPIC_BASE_URL=https://your-claude-compatible-endpoint
export ANTHROPIC_AUTH_TOKEN=your-token
```

### OpenAI 鉴权

OpenAI 运行时是 env-only，不落配置文件。支持以下来源，优先级从高到低：

1. `ARGUS_OPENAI_API_KEY`
2. `OPENAI_API_KEY`

常见写法：

```bash
# 方式 1：标准 OpenAI 环境变量
export OPENAI_API_KEY=your-api-key

# 方式 2：Argus 专用环境变量
export ARGUS_OPENAI_API_KEY=your-api-key
```

可选的 OpenAI Base URL：

```bash
export ARGUS_OPENAI_BASE_URL=https://your-openai-compatible-endpoint
```

或者：

```bash
export OPENAI_BASE_URL=https://your-openai-compatible-endpoint
```

### 模型配置

共享模型相关环境变量：

```bash
export ARGUS_MODEL=gpt-5
export ARGUS_LIGHT_MODEL=gpt-5-mini
export ARGUS_VALIDATOR_MODEL=gpt-5
```

也可以把主模型保存到配置文件：

```bash
argus config set model gpt-5
```

说明：

- `model` 是共享回退项，不区分 Claude / OpenAI
- `api-key` 和 `base-url` 目前仍是 Claude 兼容字段
- 使用 `openai-responses` 时，建议显式设置 `ARGUS_MODEL` 或 `argus config set model ...`
- 如果 OpenAI 运行时没有显式模型，当前实现会继续回退到项目默认主模型常量；为了避免 Provider 与模型不匹配，实际使用时应始终设置模型

### 环境变量总表

| 目的                    | 环境变量                                        |
| ----------------------- | ----------------------------------------------- |
| 运行时切换              | `ARGUS_RUNTIME`                                 |
| 主模型                  | `ARGUS_MODEL`                                   |
| 轻量模型                | `ARGUS_LIGHT_MODEL`                             |
| 验证模型                | `ARGUS_VALIDATOR_MODEL`                         |
| Claude API Key          | `ARGUS_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` |
| Claude OAuth / 兼容代理 | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`   |
| Claude Base URL         | `ARGUS_ANTHROPIC_BASE_URL`                      |
| OpenAI API Key          | `ARGUS_OPENAI_API_KEY` / `OPENAI_API_KEY`       |
| OpenAI Base URL         | `ARGUS_OPENAI_BASE_URL` / `OPENAI_BASE_URL`     |

## 配置管理

配置文件位于：

```bash
~/.argus/config.json
```

常用命令：

```bash
argus config set api-key sk-ant-xxx
argus config set base-url https://proxy.example.com
argus config set model claude-sonnet-4-5-20250929

argus config list
argus config get api-key
argus config path
argus config delete base-url
```

当前配置语义：

- `api-key`：Claude 运行时回退 API Key
- `base-url`：Claude 兼容 Base URL
- `model`：共享默认主模型回退值

环境变量优先级高于配置文件。

## 命令与基本用法

### 命令格式

```bash
argus <command> [options]
```

### 主要命令

| 命令      | 说明                   |
| --------- | ---------------------- |
| `review`  | 对仓库执行 AI 代码审查 |
| `config`  | 管理本地配置           |
| `upgrade` | 升级到最新版本         |

### `review` 命令格式

```bash
argus review <repoPath> <source> <target> [options]
```

参数说明：

| 参数       | 说明                    |
| ---------- | ----------------------- |
| `repoPath` | Git 仓库路径            |
| `source`   | 源分支名或 commit SHA   |
| `target`   | 目标分支名或 commit SHA |

自动识别规则：

- 当 `source` / `target` 是分支名时，使用 three-dot diff：`origin/target...origin/source`
- 当 `source` / `target` 是 commit SHA 时，使用 two-dot diff：`target..source`

## 常用选项

以下是最常用的一组选项。完整参数以 `argus --help` 输出为准。

| 选项                       | 说明                                              |
| -------------------------- | ------------------------------------------------- | ------------ |
| `--json-logs`              | 输出 JSON 事件流，适合服务集成                    |
| `--language=<zh            | en>`                                              | 设置输出语言 |
| `--review-mode=<normal     | fast>`                                            | 控制验证深度 |
| `--skip-validation`        | 跳过问题验证，换取更快速度                        |
| `--verbose`                | 输出更详细的调试信息                              |
| `--config-dir=<path>`      | 自动加载配置目录内的规则、Agent 与 `.argusignore` |
| `--rules-dir=<path>`       | 单独指定规则目录，可重复传入                      |
| `--agents-dir=<path>`      | 单独指定自定义 Agent 目录，可重复传入             |
| `--previous-review=<file>` | 加载历史审查结果并验证修复情况                    |
| `--no-verify-fixes`        | 关闭修复验证                                      |
| `--pr-context=<file>`      | 注入 PR 业务上下文，例如 Jira 信息                |
| `--local`                  | 使用本地分支，不执行 `git fetch`                  |
| `--require-worktree`       | 强制要求创建 worktree，失败则终止                 |
| `--diff-file=<path>`       | 从 diff 文件读取变更，而不是实时计算 git diff     |
| `--diff-stdin`             | 从标准输入读取 diff                               |
| `--commits=<sha1,sha2>`    | 仅审查指定 commit 列表                            |
| `--no-smart-merge-filter`  | 关闭增量模式下的智能 merge 过滤                   |

### 审查模式

| 模式     | 说明                                 |
| -------- | ------------------------------------ |
| `normal` | 默认模式，5 轮渐进式 challenge 验证  |
| `fast`   | 快速模式，2 轮压缩验证，适合更快反馈 |

## 常见示例

### 按分支审查

```bash
argus review /path/to/repo feature-branch main
```

### 按 commit 范围做增量审查

```bash
argus review /path/to/repo abc1234 def5678
```

### OpenAI 运行时 + 英文输出

```bash
export ARGUS_RUNTIME=openai-responses
export OPENAI_API_KEY=your-api-key
export ARGUS_MODEL=gpt-5

argus review /path/to/repo feature-branch main --language=en
```

### 快速模式 + JSON 日志

```bash
argus review /repo feature main --review-mode=fast --json-logs
```

### 跳过验证，加快 CI 检查

```bash
argus review /repo feature main --skip-validation --json-logs
```

### 验证历史问题是否已修复

```bash
argus review /repo feature main --previous-review=./review-1.json
```

### 注入 PR 业务上下文

```bash
argus review /repo feature main --pr-context=./pr-context.json
```

### 使用外部 diff

```bash
argus review /repo --diff-file=./pr.diff
```

```bash
curl -s "https://bitbucket.example.com/api/..." | argus review /repo --diff-stdin
```

## 配置目录约定

当使用 `--config-dir` 时，Argus 会自动加载：

- `rules/`
- `agents/`
- `.argusignore`

示例目录：

```text
.ai-review/
├─ .argusignore
├─ rules/
│  ├─ global.md
│  ├─ security.md
│  ├─ logic.md
│  └─ checklist.yaml
└─ agents/
   └─ api-security.yaml
```

### `.argusignore`

`.argusignore` 采用接近 gitignore 的语法，用于在审查前先过滤文件。

示例：

```gitignore
# 测试文件
*.test.ts
*.spec.ts
**/__tests__/**

# 文档
docs/**
*.md

# 构建产物
dist/**
build/**

# 生成代码
**/*.generated.ts

# 但保留关键测试
!critical.test.ts
```

## JSON 事件流

启用 `--json-logs` 后，Argus 会把进度和最终报告以 NDJSON 形式输出到 `stderr`，方便 CI/CD 或平台侧消费。

```bash
argus review /repo feature main --json-logs
```

典型事件类型：

- `review:start`
- `phase:start`
- `agent:start`
- `agent:progress`
- `agent:complete`
- `validation:issue`
- `review:complete`
- `report`

输出示例：

```jsonl
{"type":"review:start","data":{"repoPath":"/repo","sourceBranch":"feature","targetBranch":"main","timestamp":"2025-01-15T10:00:00.000Z"}}
{"type":"agent:complete","data":{"agent":"security-reviewer","issuesFound":3,"timestamp":"..."}}
{"type":"report","data":{"report":{"issues":[...],"metrics":{...},"metadata":{...}},"timestamp":"..."}}
```

## PR Context 文件

`--pr-context` 用于给审查过程注入业务上下文，常见来源是 Jira、Bitbucket PR 元数据或内部平台聚合信息。

基本结构：

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

完整 schema 见：

```text
schemas/pr-context.schema.json
```

## 工作机制概览

一次标准审查通常包含以下阶段：

1. 获取 diff，解析文件，提取项目约定
2. 根据变更特征选择需要的 Agent
3. 多 Agent 并行执行审查
4. 对候选问题做多轮验证
5. 按需验证历史问题是否已修复
6. 聚合、去重并输出最终报告

## 项目结构

这里保留一个精简版目录视图，只展示稳定的主模块，减少 README 与实现细节的耦合。

```text
src/
├─ index.ts                 # CLI 入口
├─ runtime/                 # 运行时抽象与 Provider 实现
│  ├─ factory.ts
│  ├─ types.ts
│  ├─ claude-agent.ts
│  └─ openai-responses.ts
├─ review/                  # 审查编排、验证、去重、报告
├─ git/                     # git ref / diff / worktree 处理
├─ diff/                    # 外部 diff 与增量 diff 分析
├─ config/                  # 环境变量与本地配置
├─ cli/                     # CLI 输出与事件
├─ analyzer/                # 本地/语义分析辅助模块
├─ types/
└─ utils/

schemas/
└─ pr-context.schema.json
```

## 开发命令

```bash
# 开发
npm run dev -- <command> ...
npm run exec src/file.ts

# 构建
npm run build
npm run type-check

# 代码质量
npm run lint
npm run lint:fix
npm run format
npm run format:check

# 测试
npm run test
npm run test:run
npm run test:coverage
```

## Commit 规范

建议使用 Conventional Commits：

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

常见类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`

## License

MIT
