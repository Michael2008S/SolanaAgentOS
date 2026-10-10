# Devnet 部署与真实交易证据

本流程用于证明指定源码的构建已部署，以及 Skill 支付与 Escrow 结算确实发生。只读核验工具不签名或发送交易；经用户授权的完整 runner 会执行下文限额拨款与业务交易，保留原始证据。完整人工操作仍见 [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)。

## 当前公开配置

- Program：`HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv`
- 当前部署钱包公钥：`88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4`
- 网络：Devnet。
- 当前源码部署及完整二进制比较已通过，见 [2026-10-10 finalized 报告](evidence/devnet-current-source-20261010/report.json)：部署 slot `509450279`，1,523,824 bytes，SHA-256 `bc17c3fe638621d38a08a76378664c707470d14b9abc26284412d4addeeef48a`。部署原发送的独立核对及 SOL 三角色业务验收已完成，见下文；这份部署报告本身只证明部署。

## 自动三角色验收入口

**最新验收已通过：** [真实 DeepSeek SOL Devnet 报告](evidence/background-role-pipeline-devnet-real-model-2026-10-10T08-10-06-818Z/report.json) 和 [独立核验](evidence/background-role-pipeline-devnet-real-model-2026-10-10T08-10-06-818Z/verification.json) 证明 7 次模型请求、两次付费 Research、两次 Worker 交付、两次 Judge pass／结算与 Task 完成。[全部 40 笔交易](evidence/background-role-pipeline-devnet-real-model-2026-10-10T08-10-06-818Z/all-transactions-report.json) 均 finalized 成功，原 RPC bytes、签名、wire、哈希及当前源码部署匹配已核验，网络费共 335,000 lamports。完成后重启没有新增效果，累计模型额度 87/100。此前两个失败运行的 32／10 笔原效果保持独立记录，不改写成功。父进程保留角色签名者；此验收不证明生产 Vault 或跨主机故障接管。

用户于 2026-10-10 明确取消 USDC 测试。当前 `--devnet` 验收固定使用 SOL：两次付费 Research、两次 Worker 交付、独立 Judge 裁决／结算和 Task 完成；仍检查付款响应丢失恢复与角色重启。原钱包只拨 0.3 SOL，含网络费总上限 0.30001 SOL；不会运行 SPL Token CLI、读取 USDC 资金账户或发送 USDC 指令。完整证据要求一笔原钱包拨款与全部 39 笔业务原交易，共 40 笔。此前双资产准备、零 USDC 和领取说明保留为历史记录，不再阻塞本次目标。

部署原发送的 [逐笔收集报告](evidence/devnet-deployment-2026-10-10T04-26-14-358Z/receipts-report.json) 已保存 1,671 个预约：1,523 笔 finalized 收据通过签名、wire 范围、原提交哈希和费用核验；132 个原 RPC 拒绝且未查到收据；原报告保留 16 个未知。已确认网络费合计 7,625,000 lamports，没有发现 finalized 失败交易。单独的 [补充核对报告](evidence/devnet-deployment-reconciliation-2026-10-10T07-33-29-902Z/report.json) 已完整匹配部署锚点后的 1,522 条钱包索引；148 个无收据签名的历史状态均为空、139 个不同原 blockhash 全部过期、钱包余额与所有已确认原交易净额精确相符。因此补充记录这些原发送为 `expired-with-no-finalized-record`，受官方 RPC 历史范围约束，不是成功收据。原 incomplete 报告、首次补充查询超时报告及所有原 bytes／日志保持不变。

只读预检当前源码部署及真实资金，不读取模型凭证、不签署／发送：

```sh
node --import tsx tests/local/devnet-role-preflight.mts --run
```

资金缺失时退出码为 2，报告 `funding-required`；资金已有也只报告准备情况，不运行任务。预检生成的未授权收款提案仅属于这次父进程，结束时丢弃密钥，不能向这些地址充值。实际测试资金应留在原 CLI 钱包 `88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4`；验收 runner 会创建并持有新的临时身份。

