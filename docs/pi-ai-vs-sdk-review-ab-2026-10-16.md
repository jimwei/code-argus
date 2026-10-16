# pi-ai 与 OpenAI SDK 完整实测报告

数据生成时间：2026-10-16T08:54:27.435Z。全部时间窗使用 UTC。

被测源码：`2dd07963fcb9fe68c703a65a6dbce6d9830db365`，Code Argus PR #28。本文仅包含该构建的本轮实际运行数据。

主批次已完成四个 PR × 两臂，共 8 次运行；另有 0 次复验，全部逐次列出。

## 本轮观察

主批次 pi-ai / SDK 的总 token 合计为 **9,464,161 / 10,327,524**（比值 0.916×）；
各自运行耗时之和为 **28.40 / 33.84 分钟**（0.839×）。
这些是四个固定样本各一次运行的观测值，重复运行和逐 PR 差异见下表。

输入加权缓存率为 **91.60% / 91.69%**；未命中输入为 **756,089 / 816,431**，
输出为 **458,984 / 503,221**。缓存率和总 token 必须结合未命中输入、输出一起看。

主批次扫描/模型确认为 **14/2 / 14/3**（pi-ai / SDK）。
模型确认不是人工确认；问题总数不能替代逐条质量评估或真值召回率。

按实际 effort 拆分，high 合计为 **8,823,111 / 8,968,799**（0.984×），
medium 为 **641,050 / 1,358,725**。
medium 阶段差值占总 token 差值的 **83.13%**。
因此，端到端差值主要需要结合候选问题及验证工作量理解，不能直接归因于 runtime 固有开销。

## 实验条件

| 项目                         | 本轮值                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 主机 / 隔离目录              | prm-g1-103 / /tmp/argus-ab-2dd0796-20261016                                                                                   |
| 构建源码                     | 2dd07963fcb9fe68c703a65a6dbce6d9830db365                                                                                      |
| 构建包 SHA256                | d54974544ce501a2a1a71efe021ab5e5dbf729c84e110081621e90a61dfdda5b                                                              |
| 依赖                         | @earendil-works/pi-ai 1.1.0; openai 7.17.0                                                                                    |
| Node.js                      | v20.20.0                                                                                                                      |
| 请求模型名称                 | deepseek-v4.1-flash                                                                                                           |
| 请求 endpoint                | https://api.aicr.gccode.cn/v1/responses, https://api.aicr.gccode.cn/responses                                                 |
| 主流程 / validator reasoning | high / medium                                                                                                                 |
| pi-ai transcript 预算        | 160,000（当前默认；SDK 不使用该折叠器）                                                                                       |
| 单次运行上限                 | 2400000 ms（40 分钟；超时后保留数据并记录信号）                                                                               |
| 审核模式 / 语言              | fast / zh                                                                                                                     |
| 输入                         | 固定 diff、pr-context、完整源码快照；每对两臂使用同一输入                                                                     |
| 批次顺序                     | pi-ai #7191 r1 → sdk #7191 r1 → sdk #7186 r1 → pi-ai #7186 r1 → pi-ai #7183 r1 → sdk #7183 r1 → sdk #7182 r1 → pi-ai #7182 r1 |

各 CLI 运行串行；单次 CLI 内部保留其正常 agent 并发。fetch observer 仅观察请求，不改写 payload；
首条指令位于顶层 instructions，pi-ai 保留原生 reasoning 重放。是否发送输出上限以逐请求核对表为准。
采集器不保存 authorization header、API key 或完整 prompt。CLI 显式退出前最多等待 5 秒排空采集器，实际等待列入完整性表。

| 实现  | 实际请求 endpoint                       |
| ----- | --------------------------------------- |
| pi-ai | https://api.aicr.gccode.cn/v1/responses |
| sdk   | https://api.aicr.gccode.cn/responses    |

两种实现从同一服务器环境读取基地址配置，但 URL 归一化后的实际路径不同。
本轮保留各自默认行为，是当前实现的端到端比较；未验证这两个路径是否由网关映射到完全相同的后端，
因此不能把观测差值全部解释为协议库自身的开销。

所有运行从新进程开始，但没有清空共享网关/provider 缓存，不能称为冷缓存测试。先后顺序按 PR 交错，
以降低固定先后顺序的影响；网关负载、路由和模型行为仍可能波动。PR 标题和元数据来自固定快照，不代表当前线上 PR 状态。

## 完整运行总表

