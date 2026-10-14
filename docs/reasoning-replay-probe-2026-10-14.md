# Reasoning 重放实际验证与 Review 修正

## 结论

2026-10-14 在 `ssh-bridge` 主机别名 `prm-g1-103` 上，通过 PR Manager 已配置的
`api.aicr.gccode.cn` 网关和服务器凭据测试了真实 Responses 工具调用。
当前网关没有复现“删除 reasoning、保留工具 item ID 后第二轮报错”。因此不把这项
风险当作已确认的生产 P1，不修改 `ARGUS_OPENAI_REASONING_REPLAY=drop` 默认值。
官方严格接口的兼容性仍未实际验证；这不等于证明所有 OpenAI 部署都安全。

## 方法与结果

使用仓库的 `scripts/probe-reasoning-replay.mjs`，所有请求为 `store:false`、
`reasoning.effort=high`、`tool_choice=auto`，工具只返回固定的合成 fixture。
不查询真实 PR、不修改服务配置、不重启线上进程。凭据只在服务器进程中读取，
不传回本地、不保存到报告。

每个模型分别用 keep/drop 请求第一轮，从真实响应取工具调用和 item ID。
keep 第一轮响应测试三种 follow-up：完整重放、删除 reasoning 保留 ID、删除
reasoning 且去掉工具 item ID。drop 第一轮响应测试后两种 follow-up。
同一第一轮响应用于三种重放，避免把模型第一次输出的随机变化当作兼容性差异。

| 模型                | 第一轮成功 | Follow-up 成功 | 实际 item 形态                                                  |
| ------------------- | ---------- | -------------- | --------------------------------------------------------------- |
| deepseek-v4.1-flash | 2/2        | 5/5            | reasoning 与工具 item 都是 UUID，返回 38 字符 encrypted content |
| gpt-5.6-sol         | 2/2        | 5/5            | 工具 ID 为 `item_*`，第一轮没有 reasoning item                  |
| gpt-5               | 2/2        | 5/5            | 工具 ID 为 `item_*`，第一轮没有 reasoning item                  |

合计 6 次第一轮、15 次 follow-up 全部 `status=completed`，没有配对报错。
前置探针中强制 function `tool_choice` 被 DeepSeek thinking 模式以 400 拒绝，
`gpt-5.5` 被账号组以 404 拒绝；这两类失败发生在第一轮，不作为重放问题证据。

该网关没有返回官方 `rs_*`/`fc_*` 配对项，GPT 路由也没有 reasoning 输出；
结果只能证明当前网关接受这些请求，不能验证官方 item 配对约束。
需要严格 `store:false` reasoning 重放的部署仍可显式设置 `keep`。
此探针不是 PR 审核 A/B，不用于推导审核质量、净费用或缓存收益。

## 复现

在服务器上运行以下命令（脚本路径按上传位置调整）：

```bash
node /tmp/argus-reasoning-replay-20261014.mjs \
  --package-root=/home/xaadmin/gc-ai-code-reviewer/packages/server \
  --env-file=/home/xaadmin/gc-ai-code-reviewer/.env \
  --models=deepseek-v4.1-flash,gpt-5.6-sol,gpt-5
```

脚本使用部署里的 OpenAI SDK 解析流，目的是直接检验协议 payload，不依赖本地 mock。
不重试 API 请求；每个请求超时 90 秒。`--list-models` 查询当前凭据可用模型。

## 其余 Review 修复

- SDK/pi-ai 每个 prompt 的结果用量汇总其全部工具调用轮次，不再仅保留最后一轮；
  streamed prompt 之间用量互斥，validator 可直接相加。
- 后续异常或无最终响应时保留之前已上报的消耗。无法统计 provider 未上报的重试、
  断流消耗；历史报告不会自动重算，旧 A/B 需要原始请求级日志才能校正。
- 本轮修正的是 runtime 每 prompt 的统计契约，不是完整账单审计：用户取消仍按异常退出，
  reviewer 的跨 attempt 重试也仍存在最终汇总遗漏失败 attempt 的既有局限。
- transcript 折叠先检查能否达到 60% 低水位；不可达时不改写历史，并告警。
  这保护缓存前缀，但不保证上下文不会溢出，预算依然是 best effort。
- fix-verifier 同普通 validator 一样传递 `validatorReasoningEffort`，默认高档降到 medium。
- PR Manager 增加真实客户端配置构造到日志输出的回归测试，不再仅依赖手写配置。
- SDK 异常结果处理仍需区分用户取消：真实 `APIUserAbortError` 的 `name` 是 `Error`，
  SSE 中断也可能静默结束。runtime 按调用方 signal 归一化为 `AbortError`，
  取消不输出普通 error result，也不进入兼容性 fallback；回归覆盖首轮、工具续轮和静默断流。
- custom agent / fix-verifier 消费 `error` result 后进入既有错误回调 / progress 路径，
  避免 SDK 异常改为 result 后失去失败信号，同时保留 result 中上报的用量。

## 本地验证

- Code Argus 全量：32 个测试文件、375 项测试通过；类型检查与改动文件 ESLint / Prettier 通过。
- Code Argus `pnpm build` 通过；Windows 的默认 PATH 不包含 `cp`，本次仅在构建进程中
  临时加入 Git 的 `usr/bin`，没有修改项目构建脚本或系统配置。
- PR Manager 的 log-context、client-selection、client-sdk、client、config.openai-runtime
  测试通过；server 类型检查与构建通过。client-selection 新增 5 条真实日志断言。
- 取消边界测试先复现 3 项失败，再修复为 5 项通过；SDK 真实错误类与静默断流都被覆盖。
- 本次不是费用 A/B：不推导 token 节省比例，也不自动校正历史测试结论。

## 独立复核与范围边界

通过 Codex CLI 对两个仓库的本轮工作区做只读独立复核，并在修正 SDK 取消与
调用方失败信号后补做定向复核。最终没有发现本次新增代码的确定性缺陷。
实时去重使用 `generateText()`，其基于 API 错误对象的重试策略未被 `execute()` 改动影响；
PR Manager 启动、子进程和真实客户端的日志都传递所选 `impl`。

以下既有局限不在本轮五项反馈的修复范围内，也没有声称已解决：

- transcript 不是硬上限；保留项持续超过低水位时可能始终无法折叠，最终触发上下文超限。
- reviewer 跨 attempt 的最终统计仍可能遗漏失败 attempt，用户取消也不产出 usage result。
- custom agent / fix-verifier 对 `incomplete`、`error_empty_output`、`error_max_turns`
  仍沿用既有处理；本轮仅修正 `error` result 丢失失败信号的回归，没有统一所有终止状态。
- fix-verifier 既有 catch 后仍返回部分 summary，并发出完成提示；summary 没有独立的
  incomplete/error 标记。因此不能只凭完成提示认定所有 issue 都完成了验证。