在用户已授权完整 Devnet 验收的范围内，运行同一真实模型业务夹具：

```sh
node --import tsx tests/local/background-role-pipeline-flow.mts --run --real-model --devnet
node --import tsx scripts/verify-background-role-pipeline.mts <本次完整证据目录>
```

runner 先重新核对完整 Devnet genesis、当前源码构建、链上 ProgramData、原钱包 SOL 余额，再核对 Solana CLI 的公开钱包身份。当前固定拨款为临时 payer 0.3 SOL，原钱包含费用总上限 0.30001 SOL。它不创建替代 mint、不请求空投，不在资金缺失时进行任意部分拨款。原 CLI 持有其自己的密钥，原输出被抑制；角色签名者仅在父进程内存中，过程结束不会导出密钥。

三个实际 Runtime、共享正文服务及固定授权的工具／交付／裁决／结算／完成使用已有业务代码。验收保留原响应丢失、Worker／Judge 重启和完成态再启动的检查；模型配额继续用已有累计账本，至少保留 9 次可用额度，包含最多两次 Worker 格式修正。不会重置失败调用或篡改 needs_review 以获得 pass。计划推荐与 Owner 审阅的固定付款条款分开。

业务发送通过固定官方 Devnet 中继，最多 50 笔，逐笔模拟／费用核对并在广播前保存完整原 wire，未知原发送不重签／重付。当前 SOL 验收须保存 1 笔原钱包拨款和全部 39 笔业务发送的原 finalized RPC bytes，而不只是关键角色交易。离线核验新增 `all-transactions-report.json`、公开发送日志、每笔 raw SHA-256／wire／签名／费用及当前源码部署门禁；仅更改 Localnet 报告的网络名称或删掉一个网络字段仍不能通过。失败运行也会尽可能只读保存已发生的原效果；不齐的收据明确为 incomplete。

[纯 SOL 只读预检](evidence/devnet-role-preflight-2026-10-10T07-44-27-071Z/report.json) 先验证了部署与 SOL 资金；后续完整现场验收见上方报告。此前双资产预检、USDC 零余额及领取准备属于历史记录。用户取消 USDC 测试后，本次无需领取 USDC。

部署原发送可单独进行下述只读核对。已保存报告使用业务拨款之前的完整钱包 checkpoint；之后钱包有新交易时，不能用当前钱包余额直接重验该历史区间，工具会因额外交易或余额差异保持 incomplete：

```sh
AGENTOS_DEPLOYMENT_REVIEW=docs/evidence/devnet-deployment-2026-10-10T04-26-14-358Z/review.json node scripts/reconcile-reviewed-deployment.mjs
```

该工具重新核验已捕获的每笔签名、原 wire／哈希／费用；完整读取从当前钱包记录到第一笔原部署锚点的 finalized 索引，要求索引与收据集合逐项一致。所有缺失原签名均查询历史状态，并核对原 blockhash 已失效和钱包原余额到当前余额的逐笔净额。只有全部条件满足才记录 `expired-with-no-finalized-record`，该结论受官方 RPC 历史范围约束，不是成功收据；原 `receipts-report.json` 保持不变。索引额外交易、余额差异、已有签名状态、未过期 blockhash 或读取失败都保持 incomplete，不重发、不重新部署。

## 1. 构建并保留来源记录

```sh
npm run build:devnet
```

使用已存在的 `target/sbf-safe/agent_os-keypair.json`，只通过 Solana CLI 读取它的公开地址；不创建、导出或显示秘密内容。公开地址必须与源码一致。构建默认使用本机已经安装的 `v1.57` 工具与 `1.95.0-sbpf-solana-v1.57` Rust 工具链；其他环境可通过 `AGENTOS_SBF_TOOLS_VERSION` 和 `AGENTOS_SBF_RUST_TOOLCHAIN` 指定已安装版本。

产物包括 `agent_os.so`、`build.log`、`build-manifest.json`。来源记录包含源码和 Cargo 文件的 SHA-256、二进制 SHA-256、工具版本及诊断警告。Stack diagnostics 即使构建退出码为零也会被视为失败。构建成功不等于链上部署成功。