| PR   | 轮次 | 实现  | 开始 → 结束（UTC）                                  | 分钟  | 请求 | input     | cached    | 缓存率 | 未命中 input | output  | reasoning | 总 token  | 扫描/确认/拒绝/不确定 |
| ---- | ---- | ----- | --------------------------------------------------- | ----- | ---- | --------- | --------- | ------ | ------------ | ------- | --------- | --------- | --------------------- |
| 7191 | 1    | pi-ai | 2026-10-16T07:51:01.002Z → 2026-10-16T07:54:33.673Z | 3.54  | 42   | 844,596   | 731,648   | 86.63% | 112,948      | 52,693  | 38,331    | 897,289   | 3/1/2/0               |
| 7191 | 1    | sdk   | 2026-10-16T07:54:33.725Z → 2026-10-16T07:58:08.998Z | 3.59  | 33   | 542,633   | 452,480   | 83.39% | 90,153       | 52,169  | 44,357    | 594,802   | 1/0/1/0               |
| 7186 | 1    | sdk   | 2026-10-16T07:58:09.043Z → 2026-10-16T08:10:39.737Z | 12.51 | 49   | 2,075,593 | 1,875,840 | 90.38% | 199,753      | 156,926 | 145,843   | 2,232,519 | 2/0/2/0               |
| 7186 | 1    | pi-ai | 2026-10-16T08:10:39.782Z → 2026-10-16T08:18:30.370Z | 7.84  | 49   | 1,809,840 | 1,653,632 | 91.37% | 156,208      | 103,906 | 91,429    | 1,913,746 | 3/0/3/0               |
| 7183 | 1    | pi-ai | 2026-10-16T08:18:30.415Z → 2026-10-16T08:27:26.726Z | 8.94  | 84   | 3,394,090 | 3,115,776 | 91.80% | 278,314      | 173,349 | 151,066   | 3,567,439 | 4/1/3/0               |
| 7183 | 1    | sdk   | 2026-10-16T08:27:26.772Z → 2026-10-16T08:35:27.641Z | 8.01  | 105  | 3,471,748 | 3,206,912 | 92.37% | 264,836      | 144,600 | 116,635   | 3,616,348 | 6/2/4/0               |
| 7182 | 1    | sdk   | 2026-10-16T08:35:27.688Z → 2026-10-16T08:45:11.415Z | 9.73  | 86   | 3,734,329 | 3,472,640 | 92.99% | 261,689      | 149,526 | 124,580   | 3,883,855 | 5/1/4/0               |
| 7182 | 1    | pi-ai | 2026-10-16T08:45:11.474Z → 2026-10-16T08:53:16.028Z | 8.08  | 48   | 2,956,651 | 2,748,032 | 92.94% | 208,619      | 129,036 | 116,454   | 3,085,687 | 4/0/4/0               |

input 已包含 cached；总 token = input + output。reasoning 是 output 的子集，不重复相加。
数字来自每次 HTTP 响应已上报的 usage；无 usage 的错误响应单独列出，不把未知账单消耗当成零。

## 主批次逐 PR 对照

| PR   | 总 token pi/SDK | 时间 pi/SDK | 未命中 input pi/SDK | output pi/SDK | 缓存率差（pi−SDK） | high token pi/SDK | medium token pi/SDK |
| ---- | --------------- | ----------- | ------------------- | ------------- | ------------------ | ----------------- | ------------------- |
| 7182 | 0.794×          | 0.830×      | 0.797×              | 0.863×        | -0.05 pp           | 0.976×            | 0 / 722,264         |
| 7191 | 1.509×          | 0.988×      | 1.253×              | 1.010×        | 3.24 pp            | 0.812×            | 414,398 / 0         |
| 7186 | 0.857×          | 0.627×      | 0.782×              | 0.662×        | 0.99 pp            | 0.857×            | 0 / 0               |
| 7183 | 0.986×          | 1.115×      | 1.051×              | 1.199×        | -0.57 pp           | 1.121×            | 226,652 / 636,461   |

合计比值为各臂总量相除，不是逐 PR 比值的算术平均。完整流程包含发现问题后的验证工作；
当两臂发现不同问题时，validator 工作量不同，不能把全部差值直接归因于协议栈。

## 按实际 reasoning effort 拆分

