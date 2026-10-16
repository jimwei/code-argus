# Reasoning 重放与 transcript 预算

本文描述当前实现。真实 PR 的耗时、token、缓存和问题数见
[pi-ai 与 SDK 完整实测报告](pi-ai-vs-sdk-review-ab-2026-10-16.md)。

## 当前重放行为

pi-ai 按原生行为保留 `reasoning.summary` 与
`include: ["reasoning.encrypted_content"]`，并重放历史 thinking block。
无需配置重放模式。session instructions 提升到 Responses 顶层
`instructions`，pi-ai 路径不发送 `max_output_tokens`。

SDK 和 pi-ai 在每个 prompt 的 `result.usage` 中汇总该 prompt 已上报的全部工具
轮次消耗；后续请求失败时仍保留之前已上报的用量。streamed prompt 之间用量互斥。
provider 没有上报的传输重试、断流消耗无法补算；reviewer 跨 attempt 的最终汇总
也可能遗漏失败 attempt。因此费用对比以实测报告中的逐 HTTP 请求记录为准。

## transcript 折叠

`ARGUS_TRANSCRIPT_BUDGET_TOKENS` 默认 `160000`，设为 `0` 可关闭。
这是估算预算，不是 provider 上下文的硬上限，仅用于 pi-ai。

超过预算时，运行时尝试将较早工具输出替换为占位文本，并移除较早 assistant 回合
的 thinking block，目标为预算的 60%。最近六条工具输出、最近四个 assistant 回合
和全部 user 消息保留；工具调用与结果的配对保持不变。

满足以下任一条件时执行折叠：

- 折叠后可以达到 60% 低水位。
- 即使无法达到低水位，一次预计节省也达到 `max(8000, ceil(超出预算量 / 2))`。

否则保留历史。检查后仍超过预算时，每个 session 最多告警一次。保留内容过大时
仍可能触及 provider 上下文限制，不能把预算视为硬性内存或 token 保证。

已折叠的工具输出不会在后续折叠中再次改写。每次新增折叠都可能使首个改写点之后
的缓存失效；两次折叠之间前缀保持稳定，不代表整个 session 的缓存前缀始终不变。
需要同时检查缓存率、未命中输入和输出 token，不能只按总 token 判断费用。

## 兼容性边界

折叠会移除旧 reasoning item，但保留工具调用 item ID。当前完整 PR 实测仅能
验证报告所列网关、模型和请求形态。官方 OpenAI 严格接口的 item-pairing 兼容性
仍未现场验证；如部署出现与折叠相关的 400，可调高预算或设为 `0` 关闭折叠后定位。

模型发现的问题数不是已知真值召回率。`review:complete`、最终 `report`、
`incomplete`、失败 agent 与重试记录应结合检查，不能仅凭退出码或零 findings
认定审核完整。