当前本机 SDK 的 `syscalls.txt` 是空文件，构建仍会报告若干 syscall 未识别。此事实记录在构建来源文件中；不能仅通过消除或忽略警告认定链上兼容。

## 2. 部署前审阅

部署前先准备足够的 Devnet 测试 SOL。部署摘要应明确：Program 地址、二进制哈希、费用承担钱包、Devnet、账户租金和可升级权限。沿用现有钱包和 Program signer，在审阅确认后执行部署。不要使用 `--skip-preflight`、`--skip-feature-verify` 或 `--final`。

源码 Program ID 更新后应使用本节构建，避免 `anchor keys sync` 意外改用另一份 build directory 内的 keypair。两份本地应用配置应设为上述 Program，RPC 应指向官方 Devnet 或经 genesis 校验的 Devnet 服务。

## 3. 核对实际部署

```sh
npm run preflight:devnet
npm run evidence:devnet -- --deployment-only --payer 88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4
```

证据收集会：

1. 校验 Devnet 的完整 genesis hash。
2. 在 `finalized` commitment 下读取 Program 和 ProgramData。
3. 检查 Upgradeable Loader 所有权、executable 标记和账户结构。
4. 检查本地构建来源与当前源码、Cargo 文件是否匹配。
5. 逐字节比较链上程序与本地 `.so`，验证剩余容量为零填充。
6. 保存部署 slot、upgrade authority、二进制哈希和原始 RPC 数据。

默认输出到 `docs/evidence/<UTC时间>/`。使用 `--output <目录>` 可指定目录；复用同一目录会覆盖该目录中的报告。`--binary` 和 `--build-manifest` 用于明确选择另一份对应产物。脚本使用环境变量 `SOLANA_RPC_URL` 或官方 Devnet 默认地址，不读取应用 `.env` 中的 API Key。

可选 `--payer <公开地址>` 会记录 finalized 钱包余额以及 Program、同尺寸 ProgramData、Buffer 的租金总和。该总和是保守准备值，不包含网络手续费、额外扩容和 Buffer 资金回收，不构成精确部署报价。

报告 `deployment-verified-workflows-pending` 仅表示源码／二进制／部署匹配。部署缺失、旧版本、错误网络或 RPC 失败均返回非零退出码，报告保持 `incomplete`。

## 4. 操作两条主流程

按运行手册完成：

- Skill：注册并启动 Provider → Session 支付 → HTTP 响应 → 记录响应哈希 → 保存 Memory → 生成最终回答。
- Escrow：创建并注资 → Worker 接收任务 → Worker 签署结果 → 雇主审核并释放 → 查看 Worker Reputation。

记录 Skill payment 和 result recording 的两笔签名，以及 Escrow funding、Worker submission、release 的三笔签名。结果正文必须保留原始字节：Skill 的 JSON 响应不能重新格式化，否则 SHA-256 会变化。Escrow 任务和结果使用网页实际承诺的文本。

## 5. 收集两条流程的链上证据

创建一个本地输入文件，例如放在被 Git 忽略的 `apps/runtime/.data/demo-input.json`。以下内容只是格式示例，不是交易证据：

```json
{
  "format": "agentos-demo-input",
  "version": 1,
  "programId": "HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv",
  "skill": {
    "skill": "实际Skill地址",
    "execution": "实际Execution地址",
    "prompt": "实际请求原文",
    "response": "实际响应原文，不要重新格式化",
    "paymentSignature": "实际付款签名",
    "resultSignature": "实际记录结果签名"
  },
  "escrow": {
    "escrow": "实际Escrow地址",
    "task": "实际任务原文",
    "result": "实际Worker结果原文",
    "fundingSignature": "实际注资签名",
    "submissionSignature": "实际Worker提交签名",
    "releaseSignature": "实际释放签名"
  }
}
```