| PR / 轮次 | 实现  | effort | 请求 | input     | cached    | 缓存率 | 未命中 input | output  | 总 token  |
| --------- | ----- | ------ | ---- | --------- | --------- | ------ | ------------ | ------- | --------- |
| 7191 / 1  | pi-ai | high   | 26   | 444,620   | 362,496   | 81.53% | 82,124       | 38,271  | 482,891   |
| 7191 / 1  | pi-ai | medium | 16   | 399,976   | 369,152   | 92.29% | 30,824       | 14,422  | 414,398   |
| 7191 / 1  | sdk   | high   | 33   | 542,633   | 452,480   | 83.39% | 90,153       | 52,169  | 594,802   |
| 7186 / 1  | sdk   | high   | 49   | 2,075,593 | 1,875,840 | 90.38% | 199,753      | 156,926 | 2,232,519 |
| 7186 / 1  | pi-ai | high   | 49   | 1,809,840 | 1,653,632 | 91.37% | 156,208      | 103,906 | 1,913,746 |
| 7183 / 1  | pi-ai | high   | 71   | 3,178,291 | 2,917,248 | 91.79% | 261,043      | 162,496 | 3,340,787 |
| 7183 / 1  | pi-ai | medium | 13   | 215,799   | 198,528   | 92.00% | 17,271       | 10,853  | 226,652   |
| 7183 / 1  | sdk   | high   | 70   | 2,860,689 | 2,656,000 | 92.84% | 204,689      | 119,198 | 2,979,887 |
| 7183 / 1  | sdk   | medium | 35   | 611,059   | 550,912   | 90.16% | 60,147       | 25,402  | 636,461   |
| 7182 / 1  | sdk   | high   | 55   | 3,039,296 | 2,836,096 | 93.31% | 203,200      | 122,295 | 3,161,591 |
| 7182 / 1  | sdk   | medium | 31   | 695,033   | 636,544   | 91.58% | 58,489       | 27,231  | 722,264   |
| 7182 / 1  | pi-ai | high   | 48   | 2,956,651 | 2,748,032 | 92.94% | 208,619      | 129,036 | 3,085,687 |

按请求实际 effort 分组；high 主要对应 reviewer，medium 对应 validator。若有轻量调用或重试，也计入其实际 effort 分组。

以 #7191 第一轮为例，pi-ai 比 SDK 多 302,487 tokens；
其中 high 差值为 -111,911，medium 差值为 414,398。
两臂扫描/确认为 3/1 与 1/0。
这将请求级差值定位到不同阶段；是否值得这些额外验证，需要结合下方问题明细判断。

#7182 第一轮中，high token 为 3,085,687 / 3,161,591，
medium 为 0 / 722,264（pi-ai / SDK）。
模型确认数为 0 / 1；pi-ai 较低的端到端用量包含不同的验证工作量。
本轮 SDK 确认而 pi-ai 未确认的问题见下方逐条明细，不能把这部分少做的验证计为相同质量下的性能收益。

## 缓存与请求性能

| PR / 轮次 | 实现  | 首请求缓存率 | 其余请求加权缓存率 | 零缓存请求 | prompt_cache_key 请求 | previous_response_id 请求 | max_output_tokens 请求 | 峰值 input | p50 / p95 秒  | 含占位项请求 |
| --------- | ----- | ------------ | ------------------ | ---------- | --------------------- | ------------------------- | ---------------------- | ---------- | ------------- | ------------ |
| 7191 / 1  | pi-ai | 95.80%       | 86.56%             | 0          | 0                     | 0                         | 0                      | 42,853     | 5.86 / 22.18  | 0            |
| 7191 / 1  | sdk   | 96.14%       | 83.25%             | 0          | 0                     | 4                         | 0                      | 52,335     | 5.98 / 32.01  | 0            |
| 7186 / 1  | sdk   | 98.27%       | 90.35%             | 0          | 0                     | 4                         | 0                      | 153,039    | 10.13 / 84.39 | 0            |
| 7186 / 1  | pi-ai | 98.01%       | 91.34%             | 0          | 0                     | 0                         | 0                      | 112,784    | 6.86 / 40.66  | 0            |
| 7183 / 1  | pi-ai | 98.71%       | 91.77%             | 1          | 0                     | 0                         | 0                      | 111,289    | 7.16 / 58.69  | 0            |
| 7183 / 1  | sdk   | 98.85%       | 92.34%             | 1          | 0                     | 7                         | 1                      | 122,908    | 4.91 / 26.18  | 0            |
| 7182 / 1  | sdk   | 99.00%       | 92.96%             | 1          | 0                     | 6                         | 1                      | 148,761    | 6.32 / 36.96  | 0            |
| 7182 / 1  | pi-ai | 98.90%       | 92.90%             | 0          | 0                     | 0                         | 0                      | 140,516    | 9.81 / 49.81  | 0            |

“首请求”和“其余请求”按运行内请求序号划分，不等同于真正冷/热缓存。缓存率使用 cached / input，
不平均每个请求的百分比。p50/p95 包含错误请求耗时；内部请求可能并发，不能把请求耗时之和当成运行墙钟时间。
“含占位项请求”仅表示发送的请求内出现折叠占位项，不是折叠操作次数。

## 完成性、错误与用量核对

| PR / 轮次 | 实现  | 流程完整 | 退出 / 超时 | agent 成功 / 事件数 | 请求 / 响应 / fetch 错误 | usage 响应 / 请求 | HTTP 错误 / 无 usage 响应 | 最终报告与 tap 总 token 差 | 采集排空毫秒 | 数据校验 |
| --------- | ----- | -------- | ----------- | ------------------- | ------------------------ | ----------------- | ------------------------- | -------------------------- | ------------ | -------- |
| 7191 / 1  | pi-ai | 是       | 0 / false   | 4 / 4               | 42 / 42 / 0              | 42 / 42           | 0 / 0                     | 0                          | 0            | 通过     |
| 7191 / 1  | sdk   | 是       | 0 / false   | 4 / 4               | 33 / 33 / 0              | 29 / 33           | 4 / 4                     | 0                          | 0            | 通过     |
| 7186 / 1  | sdk   | 是       | 0 / false   | 4 / 4               | 49 / 49 / 0              | 45 / 49           | 4 / 4                     | 0                          | 0            | 通过     |
| 7186 / 1  | pi-ai | 是       | 0 / false   | 4 / 4               | 49 / 49 / 0              | 49 / 49           | 0 / 0                     | 0                          | 0            | 通过     |
| 7183 / 1  | pi-ai | 是       | 0 / false   | 4 / 4               | 84 / 84 / 0              | 84 / 84           | 0 / 0                     | 0                          | 0            | 通过     |
| 7183 / 1  | sdk   | 是       | 0 / false   | 4 / 4               | 105 / 105 / 0            | 98 / 105          | 7 / 7                     | 0                          | 0            | 通过     |
| 7182 / 1  | sdk   | 是       | 0 / false   | 4 / 4               | 86 / 86 / 0              | 80 / 86           | 6 / 6                     | 0                          | 0            | 通过     |
| 7182 / 1  | pi-ai | 是       | 0 / false   | 4 / 4               | 48 / 48 / 0              | 48 / 48           | 0 / 0                     | 0                          | 0            | 通过     |

流程完整要求：退出成功、未超时、review:complete 和最终 report 存在、所有预期 agent 有成功终态，
且没有已记录的 agent error / incomplete 或失败分段。数据校验另核对请求终态覆盖、重复 ID、usage 数值边界、
provider total 与 input+output 的一致性、模型及 pi-ai 输出上限。无 usage 响应的消耗未知，合计是已上报用量。

计划覆盖：8/8；缺失单元：无；数据或流程未通过验收：无。

- sdk-pr7191-r1：HTTP 错误 4，fetch 错误 0；previous_response_id 请求 4；流程最终完整。
- sdk-pr7186-r1：HTTP 错误 4，fetch 错误 0；previous_response_id 请求 4；流程最终完整。
- sdk-pr7183-r1：HTTP 错误 7，fetch 错误 0；previous_response_id 请求 7；流程最终完整。
- sdk-pr7182-r1：HTTP 错误 6，fetch 错误 0；previous_response_id 请求 6；流程最终完整。

## reviewer 执行明细