对于任务专用 Skill 支付，还必须在 `skill` 对象中添加 `"task": "实际Task地址"` 和 `"actionId": "实际稳定动作编号"`。工具会检查任务归属、TaskAction PDA、金额、资产、Execution 关联及两笔交易的任务账户。普通旧版 Skill 流程不需要这两个字段。任务动作回执证明付款，不能单独证明 Provider 已执行 HTTP 请求。

```sh
npm run evidence:devnet -- --input apps/runtime/.data/demo-input.json
```

脚本检查 finalized 交易成功状态、Program 指令、具体账户位置、金额、Execution ID、截止时间、输入／输出哈希、canonical PDA、Escrow Released 状态及 Worker Reputation 当前快照。支持 SOL／USDC、普通结果提交／带 Skill 来源提交。读取交易允许 transaction version 1。

输出：

- `report.json`：核查结论、金额、哈希、slot、签名和 Explorer 链接。
- `rpc-evidence.json`：网络、账户和实际交易的 RPC 返回值。

任一流程失败都会保持 `incomplete` 并返回非零退出码。链上证据全部通过时状态为 `chain-evidence-verified-offchain-review-required`。

## 6. 证据边界与 Demo 验收

链上核查证明支付、结果承诺及 Escrow 结算。它不证明 API 实际交付、事实准确、Judge 合理、Memory 保存或最终总结生成。完整 Demo 还应保留：

- HTTP 402 challenge、成功响应和 payment response 的页面记录。
- 保存 Memory 后重新加载／搜索并通过链上哈希核查的记录。
- 最终回答与提供给模型的 Skill 结果。
- 任务与结果交接、雇主审核过程。
- Worker Reputation 释放前和释放后的截图或快照。收集脚本仅提供当前值，不能把它当作精确增量。

目前尚未取得这些真实流程证据。仓库中的 readiness 报告应如实显示部署未完成，不能用输入示例、构建成功或模拟 Planner 输出替代。


## Task Escrow 的额外证据字段

Task 专用 Escrow 在原 `escrow` 输入对象中增加 `"parentTask": "实际父Task地址"` 和 `"actionId": "稳定动作编号"`。工具会核对 Task PDA／Agent 归属、TaskAction 资金回执、TaskEscrow 的 Task／Escrow／Execution 关联及 closed 状态，并验证 funding 和 release 交易里的任务账户。`parentTask` 是地址；原来的 `task` 字段仍是子任务原文。旧版普通 Escrow 不需要额外字段。关闭一笔关联不代表其他 Escrow 均已结算，工具不会用这一证明宣称整个任务已完成。

### Worker Session 交付证据

若采用单个 Escrow 的 Session delivery Permit，在原 `escrow` 输入对象中增加：

```json
{
  "deliverySession": "Worker Session PDA",
  "deliveryGrantSignature": "生效的 Owner grant_worker_delivery 交易签名"
}
```

保留 `submissionSignature`，此时必须对应 `submit_session_escrow_result`。采集脚本读取完整 Permit 和 Session，验证 canonical PDA、Worker／Escrow／Session 绑定、used 标记，核对 Owner grant 和 Session signer 的提交交易，并验证 grant → submit → release 顺序、提交时间早于 Permit／Session expiry。撤销发生在提交之后不会否定已有成功记录。该证据不证明后台队列自主发送、业务结果质量或 Judge 授权。

## 7. Judge 授权、裁决与固定结算证据

完成运行手册第 13 节后，证据工具可只采集 Judge，或与 Skill／普通雇主释放流程一起采集。默认仍核查 `skill,escrow`；`--workflows` 明确指定本次要核查的流程，报告保存 `requestedWorkflows`，未选择的流程不代表已完成。

在同格式输入文件中加入以下 `judge` 对象。占位内容需替换为实际数据；`artifact` 必须是 Runtime 返回并在网页保存的完整评审 JSON 对象，不能只提供哈希或自行编写摘要。

```json
{
  "format": "agentos-demo-input",
  "version": 1,
  "programId": "HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv",
  "judge": {
    "escrow": "实际Escrow地址",
    "task": "任务原文",
    "result": "Worker交付原文",
    "proposalSignature": "雇主提议Judge的主交易签名",
    "acceptanceSignature": "Worker确认相同授权条件的主交易签名",
    "recordingSignature": "Judge Session登记裁决的主交易签名",
    "settlementSignature": "固定付款或退款的主交易签名",
    "artifact": {}
  }
}
```