| PR / 轮次 | 实现  | agent                | 耗时秒 | 扫描数 | Agent-Summary turns | Agent-Summary tokens | 状态      |
| --------- | ----- | -------------------- | ------ | ------ | ------------------- | -------------------- | --------- |
| 7191 / 1  | pi-ai | security-reviewer    | 90.62  | 0      | 5                   | 52,001               | completed |
| 7191 / 1  | pi-ai | logic-reviewer       | 90.62  | 2      | 17                  | 206,963              | completed |
| 7191 / 1  | pi-ai | performance-reviewer | 90.62  | 0      | 9                   | 117,840              | completed |
| 7191 / 1  | pi-ai | style-reviewer       | 90.62  | 1      | 8                   | 106,087              | completed |
| 7191 / 1  | sdk   | security-reviewer    | 214.36 | 0      | 12                  | 98,100               | completed |
| 7191 / 1  | sdk   | logic-reviewer       | 214.36 | 1      | 23                  | 364,351              | completed |
| 7191 / 1  | sdk   | performance-reviewer | 214.36 | 0      | 5                   | 41,417               | completed |
| 7191 / 1  | sdk   | style-reviewer       | 214.36 | 0      | 8                   | 90,934               | completed |
| 7186 / 1  | sdk   | security-reviewer    | 749.81 | 0      | 8                   | 69,105               | completed |
| 7186 / 1  | sdk   | logic-reviewer       | 749.81 | 2      | 44                  | 1,862,559            | completed |
| 7186 / 1  | sdk   | performance-reviewer | 749.81 | 0      | 12                  | 207,901              | completed |
| 7186 / 1  | sdk   | style-reviewer       | 749.81 | 0      | 7                   | 92,954               | completed |
| 7186 / 1  | pi-ai | security-reviewer    | 469.70 | 0      | 10                  | 107,925              | completed |
| 7186 / 1  | pi-ai | logic-reviewer       | 469.71 | 2      | 52                  | 1,526,812            | completed |
| 7186 / 1  | pi-ai | performance-reviewer | 469.71 | 0      | 14                  | 171,741              | completed |
| 7186 / 1  | pi-ai | style-reviewer       | 469.71 | 1      | 9                   | 107,268              | completed |
| 7183 / 1  | pi-ai | security-reviewer    | 467.04 | 1      | 31                  | 896,840              | completed |
| 7183 / 1  | pi-ai | logic-reviewer       | 467.04 | 1      | 42                  | 1,579,559            | completed |
| 7183 / 1  | pi-ai | performance-reviewer | 467.04 | 1      | 15                  | 329,318              | completed |
| 7183 / 1  | pi-ai | style-reviewer       | 467.04 | 1      | 24                  | 532,662              | completed |
| 7183 / 1  | sdk   | security-reviewer    | 479.94 | 2      | 20                  | 438,315              | completed |
| 7183 / 1  | sdk   | logic-reviewer       | 479.94 | 1      | 45                  | 1,863,195            | completed |
| 7183 / 1  | sdk   | performance-reviewer | 479.94 | 1      | 14                  | 243,096              | completed |
| 7183 / 1  | sdk   | style-reviewer       | 479.94 | 2      | 21                  | 433,741              | completed |
| 7182 / 1  | sdk   | security-reviewer    | 501.36 | 0      | 6                   | 112,744              | completed |
| 7182 / 1  | sdk   | logic-reviewer       | 501.36 | 1      | 43                  | 2,133,537            | completed |
| 7182 / 1  | sdk   | performance-reviewer | 501.36 | 1      | 20                  | 670,707              | completed |
| 7182 / 1  | sdk   | style-reviewer       | 501.36 | 3      | 13                  | 243,722              | completed |
| 7182 / 1  | pi-ai | security-reviewer    | 483.69 | 0      | 7                   | 181,608              | completed |
| 7182 / 1  | pi-ai | logic-reviewer       | 483.69 | 2      | 46                  | 2,372,593            | completed |
| 7182 / 1  | pi-ai | performance-reviewer | 483.69 | 0      | 12                  | 364,757              | completed |
| 7182 / 1  | pi-ai | style-reviewer       | 483.69 | 2      | 8                   | 166,729              | completed |

turns 为 CLI Agent-Summary 的内部计数，不等同于 HTTP 请求次数；请求数以 tap 为准。

## 模型确认的问题明细

| PR / 轮次 | 实现  | 级别    | 文件:行                                                                                                                                                  | 标题                                                                                | 验证状态  |
| --------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------- |
| 7191 / 1  | pi-ai | warning | BackEnd/SourceCode/LeySer.Fuji.Service.Base/Microservices/Business/LeySer.Base.EFCore.Kaikei/Repositories/AttachFileRepositories/AIOcrFileManager.cs:109 | OCR 原值字段未做空值保护，可能用 null/空串覆盖已有原值                              | confirmed |
| 7183 / 1  | pi-ai | warning | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:148                | 权限确认接口的检查范围由调用方指定，可被削弱/绕过                                   | confirmed |
| 7183 / 1  | sdk   | warning | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:148                | 新增 CheckReferencePermission 接口的判定项由客户端传入，授权判定可被篡改绕过        | confirmed |
| 7183 / 1  | sdk   | warning | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouAIController.cs:132                                   | 重複警告新增相手伺書 FormId，重複チェック範囲为「すべての伺書」时泄露範囲外伺書信息 | confirmed |
| 7182 / 1  | sdk   | warning | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:164                | 付箋保存接口新增同步向量更新，延迟随件数线性增长                                    | confirmed |

以下为全部扫描候选的最后验证事件；自动过滤和拒绝也保留，避免只展示最终确认数。完整描述与源码证据见服务器隔离目录中的 .stdout.jsonl，或用户交付数据包中的完整模型 report；伴随统计 JSON 仅保存问题标题、位置、状态与验证事件。

| PR / 轮次 | 实现  | 候选标题                                                                                     | 文件:行                                                                                                                                                  | 最后状态      | 原因                                                                                                                                                                                                                          |
| --------- | ----- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7191 / 1  | pi-ai | 新增成员 AI-OCR 缩写大小写不一致（Aiocr vs AIOcr）                                           | BackEnd/SourceCode/LeySer.Fuji.Service.Base/Microservices/Business/LeySer.Base.Core/AttachFile/Entities/KaikeiAttachFile.cs:147                          | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7191 / 1  | pi-ai | OCR 原值字段未做空值保护，可能用 null/空串覆盖已有原值                                       | BackEnd/SourceCode/LeySer.Fuji.Service.Base/Microservices/Business/LeySer.Base.EFCore.Kaikei/Repositories/AttachFileRepositories/AIOcrFileManager.cs:109 | confirmed     | 见完整报告证据                                                                                                                                                                                                                |
| 7191 / 1  | pi-ai | onlyUpdate 模式未校验 fileIds，空集合会触发对全部待处理文件的批量原值更新                    | BackEnd/SourceCode/LeySer.Fuji.Service.Base/Microservices/LeySer.Startups.KKAttachmentSite.API/Controllers/AttachFile/AIOcrController.cs:64              | auto_rejected | 置信度过低 (0.4 < 0.5)                                                                                                                                                                                                        |
| 7191 / 1  | sdk   | AI OCR 原值字段被无条件覆盖，可能用空值清空已保存原值                                        | BackEnd/SourceCode/LeySer.Fuji.Service.Base/Microservices/Business/LeySer.Base.EFCore.Kaikei/Repositories/AttachFileRepositories/AIOcrFileManager.cs:109 | auto_rejected | 置信度过低 (0.45 < 0.5)                                                                                                                                                                                                       |
| 7186 / 1  | sdk   | 分批删除改为基于网盘实际文件后，业务表中“无网盘文件/已隐藏”的申告书记录不会被清理            | BackEnd/SourceCode/LeySer.Fuji.Service.Work/LeySer.Startups.WorkSite.API/Controllers/Common/NetDisk/SchoolNetDiskController.cs:564                       | auto_rejected | 置信度过低 (0.45 < 0.5)                                                                                                                                                                                                       |
| 7186 / 1  | sdk   | BulkDeleteDeclarationFileAsync 删除件数/大小改由调用方提供，且移除了“无文件即返回”的兜底校验 | BackEnd/SourceCode/LeySer.Fuji.Service.Work/Business/Common/LeySer.Work.Domain.Common/NetDisk/NetDiskManager.cs:522                                      | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7186 / 1  | pi-ai | 按年度重复过滤，逻辑冗余易误导                                                               | BackEnd/SourceCode/LeySer.Fuji.Service.Work/LeySer.Startups.WorkSite.API/Controllers/Common/NetDisk/SchoolNetDiskController.cs:564                       | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7186 / 1  | pi-ai | DistinctBy 以 (Year, FileId) 去重，同一物理文件跨年度会被重复统计/无法彻底删除               | BackEnd/SourceCode/LeySer.Fuji.Service.Work/Business/Payroll/LeySer.Work.Domain.Payroll/Declaration/DeclarationManager.cs:35                             | auto_rejected | 置信度过低 (0.35 < 0.5)                                                                                                                                                                                                       |
| 7186 / 1  | pi-ai | BulkDeleteDeclarationFileAsync 不再校验文件是否存在，件数/大小完全信任调用方                 | BackEnd/SourceCode/LeySer.Fuji.Service.Work/Business/Common/LeySer.Work.Domain.Common/NetDisk/NetDiskManager.cs:522                                      | auto_rejected | 置信度过低 (0.45 < 0.75)                                                                                                                                                                                                      |
| 7183 / 1  | pi-ai | 权限判定失败路径上重复执行多次权限 SQL 与选项查询，DB 往返被放大                             | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Domain/Shikkou/UkagaisyoDetail/UkagaisyoDetailManager.cs:3442             | auto_rejected | 置信度过低 (0.45 < 0.5)                                                                                                                                                                                                       |
| 7183 / 1  | pi-ai | 枚举注释误导：除 Unknown 外的 NG 值在 JS 中均为 truthy，按布尔判断会被当成「可参照」         | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Common/Enums/Enum.cs:130                                                  | auto_rejected | 置信度过低 (0.5 < 0.75)                                                                                                                                                                                                       |
| 7183 / 1  | pi-ai | warnings 在错误分支为 null，却被响应映射闭包解引用                                           | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouAIController.cs:122                                   | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7183 / 1  | pi-ai | 权限确认接口的检查范围由调用方指定，可被削弱/绕过                                            | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:148                | confirmed     | 见完整报告证据                                                                                                                                                                                                                |
| 7183 / 1  | sdk   | 権限判定 NG 时的回退循环按项目重复发起 DB 查询                                               | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Domain/Shikkou/UkagaisyoDetail/UkagaisyoDetailManager.cs:3442             | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7183 / 1  | sdk   | 参数注释与实际含义不符（疑似复制粘贴残留）                                                   | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Common/Utility/ShikkouReferenceScopeHelper.cs:79                          | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7183 / 1  | sdk   | FormType 语义为「仅候補设置」但类型不可空，易被误读                                          | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Domain/Shikkou/Ai/ShikkouAiDuplicateCheckModels.cs:74                     | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7183 / 1  | sdk   | 新增 CheckReferencePermission 接口的判定项由客户端传入，授权判定可被篡改绕过                 | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:148                | confirmed     | 见完整报告证据                                                                                                                                                                                                                |
| 7183 / 1  | sdk   | 重複警告新增相手伺書 FormId，重複チェック範囲为「すべての伺書」时泄露範囲外伺書信息          | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouAIController.cs:132                                   | confirmed     | 见完整报告证据                                                                                                                                                                                                                |
| 7183 / 1  | sdk   | 参照権限判定结果枚举的真值语义易被误判为「可参照」                                           | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/Business/LeySer.Yosan.Kaikei.Core/Common/Enums/Enum.cs:128                                                  | rejected      | 风险依赖本代码库中并不存在的『布尔语义判断』调用方；仓内所有调用方均与 Ok 严格比较，无实际缺陷，返回枚举亦为项目惯例，属可读性建议而非逻辑缺陷。                                                                              |
| 7182 / 1  | sdk   | 方法名 GetChangedFormIdsAsync 与实际副作用不符                                               | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorBackgroundJobManager.cs:145                     | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7182 / 1  | sdk   | VectorBatchSize 常量在两个类中重复定义                                                       | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorManager.cs:27                                   | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7182 / 1  | sdk   | 删除具名常量改用裸魔法数字 21/22/.../72                                                      | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorSourceDataRepository.cs:1016                    | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7182 / 1  | sdk   | 付箋保存接口新增同步向量更新，延迟随件数线性增长                                             | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/UkagaisyoDetail/UkagaisyoDetailController.cs:164                | confirmed     | 见完整报告证据                                                                                                                                                                                                                |
| 7182 / 1  | sdk   | 附件过滤把 Status 为 NULL 的行也纳入，与画面口径不一致                                       | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorSourceDataRepository.cs:1456                    | rejected      | 画面/其它读取路径均为 EF Core LINQ，其默认空语义补偿会保留 Status 为 NULL 的行，与向量 SQL 的 IS NULL OR 完全一致；且 NULL 在本业务中即代表未删除（未变更附件保存时被置 null 并重插），建议改为排除 NULL 反而会丢失大量附件。 |
| 7182 / 1  | pi-ai | GetChangedFormIdsAsync 名称与新增的删除副作用不符                                            | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorBackgroundJobManager.cs:145                     | auto_rejected | 置信度过低 (0.7 < 0.75)                                                                                                                                                                                                       |
| 7182 / 1  | pi-ai | 删除具名常量后 OptionItem ID 退化为魔法数字                                                  | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorSourceDataRepository.cs:1013                    | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7182 / 1  | pi-ai | 调查文档写入生产源码目录且含开发者本地绝对路径                                               | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/web-win-finaltime-vector-incremental-sync.md:1               | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |
| 7182 / 1  | pi-ai | 无任务时 GetVectorTask 返回 Data=null，与 GetVectorStatus 契约不一致                         | BackEnd/SourceCode/LeySer.Fuji.Service.Yosan/LeySer.Yosan.Kaikei.API/Controllers/Shikkou/Ai/ShikkouVectorManager.cs:119                                  | auto_rejected | 低信号软建议：默认不进入验证或最终报告                                                                                                                                                                                        |