```sh
npm run evidence:devnet -- --workflows judge --input apps/runtime/.data/demo-input.json
# 输入中同时提供对应流程对象时，可选择多条：
npm run evidence:devnet -- --workflows skill,escrow,judge --input apps/runtime/.data/demo-input.json
```

只读核查包括：

1. 既有 Devnet／源码／部署二进制核查；Judge 所有账户的 Program ownership、discriminator、精确长度与 canonical PDA。
2. 双方与独立 Judge Agent／Owner、Session signer、不可变授权条件，以及 accepted／used 标记。
3. finalized 成功交易的主签名、指令、账户位置、必要 signer 与完整参数；提议 → 确认 → 裁决 → 结算顺序及期限。
4. 任务、结果和原评审正文的 SHA-256 与链上承诺一致；裁决分支和 criteria 对应。
5. 提供结算签名时，pass 必须 Released，fail 必须 Refunded，decision 必须 settled；核对 SOL Vault 或固定 Devnet USDC Mint／ATA、关联 Execution 的金额资产和成功／退款结果。Task 专用 Escrow 还核对父 Task、closed TaskEscrow 和结算交易账户。
6. 保存评审正文、各笔交易、当前 Reputation 快照及原始 RPC 记录。当前信誉值不能证明精确增量。

**未结算裁决：** `needs_review` 不允许提供 Judge 结算签名；pass／fail 尚未结算也可省略 `settlementSignature`。工具要求链上 decision 尚未 settled，报告为 `verified-judge-decision-unsettled`，总体状态带 `judge-unsettled`。这只证明裁决登记，不证明付款或退款，也不保证本金仍保留：既有 Owner 操作仍可能改变 Escrow，报告另列实时 `escrowStatus`。

Judge 报告不核查 funding／Worker submission 的原交易，不计算收款余额增量，不证明模型调用、评审合理性、自动运行或信誉增量。已成功的 Program 指令用于证明固定结算；若需展示注资和交付过程，应另保留对应签名及页面记录。原 `escrow` 核查要求雇主 release，不能直接把 Judge settlement 签名填进 `releaseSignature`。当前仍没有真实 Judge 交易证据。


## Reputation attribution boundary

Escrow and Judge reports now include `reputationAttribution`: current employer/Worker Owner keys, `sameOwner`, the latest source rule, and `historicalIncrementVerified: false`. Each party Agent is Program-owned and checked against its canonical PDA. Reputation snapshots use the exact 113-byte layout and enforce the 0–10,000 score range; a successful transfer is valid even if success/failure counters remain zero under the same-Owner exclusion rule.

These fields do not establish a before/after reputation delta or prove the historical binary executed the latest rule. Program provenance in this report verifies the current deployed artifact; an upgrade after an old settlement cannot retroactively prove that old transaction used the same binary. Preserve deployment and original settlement evidence separately. Do not treat `sameOwner: false` as proof that two different humans controlled the wallets.


## Latest read-only deployment status

`DEVNET_DEPLOYMENT_STATUS.json` records the 2026-10-07T15:14:59.618Z finalized Devnet read at slot 508496518: Program `HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv` was absent. Local source/build hashes matched; binary SHA-256 was `39e2bedf96e798b658d25ebe26cea4323930992e935fb022fc60ab6acbe17cf5`, 1,453,080 bytes. No deployment or paid workflow transaction occurred. This is a point-in-time status, not a claim about future state.

Repeat with `npm run status:devnet -- --output /absolute/path/new-status.json`. The tool refuses an existing output, verifies the full current build-input set and binary, checks Devnet genesis, and reads the Program at finalized commitment. A present account is reported as `present-unverified-binary`; use the full evidence collector for deployed ProgramData equivalence and original transaction proofs. The tool never reads keys or sends transactions.