## 输入指纹与追溯

| PR   | 文件 / diff bytes | source commit / dest commit | diff SHA256                                                      | 源码树 SHA256                                                    |
| ---- | ----------------- | --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| 7182 | 9 / 67,910        | d33c03767e0d / 3a5df603767c | 43184ee77bbdc0166ddc1a34c553aee08e9d5a2e940bdb9f4bd85a9967a79f3a | b9da7c3b196785152343f0613474d1069b7466dfd6d97da5cbb966f3ea521367 |
| 7191 | 6 / 10,200        | 0f8ebc580a8f / 13f95f89bf96 | 22945dbe7ac65b78fd083d93ce191f342c2a6a4fe9640693ec10dc156f23e6d5 | 172b314cbebc066170d72df99511f59b4c7100df13c675a577c8c530d055283f |
| 7186 | 11 / 18,474       | 4b80f0b60f68 / 06bb71625ad6 | c1b1511801da21fadffdb9655ea77f01d490f38f7e29a7125e3414ec87e14cd0 | 507d69e98dd951ab3c2794597f15a230d37f0aeb7d86d69e164715e2fda5131d |
| 7183 | 10 / 41,479       | 8c658792c6af / b6a0a6b229c0 | 01e8ac008bf9b96f08f1210f319fdb15034396c708e3ad69291915c7dfbaa3cd | 5a56c3e234f704b53e98677d58e3014491a690052864033e3abbb177347e3c16 |

源码树指纹按排序后的相对文件名、文件大小与文件 SHA256 计算；不是 Git commit hash。固定快照未包含 .git。
复现仍需要同一私有仓库快照及服务器端凭据，数据包不携带源码或凭据。

## 复现与数据文件

同一隔离目录内，使用新的 round 编号避免覆盖已运行数据：

```bash
cd /tmp/argus-ab-2dd0796-20261016
node --env-file=/home/xaadmin/gc-ai-code-reviewer/.env run-current.mjs pi-ai 7182 3
node --env-file=/home/xaadmin/gc-ai-code-reviewer/.env run-current.mjs sdk 7182 3
node summarize-current.mjs
```

- `pi-ai-vs-sdk-review-ab-2026-10-16.data.json`：实验配置、逐运行统计、问题标题/位置/状态、验证事件和用量核对。
- `pi-ai-vs-sdk-review-ab-2026-10-16.requests.csv`：逐 HTTP 请求的时间、effort、input/output/cache、状态和 payload 标志。
- 服务器隔离目录保留每次 `.tap.jsonl`、`.meta.json`、`.stdout.jsonl`、`.stderr.jsonl` 及 harness。用户交付数据包保留 tap、meta、完整模型 report 与 harness；仓库中的统计 JSON 不包含源码证据片段。

## 结论边界与改进方向

本轮结果适用于表中的固定 PR 快照、构建、模型名称和网关。样本及重复次数有限，不能证明所有 PR 的性能或质量等价。
问题发现不同会改变验证量，需按 reviewer / validator、请求数、未命中输入和输出分解差值；不能只对比总 token 或缓存百分比。

费用公式为 `未命中输入 × 未命中单价 + cached × 缓存单价 + output × 输出单价`。
未获取本轮网关实际账单单价，因此不声明哪一臂实际更便宜。provider 未上报的错误消耗也不能从本报告补算。

可按证据分阶段改进：对增加在 validator 的消耗，先审核候选质量和拒绝原因；对 reviewer 的消耗，检查请求数与上下文峰值；
对低缓存率，结合折叠占位项和未命中输入定位；对 managed continuation 的 400，评估网关兼容性回退。
这些方向未在本轮改动运行时代码，不将它们写成已经验证的性能收益。

当前主机运行 Node v20.20.0；package.json 声明要求 Node >=22.19.0。两臂在同一现场版本运行，本次结果不能替代受支持 Node 版本的兼容性验证。

官方 OpenAI 严格接口的 reasoning/tool item-pairing 语义未在本轮验证；当前网关成功不能推导所有部署均兼容。

## 期末复核

期中复核：2026-10-16T08:06:17.424Z；期末复核：2026-10-16T08:54:27.494Z。四份源码树、diff、pr-context 与启动指纹一致；
服务器实际 dist 与本地构建包内容一致，构建包 SHA256 一致；期中与期末的服务器环境文件 SHA256 相同。
采集产物凭据检查通过（52 个文件），未发现实际服务器凭据值。
仓库统计 JSON 与逐请求 CSV 可独立重算表中 input、cached、uncached、output 及总量。
