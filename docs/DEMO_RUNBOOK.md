# AgentOS 评委 Demo 手动运行手册

本文按当前仓库实现整理，目标是在一台电脑上从启动服务到完成 Devnet 交易，手动复现 AgentOS 的主要链路。核心演示建议 8–12 分钟；付费 Skill、USDC、Session 自动化和 MCP 是可选扩展。

> 本项目当前是 Solana **Devnet preview**。只用 Devnet 测试钱包和测试资产。不要导入主网钱包助记词，不要把私钥、Session 备份或 API key 放进仓库、录屏或演示材料。所有链上交易都需要检查页面与钱包中的网络、金额、收款人和账户地址后再签名。

## 1. 演示会展示什么

评委将看到一条从自然语言计划到链上结算的完整路径：

1. 创建雇主 Agent，并发布 SOL、USDC 预算与权限。
2. 创建短期 Session，让 Agent 在更小的额度内签名。
3. 运行自然语言任务，先看到明确标记为模拟的计划，再人工复核一笔直接支付。
4. 创建第二个 Worker Agent，通过 Escrow 锁定任务资金；完成后释放资金。
5. 在 Marketplace 查看链上 Agent、成功任务量与 Reputation；在 Trace 查看 Execution、Escrow、交易签名和哈希承诺。
6. （可选）调用已注册的收费 Skill，或用 MCP 客户端读取相同的链上状态。

**界面上的 `PREVIEW` 卡片是本地演示数据。** 真正的链上对象会标注 `LIVE DEVNET`、显示 PDA，并可打开 Solana Explorer。Planner 提案本身不会发交易；只有单独复核并签名的操作才会动资金。

## 2. 准备清单

### 软件和网络

- Node.js 20.19 或更新版本、npm。
- Rust、Solana CLI、Anchor CLI 1.2.0（仅在需要自行构建或部署 Program 时需要）。
- 一个支持 Wallet Standard 的浏览器钱包，连接到 Solana Devnet。
- 可访问 Solana Devnet RPC；默认使用 `https://api.devnet.solana.com`。
- 评委演示电脑上可以同时运行网页、AgentOS Runtime，以及可选的 Skill provider。

自行构建 Program 时，Anchor/Solana CLI 还需要准备匹配版本的 SBF platform-tools 与 Rust toolchain。首次构建可能下载或更新 Rustup 管理的工具链；请在有网络、且允许 Rustup 更新其工具链目录的终端执行。普通 `cargo check` 只检查主机目标的 Rust 源码，不能替代 Anchor SBF 构建，也不能证明产物可部署。若团队已准备好 Devnet Program，可跳过本地构建和部署步骤。

本工作区当前安装了 `1.95.0-sbpf-solana-v1.57` 工具链。本机可以绕开 Rustup 的全局链接/卸载操作，单独编译 SBF：

```sh
SBF_TOOLCHAIN=1.95.0-sbpf-solana-v1.57
RUSTC="$(rustup which rustc --toolchain "$SBF_TOOLCHAIN")" cargo build-sbf \
  --manifest-path programs/agent_os/Cargo.toml \
  --tools-version v1.57 \
  --skip-tools-install \
  --no-rustup-override \
  --sbf-out-dir target/sbf-safe
```

这条命令已在当前工作区产出 `target/sbf-safe/agent_os.so`。当前机器的打包 SDK 缺少 syscall 清单，构建器因此会对标准 Solana syscall 打出“not known syscalls”警告；这证明 Rust 程序已编译成 SBF ELF，但不足以确认该文件可部署到目标集群。正式部署前仍须用与目标集群相匹配、syscall 清单完整的 Anchor/SBF SDK 构建，并检查部署预检结果。`target/sbf-safe/agent_os-keypair.json` 是构建器生成的临时地址材料；部署时只使用 `target/deploy/agent_os-keypair.json` 中与 `declare_id!` 和 `Anchor.toml` 同步的专用 Program keypair。

检查构建日志中的 `Error:` / `overflows the maximum allowed frame space` / `overwrites values in the frame`，不要仅根据命令退出码判断成功；SBF 构建器可能在报告栈空间错误后仍返回 0。本轮已将 USDC 协商结算的大型账户移到堆上，消除了该指令的 4 KiB 栈超限；工具链升级或后续链上改动后仍需重新检查日志。`npm run check:settlement` 可在本机运行协商权限、期限、签名参数编码和金额精度的 18 项回归检查；这些主机端检查不替代实链 Demo。

部署前先检查集群和 CLI 是否匹配：

```sh
solana cluster-version --url devnet
solana feature status --display-all --url devnet
solana --version
cargo build-sbf --version
anchor --version
```

2026-10-07 本机查询到 Devnet 为 `4.4.0-beta.0`，本机 Solana CLI 与 `cargo-build-sbf` 均为 `3.1.10`；Feature status 明确报告本机 CLI 的 feature set 与集群不一致。不要用这组旧 CLI 的 feature 列表判断目标版本是否已开放。Anza 的当前 SBFv3 兼容说明列出 `cargo-build-sbf` 4.2.0、Solana CLI 4.0.0 为最低版本，platform-tools v1.56 为推荐版本，并要求使用 `--arch v3`；部署前请按[官方兼容说明](https://github.com/anza-xyz/cargo-build-sbf#sbpfv3-migration)更新并匹配完整工具链。本文中的本机编译命令仅验证编译器能生成 SBF 文件，不是推荐的 Devnet 部署命令。

### 准备钱包

至少准备两个独立的 Devnet 钱包：

| 用途 | 建议代号 | 用途 |
| --- | --- | --- |
| 雇主与 Agent 所有人 | Wallet A | 创建 Research Agent、Vault、Session，发起支付和 Escrow |
| Worker 所有人 | Wallet B | 创建独立 Worker Agent，接收 Escrow 结算 |

如需展示独立 Skill Provider，再准备 Wallet C；也可以先用 Wallet A 注册 Skill。给每个会签名的钱包准备足够的 Devnet SOL，以支付账户租金和交易费。Agent Vault 里的 SOL 与所有人钱包里的 SOL 是两笔不同的余额：前者用于 Agent 支付/托管，后者用于签名交易的费用和账户租金。

如果要展示 USDC，还需要**确切的 Devnet 测试 USDC**，其 Mint 必须是：

```text
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

别用主网 USDC、其他 Mint 或 Token-2022 代替。没有此测试代币时跳过 USDC 环节，核心 SOL 演示不受影响。

### 两个易丢失的本地状态

- 浏览器本地记录 Agent 与支付/ Escrow 回执。Demo 时使用同一个浏览器 Profile 和 `http://127.0.0.1:5173` 地址，不要清浏览器存储。
- Session 私钥只驻留在创建它的当前标签页内存。演示期间不要刷新或关闭该标签页，也不要在该标签页切换到另一个钱包；给 Wallet B 使用另一个浏览器 Profile。启用加密恢复时，先下载备份并将文件与密码分开保存。

## 3. 一次性配置与启动

### 3.1 使用已有 Devnet Program

如果团队已有已部署的 Program ID，确认它部署在 Devnet，并把**同一个地址**填入 Runtime 与 Web 的配置。运行时只需第一次创建配置文件：

Worker result handoff、提前取消和双方协商结算需要包含 `submit_escrow_result`、`cancel_escrow`、`cancel_usdc_escrow`、`propose_escrow_settlement`、`accept_escrow_settlement_v2`、`accept_usdc_escrow_settlement_v2`、`refund_disputed_escrow` 与 `refund_disputed_usdc_escrow` 指令的新 Program 版本。v2 接受交易把复核时的提议人、Worker 金额和到期时间绑定到签名中；对方更新任一项后，旧交易会被拒绝。旧版 Program 不识别 v2 接受指令，请用相同 Program keypair 升级，并一起更新 Web 与 Runtime。协商提案单独保存在 `EscrowSettlement` PDA，不扩展 Escrow 账户布局；已存在的 Escrow/Settlement 账户可继续使用。

```sh
cp apps/runtime/.env.example apps/runtime/.env
```

在 `apps/runtime/.env` 中设置：

```dotenv
AGENTOS_PROGRAM_ID=<已部署的 Devnet Program 地址>
SOLANA_RPC_URL=https://api.devnet.solana.com
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
AGENTOS_PERSIST_HISTORY=false
AGENTOS_PERSIST_MEMORY=false
```

可选：填写 `OPENAI_API_KEY`，启用 OpenAI Planner 和 Research Skill provider；不填时 Runtime 使用无需密钥的确定性 Demo Planner。若所选模型不适用于你的 API 账号，把 `OPENAI_MODEL` 改成账号可用的模型。

创建 `apps/web/.env.local`，设置相同的 Program ID：

```dotenv
VITE_AGENTOS_PROGRAM_ID=<与 Runtime 完全相同的 Devnet Program 地址>
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
```

不要把实际 API key 或本地配置文件提交到 Git。修改任一 `.env` 文件后，重启对应服务。Web 在每笔交易发送前都会重新校验 RPC 的 genesis hash；非 Devnet endpoint 会被拒绝。

Runtime 与 Web 配置完成、且 Devnet Program 已部署后，在仓库根目录运行只读预检：

```sh
npm run preflight:devnet
```

预检会逐项比较 `declare_id!`、`Anchor.toml`、Runtime/Web Program ID，检查两处 RPC 的 Devnet genesis hash，并确认该 Program 在两处 RPC 上都是可执行账户。任一项失败时先按输出修正配置或部署状态，再继续启动。预检不会读取或输出私钥，不会创建密钥、申请 SOL 或发送交易；它也不验证 SBF 工具链与集群程序版本的兼容性，部署前仍需人工完成上方的工具链核对。

### 3.2 需要自行部署时

仓库当前已选定待部署地址 `HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv`，不代表 Program 已部署。当前工作区的对应 keypair 位于 `target/sbf-safe/agent_os-keypair.json`，请使用 [DEVNET_EVIDENCE.md](DEVNET_EVIDENCE.md) 的构建／来源核查流程，并用该 keypair 和同目录二进制部署；不要用另一目录的 keypair 执行 keys sync 覆盖已选地址。已有部署时先核对最新二进制。

以下流程适用于你明确另选 Program 地址、在另一台机器自行部署的情况；它会改变 Program ID，之后须同步前后端配置和证据：

1. 先让 Anchor provider 钱包指向专用的 Devnet fee payer；用 `solana config get` 确认 RPC 与钱包路径。给 fee payer 准备 Devnet SOL。
2. 在仓库根目录创建本地 Program keypair，并同步公开 Program ID：

   ```sh
   mkdir -p target/deploy
   solana-keygen new --outfile target/deploy/agent_os-keypair.json
   NO_DNA=1 anchor keys sync
   ```

3. 确认 `programs/agent_os/src/lib.rs` 的 `declare_id!` 和 `Anchor.toml` 中 localnet/devnet 的 `agent_os` 地址一致；按准备清单完成集群与工具链预检后，再构建并部署：

   ```sh
   NO_DNA=1 anchor build
   solana config set --url devnet
   solana airdrop 2
   NO_DNA=1 anchor deploy --provider.cluster devnet
   ```

   `solana airdrop` 为当前 Solana CLI 配置的钱包申请测试 SOL；Devnet 水龙头可能限流。若返回的部署地址和配置不同，先解决 ID/Program keypair 不一致，再启动 Web 与 Runtime。

4. 将部署输出中的 Program ID 写到前述两个环境文件，确保两边完全一致，然后重启服务。

`target/` 中包含本地密钥材料，切勿分享 `agent_os-keypair.json`、fee payer keypair 或助记词。不要为沿用现有部署而重新生成 Program keypair；这样会得到另一个 Program ID。

### 3.3 安装依赖并启动

在仓库根目录运行：

```sh
npm install
npm run dev
```

保持这个终端运行。它会同时启动：

- 网页：<http://127.0.0.1:5173>
- Runtime API / MCP：<http://127.0.0.1:8787>

检查 Runtime：

```sh
curl http://127.0.0.1:8787/api/health
```

应返回 `ok: true`、`network: "devnet-preview"`。没配 OpenAI key 时，`mode` 为 `simulation`；配好并重启后应为 `openai`。打开网页后，连接 Wallet A，确认顶部显示钱包地址和 Devnet SOL 余额。

## 4. 推荐评委演示流程：Agent → Payment → Escrow → Reputation

建议预先准备钱包余额、Worker Agent 地址，并把页签打开。所有按钮名称按当前英文界面列出。

### 第一步：创建雇主 Agent

1. 在 Wallet A 的浏览器 Profile 中打开网页并连接 Wallet A。
2. 在 `Overview` 的 Agent 卡片点击 **Create Agent**。
3. 可以使用默认值：`Research Agent`、SOL 日限额 `1`、SOL 单笔限额 `0.25`、USDC 日限额 `10`、USDC 单笔限额 `1`，并保留三项能力：`Paid API calls`、`Direct payments`、`Agent hiring + escrow`。
4. 点击 **Review transaction**，检查 Network 为 Devnet、Program ID 和创建的 Agent/Policy/Reputation PDA，再在钱包弹窗中签名。
5. 回到 Overview，确认 Agent 状态为 Active，Vault 余额为链上读数（此时通常为 0）。创建 Agent 不会给 Vault 自动充值。

若更改了 Policy 页面中的限额或权限，点击 **Publish to Devnet** 并签名；页面上的本地草稿会立即影响 Planner，但只有发布后的值才是链上策略。

### 第二步：准备 Worker Agent

1. 在另一个浏览器 Profile 连接 Wallet B。
2. 在 `Overview` 点击 **Create Agent**，名称可用 `Research Worker`，保留 `Agent hiring + escrow`。默认策略足以接收本 Demo 的工作。
3. 检查创建交易并用 Wallet B 签名。记录 Worker Agent PDA（Marketplace 的 Agent 卡片也会显示完整地址）。
4. 保持 Wallet B 的 Profile 与 Wallet A 分开。回到 Wallet A 的 Profile；Wallet A 的 Session signer 不能通过切换钱包恢复。

Worker Agent 只需创建，不必预先充值 Vault。释放时 USDC Worker token account 会由交易创建；SOL 直接结算至其 Agent Vault PDA。Wallet B 负责在链上提交 Worker completion hash，Wallet A 仍负责最终是否释放资金。

### 第三步：给雇主 Vault 充值并创建 Session

1. 在 Wallet A 的 `Overview` 点击 **Deposit SOL**，充值建议 `0.10 SOL`；检查目标是 Agent Vault PDA，不是另一钱包，然后签名。
2. 打开 `Policy`，点击 **Create session**。
3. 核心手动演示建议使用默认 `Expires in 24 hours`，`Max per action 0.15 SOL`、`Maximum total spend 0.5 SOL`，USDC per-action `0.1`、Session total `1`，并保留与 Agent Policy 相同的三项权限。
4. **手动演示**请不要勾选 `Let this Session pay network fees and account rent` 或任何 `Allow Run Agent ... automatically` 选项。这样每笔操作仍经过页面复核，交易费由 Wallet A 支付。自动雇佣演示需要开启 fee sponsorship 和单独的 `Allow Run Agent to fund Worker Escrows automatically`，并在创建 Session 后先下载加密备份、再充值 Session fee reserve。
5. 点击 **Review transaction**，检查 Session address、有效期、权限与上下限，再用 Wallet A 签名。Session key 在当前标签页内存中生成；不要刷新页面。

### 第四步：展示 Planner 提案和直接支付

1. 先在 Marketplace 或 Overview 复制 Wallet B 的收款地址（也可用任意已准备好的 Devnet 收款地址）。
2. 打开 `Agent trace`，在任务框输入下面这条明确包含数额、资产和收款地址的请求：

   ```text
   Send 0.01 SOL to <Wallet B 的钱包公钥>
   ```

3. 点击 **Run task**。在无 OpenAI key 的默认模式下，Runtime 会用本地 Demo Planner 产生 `Direct payment` 提案；该阶段是模拟，不会移动资金。
4. 在对应事件点击 **Review direct payment**。核对收款人是 Wallet B、金额是 `0.01 SOL`、网络为 Devnet，然后确认页面交易审阅并在 Wallet A 钱包签名。
5. 等待确认后，检查 Trace 里的交易链接、Execution PDA 与 Overview 活动记录。还可以打开该交易链接和 Execution account 的 Devnet Explorer 页面。

如果出现 `DENIED` 或没有 Review 按钮，先检查 Agent/Policy/Session 是否 Active、是否允许 `Direct payments`，以及 Vault 余额、Agent 日限额、单笔上限、Session 总额和 Session 有效期。直接支付的离线解析格式是 `Send <amount> SOL|USDC to <base58 address>`；金额和收款地址不要省略。

**可选安全演示：触发 Policy denial。** 保持默认 Demo Planner（不要配置 `OPENAI_API_KEY`），点击任务建议 **Test policy limits**，运行预填的恶意请求。预期 Trace 出现 `Untrusted transfer request blocked` / `DENIED`，原因包含 8 SOL 超过当前 SOL 单笔额度；没有付款 Review 按钮、链上签名或资金移动。这一步展示规划阶段的拒绝路径；它不会构造并提交一笔超限交易。真正提交的交易仍会在页面复核时重新读取 Devnet Policy、Session 与余额，最终由 Solana Program 执行链上权限和额度校验。

### 第五步：创建、释放 Escrow 并展示 Reputation

1. 确认 Wallet A 的 Agent 与 Session 都允许 `Agent hiring + escrow`，并且 Vault 至少有 Escrow 金额；本手册用 `0.02 SOL`。
2. 在 Wallet A 的 `Policy` 点击 **Create agent Escrow**，或在 `Marketplace` 找到 Wallet B 的 Worker Agent 后点击 **Hire with Escrow**。
3. 在 `Create an Agent Escrow` 表单中核对 Worker Agent 地址，填 `Native SOL`、金额 `0.02`、deadline `24` hours；写一条可展示的任务，例如 `Prepare a short summary of the Solana DeFi ecosystem.`。Task 描述会留在浏览器本地，链上保存它的 SHA-256 commitment。
4. 点击 **Review transaction**。核对雇主/Worker Agent、数额、截止时间、任务、Escrow PDA、租金和 fee payer，再用 Wallet A 签名。该支出由 Agent Vault 承担；交易费与 Escrow/Execution 账户租金由 Wallet A 承担。
5. 在 Wallet A 的 Trace 向下找到 **LOCAL BROWSER RECEIPTS**，对刚创建的回执点击 **Share task with local Runtime**，确认任务正文已核对并分享。保持 Wallet A 的标签页打开，然后切到 Wallet B 的浏览器 Profile 并连接 Wallet B。在 **On-chain Escrow states** 中找到该笔 incoming `FUNDED` Escrow，点击 **Submit result → Load verified employer task**。两个 Profile 需使用同一个本地 Runtime。
6. 检查已加载的任务文本与哈希成功提示；也可以手动粘贴雇主分享的完整任务文本。填写结果，例如 `Delivered a concise protocol summary with cited observations.`。AgentOS 会先校验任务文本 SHA-256 与链上 commitment 一致；Review 中会显示待分享给雇主的结果原文和结果 SHA-256。由 Wallet B 检查并签署这笔 Worker submission 交易。只有结果哈希上链，任务和结果正文不会上链。
7. 在 Wallet B 的 Trace 向下找到 **LOCAL BROWSER RECEIPTS / Escrow transaction history**，点击该笔结果回执的 **Share texts with local Runtime**。这会把任务和结果正文交给本地 Runtime；Runtime 重新读取 Devnet，核对 Program、Escrow PDA 和两个 SHA-256。看到分享成功提示后，切回保留 Session signer 的 Wallet A 标签页，刷新 Trace，点击 **Review release → Load verified Worker handoff**。任务和结果将自动填入，网页通过独立的链上读取再次核对哈希。两个 Profile 必须连接同一个 Runtime。未分享、Runtime 重启、两端运行于不同电脑或读取失败时，仍可手动粘贴完整任务和结果原文。
8. 可选：点击 **Ask AI Judge**。需在 `apps/runtime/.env` 配置 `OPENAI_API_KEY`。Judge 会按任务文本检查结果，给出 PASS、FAIL 或 NEEDS REVIEW、逐项意见和来自结果原文的证据；评估会显示链下 SHA-256。它只提供建议，不上链、不签名，也不会自动释放或退款。
9. 核对雇主、Worker、金额和已验证的任务/结果哈希。雇主自行判断是否接受结果；Session key 授权释放，Wallet A 支付交易费；确认并签名。链上 Escrow 转入 Released，Worker Reputation 同一笔交易内更新。
10. 刷新 Marketplace，检查 Worker Agent 的 `successful Escrow releases`、released volume 和 reputation score 已变化；Trace 会显示链上 task/result commitments、Worker 提交、释放与 funding 交易，以及关联的 funding Execution（适用于新版本 Escrow）。

Worker 必须在截止时间前提交一次结果；提交后不能覆盖。雇主可以核对结果并决定释放，也可以不释放并在到期后退款。Worker 未提交结果时，链上程序会拒绝释放。过期退款可由 Employer 或 Worker Profile 发起，会退回雇主 Vault，不增加 Worker Reputation。可选 AI Judge 会比较任务与结果，但输出仅是可复算哈希标识的链下建议；它不证明结果正确，也不改变链上授权条件。

**可选演示：不同电脑或独立 Runtime 的任务／结果交接。**

1. 雇主和 Worker 分别启动自己的网页。两端都配置相同 Devnet Program ID，并能读取 Devnet。该交接路径不要求共用 Runtime，也不要求 OpenAI Key。
2. 雇主创建 Escrow 后，在 **LOCAL BROWSER RECEIPTS** 点击 **Download verified task handoff**。浏览器会核对任务原文与当前链上哈希，下载 `agentos-task-….json`。
3. 由你手动把文件传给 Worker。在对应 Escrow 的 **Submit result** 中，使用 **Import task/result handoff file** 选择文件。Worker 网页通过自己的 RPC 核对 Program、canonical Escrow、双方 Agent 和任务哈希，成功后填入任务字段。无需点击本地 Runtime 的加载按钮。
4. Worker 完成任务，审核并签署结果 commitment。在自己的结果回执中点击 **Download verified result handoff**，手动把 `agentos-result-….json` 发回雇主。结果文件包含双方正文及公开承诺，不包含私钥。
5. 雇主进入同一笔 Escrow 的 **Review release**，选择收到的结果文件。两段正文和结果哈希核对成功后才填入表单；可选 AI Judge、释放与 Memory 保存仍需按原流程分别操作。
6. 可向评委演示错误拒绝：导入另一笔 Escrow 的文件，或修改文件中任一任务/结果字符但保留原哈希，应显示错误且保留原表单输入。仅有任务的文件不能替代 Worker 结果文件；Session recovery file 和 Runtime 的整个存储文件也不属于此格式。
7. 交接文件为明文，最多 20 KB，每段正文最多 400 字符。导入不会自动上传到 Runtime，也不会自动付款。不要把文件当作带私钥的钱包备份；若要重新用本地共享流程，仍需单独点击分享按钮。

**可选演示：Worker 使用 AI 草稿辅助完成文本任务。**

1. 在 Runtime 配置 `OPENAI_API_KEY` 和当前账户可用的 `OPENAI_MODEL`，重启服务。无需新增 Worker Session；签署结果仍由 Worker owner 钱包执行。
2. 雇主创建一笔新的小额 Escrow，例如任务 `Summarize the supplied AgentOS demo notes in two sentences.`，按前述流程分享任务。
3. Worker 点击 **Submit result → Load verified employer task**，在 **Optional source notes for AI draft** 填入自己核对过的资料。可用当前实现的描述：`The dashboard displays Agent Policy and Session budgets. Task text stays off-chain while its hash is committed on Devnet. Employers review Worker results before releasing escrow funds.`
4. 点击 **Generate AI draft**。页面明确提示任务和资料将发给配置的 OpenAI 模型；不会触发链上交易。等待草稿、模型名称、限制说明和资料原文引用。Runtime 会核对引用确实来自资料，但不证明资料事实正确。
5. 检查草稿，点击 **Use draft in result field**，按需修改，使结果真实反映已完成工作。再点击 **Review Worker submission** 并签名；随后分享结果，交由雇主审核、可选 AI Judge、释放及保存 Memory。
6. 若任务需要联网研究、工具执行或缺少资料，模型应返回 **More evidence required**。此时没有“使用草稿”按钮；补充资料重试，或自行完成工作后手动填写。不能将模型的文字当成已执行工具或已完成交易的证明。
7. 未配置 Key、模型拒绝、返回不完整/超长内容、任务正文不匹配、已提交结果或期限已过时，页面显示错误，原有手工结果输入保留。若任务在生成期间失效，Runtime 的第二次链上检查也会拒绝返回草稿。

**可选演示：Worker 基于真实付费 Skill 结果生成交付草稿。**

1. 在 Wallet B 的 Worker Agent 下创建用于 Skill 的 Policy/Session，充值其 Vault。按付费 Skill 演示执行一次 Research 或 Weather Skill，检查 x402 settlement、结果正文和 Execution。该笔 Skill 费用由 Worker Vault 支付，与雇主 Escrow 的托管余额分开。
2. 记录 Skill 结果哈希，并在结果窗口点击 **Save to Memory**；或使用之前显式开启的自动记录/保存选项。仅支付但未记录结果，或未保存 Memory 的输出，不会出现在可选资料列表。
3. 创建/选择一笔适合总结该输出的雇主 Escrow。Worker 打开 **Submit result**，加载任务，点击 **Refresh Skill results**。列表只显示当前 Worker 最近保存的 Skill Memory；最多选三项。若未出现，核对 Worker Agent、结果完成状态、Memory 保存状态并刷新。
4. 不必把结果复制到手工资料框。直接选中 Skill 结果，点击 **Generate AI draft**。Runtime 从自己的 Memory 获取完整正文并重新验证链上哈希，再取每项前 2,000 字符供模型使用。
5. 草稿区域会显示每项 source 的 **Verified Skill Execution** 链接、完整正文 SHA-256、使用字符数与是否截取。展开 **View supplied Skill excerpt** 检查模型真正拿到的片段。原始结果较长时，模型没有看到截取范围之外的内容；必要时在手工资料框补充已核对的摘要。
6. Worker 审阅草稿后复制到结果框、修改、签名提交，雇主按现有交接、验收、释放与 Memory 步骤继续。已付款工具输出的哈希一致，不等于输出事实正确或雇主任务已经完成。
7. API 的 `sourceExecutions` 不能借用雇主或另一 Worker 的 Memory，不能引用 Payment、待完成 Skill 或协商结算结果。选中的正文或 source 标记与链上 Execution 不一致时会报错，模型不会收到该项资料。默认 Memory 在重启后清空；如需保留，单独启用 `AGENTOS_PERSIST_MEMORY=true`。

**可选演示：将 Skill 证据清单与 Worker 结果一起签名上链。**

1. 用同一 Program keypair 升级部署包含 `submit_escrow_result_with_sources` 的新 Program，并更新 Web。旧部署不识别该指令；未升级时保持新选项关闭，普通结果提交仍可使用。当前 SBF 构建完成，但本机 SDK 仍有既有 syscall 警告，不能仅凭构建退出码认定可部署；按前述部署章节确认链上运行。
2. Worker 先完成 Skill 调用、记录结果哈希并保存 Memory。在 **Submit result** 中选择一至三项 Skill 资料，生成/审核草稿或手写交付结果。
3. 勾选 **Bind selected Skill proofs to this result on chain**。这个选项默认关闭；它需要 Worker owner 钱包额外支付 `EscrowEvidence` PDA 的租金。该账户保存 Escrow、这次结果哈希、Skill Execution 地址及其输出哈希，不保存结果或资料正文。
4. 点击 **Review Worker submission**，核对结果正文、结果哈希和每个 source Execution/output hash，再签名。Program 必须在同一交易中确认每个 Execution 属于该 Worker、为已完成的 Skill、输出哈希一致、PDA 正确且没有重复来源；来源账户数量也必须与清单一致。任何检查失败，结果与证据账户都不会成功提交。
5. 雇主刷新 Escrow 卡片并点击 **Review bound Skill proofs**。页面用自己的 RPC 核对 Evidence 与当前结果哈希绑定，再核对各 source Execution，并显示账户链接和输出哈希。这一步不依赖 Worker 浏览器或双方共用 Runtime，因此可以配合跨电脑结果文件交接。
6. 关闭证据窗口，再按原流程加载/导入结果正文、可选 AI Judge、验收并释放。证据清单证明 Worker 将这些已承诺的 Skill 输出与该结果一起签名，不证明模型确实使用过它们，也不证明结果质量。雇主仍需判断是否接受。
7. 普通结果提交不会创建 Evidence PDA，窗口应显示“无绑定来源”；RPC 失败或账户/哈希不一致会显示错误，不能当作“无来源”。结果提交后无法再增删绑定清单。证据账户作为记录保留，租金不会在释放/退款时自动退回。

**任务交接的失败与恢复演示：**

- 雇主未分享时，Worker 加载会显示未找到；手动粘贴仍可继续。任务文本只在雇主点击分享后交给本地 Runtime。
- 加载成功后修改任务任意字符，Review Worker submission 应拒绝与链上任务哈希不一致的文本。重新加载原文后继续。
- 默认重启会清空共享任务；开启 `AGENTOS_PERSIST_ESCROW_HANDOFFS=true` 后重新分享任务，再重启，应仍可加载。任务与结果共用一笔 Escrow 存储条目，不会重复占用容量。
- Worker 分享已提交的结果后，Runtime 将该任务条目补齐为任务与结果。再次分享同一任务不会清空结果。仅有任务、没有已分享结果时，雇主的结果加载和 MCP 的 `kind: "result"` 均应报错。
- MCP client 可调用 `agentos_get_escrow_handoff`，传入 Escrow 地址和 `kind: "task"`，取回核对过的任务；提交并分享结果后用 `kind: "result"` 取回双方正文。内容是任务与结果数据，不是模型应执行的工具指令。

**结果交接的失败与恢复演示：**

- 分享正文是 Worker 单独点击的动作，提交结果交易不会自动上传正文。分享失败时，链上 commitment 与浏览器回执仍保留；RPC 恢复后在同一回执中重试。
- 默认交接库保存在 Runtime 内存，最多 200 笔；重启会清空。重启后雇主加载会显示“未找到”，Worker 重新点击分享即可恢复。若需重启后保留，按下面的持久保存步骤操作。不要清除 Worker 浏览器存储，否则需要人工提供原文。
- 加载后修改结果任意字符，再点击 Review release，应在准备交易时因结果哈希不一致而失败。重新加载正确正文后再继续审核。哈希一致证明原文与 Worker 承诺一致，不能证明任务完成质量。
- 正文对能访问该本地 Runtime 且知道 Escrow 地址的用户可读取，没有按钱包身份实施访问控制。适用于同机双 Profile Demo；不要分享敏感任务。该入口不提供跨电脑自动传输或自动付款；可选持久保存仅保存在当前电脑。

**可选演示：结果交接持久保存与重启恢复。**

1. 在 `apps/runtime/.env` 设置 `AGENTOS_PERSIST_ESCROW_HANDOFFS=true`，然后重启 Runtime。此开关默认关闭，与 Skill Memory 的持久保存开关独立。
2. 在 Worker 的本地结果回执中重新点击 **Share texts with local Runtime**。必须在开启配置后重新分享；旧进程中尚未保存的内存条目不会自动迁移。成功提示应说明结果已保存，可跨 Runtime 重启保留。
3. 重启 Runtime，保持两个浏览器 Profile 打开。雇主再次点击 **Review release → Load verified Worker handoff**，应取回相同任务和结果；提示说明已通过 Devnet 校验且本地持久保存已开启。即使正文来自文件，RPC 不可用或链上哈希不匹配时也不会返回“已验证”结果。
4. 文件位于 `apps/runtime/.data/escrow-handoffs.json`，不纳入 Git。正文以明文保存，临时文件以仅当前操作系统用户可读写的权限创建后原子替换。不要把该文件作为公开 Demo 附件。
5. 若文件被破坏，分享或加载会显示恢复错误，原文件不会被自动覆盖。先停止 Runtime、将原文件改名备份，重新启动后由 Worker 从浏览器回执重新分享。存储满 200 笔时也可用此方式归档；默认内存模式则重启即可清空。
6. 将开关改回 `false` 并重启只会停止读取和写入文件，不会删除已有文件；再次开启后仍会读取此前保存的内容。

**可选演示：将验收结果保存到雇主 Memory，并在后续任务复用。**

1. 先完成结果验收和释放，刷新 Wallet A 的链上 Escrow 卡片，确认显示 `RELEASED`。这笔 Escrow 必须是带 funding Execution 的新版本记录；旧版没有关联 Execution 的 Escrow 不提供此按钮。
2. 点击 **Save accepted result to Memory**。应用读取最新 Escrow，从雇主浏览器回执取出验收时的原文；若该浏览器没有原文，则尝试加载 Worker 已分享的本地 handoff。无正文时先让 Worker 重新分享，再重试。保存是单独的本地动作，不再发送付款交易，也不要求有效 Session。
3. 成功后查看 **Agent Memory**，应出现 `Accepted Worker result · Escrow #…`，来源为 **Accepted Worker result**，并显示 result hash 和 Execution proof。Runtime 会重新核对 canonical Execution PDA、Agent、完成状态和 output hash。
4. 在后续任务中使用相同雇主 Agent，Memory 会通过既有规划上下文进入后续规划。也可以用 MCP 的 `agentos_search_memory` 搜索结果中的关键词；`agentos_remember_execution` 可通过 Agent、funding Execution 和完全一致的结果正文执行相同保存。
5. `FUNDED`、`REFUNDED`、`CANCELLED`、`SETTLED` 和等待协商的结果不得作为已验收 Memory。前端仅对 `RELEASED` 开放保存，Runtime 同时要求 Execution completed 且 output hash 匹配；结果只提交、尚未释放时没有符合条件的 output hash。
6. 如需 Memory 跨 Runtime 重启保留，另行开启 `AGENTOS_PERSIST_MEMORY=true`。它与 `AGENTOS_PERSIST_ESCROW_HANDOFFS` 相互独立。链上承诺只能证明结果字节一致与雇主已释放资金，不能证明内容真实或判断正确。

**可选演示：Worker 提前取消任务。** 在 Wallet B 的 Worker Profile 中，找到仍为 `FUNDED`、未提交结果且尚未到期的 incoming Escrow，点 **Cancel task** 并由 Wallet B 签名。SOL 或 USDC 会原子退回雇主 Agent Vault，链上状态显示为 `CANCELLED`；该取消不会增加 Worker Reputation。结果提交后不允许 Worker 取消，届时由雇主释放或等待到期退款。

**可选演示：双方协商争议结算。** 使用不同的 Wallet A/B owner，并确保 Program 已升级到 v2 接受指令。

1. 由 Wallet A 创建一笔 `0.02 SOL`、原期限未结束的 `FUNDED` Escrow；双方分别打开自己的 Trace。
2. 任一方点 **Propose settlement**，例如填写 Worker 应收 `0.008 SOL`，余款 `0.012 SOL` 退回雇主。金额可以为零或全额；USDC 最多六位小数，SOL 最多九位小数。核对提案 PDA、初始 72 小时窗口和租金后签名。
3. 刷新双方 Trace。卡片直接展示 Worker/Employer 分账、提议钱包、窗口结束时间和 **View current proposal** 链接。同一信息可由 MCP 的 `agentos_list_escrows` 读取：`settlement.workerAmount` / `employerAmount` 为资产最小单位字符串，`settlement.deadline` 为 Unix 秒数。读取失败时显示 `settlementReadError`，不要把它当作没有争议。
4. 另一方点 **Review / counter split**。可接受当前金额，或修改 Worker 金额并点 **Review counter-split** 发送反提案；新的提案仍需要另一方接受。首次提案必须在原任务期限前开始，之后反提案可在完整的协商窗口内继续；反提案不会延长窗口，复用现有 PDA 也不会再次收取提案账户租金。
5. 点击 **Accept current split** 后会再次展示最终交易复核。该交易签入提议人、Worker 金额和到期时间；从打开窗口到准备交易之间发生变化，页面会要求关闭再打开，从复核到链上执行之间发生变化，Program 会拒绝旧交易。
6. 接受成功后，SOL/USDC 分账在同一链上交易完成，双方 `disputes` 各增加 1，成功任务量/分数不增加，Escrow 显示 `SETTLED`。刷新 Marketplace 查看双方的 `mutual settlements` 计数。
7. 如需展示改价保护，可让 Wallet B 在步骤 5 保持旧交易复核窗口，再由 Wallet A 把其原提案从 `0.008` 改为 `0.009 SOL` 并确认。Wallet B 随后确认旧交易时，应在模拟或链上被拒绝，资金保持托管；关闭窗口，刷新并重新复核新金额。
8. 超时分支需提前至少 72 小时准备一笔未达成一致的提案；现场演示使用该记录。窗口结束后退款按钮从禁用变为 **Refund to employer**。任何连接钱包都可发起，资金全额退回雇主 Agent Vault。到期后接受和反提案都不可用；首次提案租金返还给接受方或超时退款发起人。AI Judge 仅提供链下建议，不会授权此结算。

**可选演示：Session 自动创建 Worker Escrow。** 请使用余额充足的 Wallet A Vault、有效的 Agent Policy/Session，且不要复用需要全程手动审阅的主流程 Session。创建 Session 时保留 `Agent hiring + escrow` 权限，启用加密备份、Session fee sponsorship 和 `Allow Run Agent to fund Worker Escrows automatically`；创建后先下载并保存加密备份，再向 Session fee reserve 充值。Worker Profile 必须有 Active Agent。然后在 `Agent trace` 输入明确包含 Worker 任务、SOL 或 USDC 金额、资产和期限的雇佣请求。每次 Run Agent 最多自动提交一笔 Escrow；只有 Planner 返回有效 Worker 且 Runtime 确认金额、资产和期限都与用户原文中的明确条款一致时，才会尝试自动托管。应用会再次读取链上 Agent、Worker、Policy、Session 和 Vault，并检查余额、支出限额与 Session 租金储备。Trace 显示已签名交易后，检查新建 Escrow 的 `FUNDED` 状态。自动模式只负责创建并注资 Escrow；Worker 提交结果和 Employer 释放仍按前述流程分别由 Wallet B、Wallet A 处理。如果该提案缺少任一明确条款或检查失败，就不会提交该笔 Escrow，页面会保留错误信息供修正。

## 5. 可选演示：付费 Skill 与 x402 provider

建议使用 Weather provider 做可重复的本地演示；它请求 NWS 的公开美国天气预报，无需 OpenAI key。Skill payment 会真实结算，provider 请求可能在支付后失败，因此价格设低并使用 Devnet。

### 5.1 注册 Weather Skill

1. 以 Skill provider 钱包（推荐 Wallet C；也可用 Wallet A）连接网页，打开 `Marketplace`。
2. 在 **On-chain Skill Registry** 点 **Register a Skill**，填 Skill ID `weather`，Endpoint **精确填写** `http://127.0.0.1:8788/weather`。不要增删尾部斜线或改端口。
3. 设置较小的正 SOL 价格（例如 `0.001`），USDC 价填 `0`；点击 **Review transaction**，确认 provider 钱包地址、Rent 与 endpoint commitment 后签名。
4. 从新注册的 Skill 卡片抄下 Skill PDA。将其写入 `apps/runtime/.env` 的 `AGENTOS_WEATHER_SKILL`。
5. 重启 `npm run dev`（使 Runtime 重新读 `.env`），然后在另一个终端从仓库根目录启动：

   ```sh
   npm run dev:weather-provider
   ```

   保持两个终端都运行。provider 默认监听 `127.0.0.1:8788`；若更改端口，链上注册的 URL 必须同步更改。

### 5.2 从网页发起已复核 Skill 调用

1. 回到 Wallet A 的 Profile，确认 Agent Active、Session 有 `Paid API calls` 权限、Agent Vault 有足够的 SOL。
2. 打开 `Marketplace` 并等待 `On-chain Skill Registry` 刷新，找到 active 的 `weather`。点 **Pay SOL**。
3. Endpoint 填 `http://127.0.0.1:8788/weather`，Request 填 `weather 39.7456,-97.0892`，点击 **Review SOL payment**。
4. 浏览器先校验 URL 的 SHA-256 与链上 commitment，再取得 provider 的 x402 challenge 并检查价格、provider、Skill、Program 与 request hash。确认金额正确后，在 transaction review 中签名。
5. 支付确认后，浏览器附带链上 Execution proof 调用 provider。成功时查看天气内容、付款交易和 Execution。若弹出 **Review result hash**，可进一步确认一笔只记录响应字节哈希、不转移资金的交易；然后可选 **Save to Memory**。

付款确认后服务调用失败时，已经确认的 Skill fee 不会自动退回。Weather provider 的坐标需要落在 NWS 服务范围内；展示中断时可回到核心支付/Escrow Demo，不要重复支付尝试。

### 5.3 Research provider 与 OpenAI Planner（可选）

1. 在 `apps/runtime/.env` 设置 `OPENAI_API_KEY` 和可用的 `OPENAI_MODEL`；该密钥只放在 Runtime，不要填到 Web 环境变量。
2. 用 provider 钱包在 Marketplace 注册 Skill ID `research`，Endpoint 精确填 `http://127.0.0.1:8789/research`，设置小额正价格。将该 Skill PDA 填入 `AGENTOS_RESEARCH_SKILL`。
3. 重启 `npm run dev` 后，在另一个终端运行 `npm run dev:research-provider`。
4. 等待页面运行模式变成 OpenAI 后，从 Marketplace 的 Research Skill 发起已复核支付，或在 Agent Trace 提交一条明确提到该注册 Skill 的研究任务。provider 在链上付款证明验证后使用 Responses API web search；最终摘要还会再调用 OpenAI。

API key 可能产生 OpenAI 费用；这笔 API 费用与 Skill 链上价格是两笔独立支出。OpenAI 和 provider 输出是未验证事实的外部内容；链上 hash 证明字节没有变化，不证明内容正确。

## 6. 可选演示：Session 自动化

核心评委演示建议先走上面的人工复核流程。若要演示免逐笔钱包确认的自动化，需要更严格的准备：

1. 创建 Session 时勾选 **Allow encrypted recovery backup**、**Let this Session pay network fees and account rent**，并按演示内容选择 `Allow Run Agent to submit direct payments automatically` 或 `Allow Run Agent to pay registered Skills automatically`。
2. 点击 **Review transaction** 并完成 Session 创建。之后在 `Policy` 点 **Download encrypted recovery file**，使用至少 12 字符密码，下载文件并将文件与密码分开保存。
3. 确认备份下载完成后，点 **Fund Session fee reserve**，例如向 Session 充值 `0.02 SOL`。Session reserve 用来支付后续自动交易的网络费和租金；它与 Agent Vault 预算分开。
4. 自动 Skill 还要求先手动完成一次该 endpoint 的验证/支付，令其确切 URL 保存到当前浏览器对应该 Agent 的本地设置。若启用 result hash 自动记录，需要 Session API 权限；自动保存 Memory 还必须启用自动 hash 记录。
5. 在 `Policy` 检查自动选项状态，并在 Trace 点击 **Run task**。每笔候选付款仍会重新读取链上 Policy、Session、Vault、价格与限制，但不会再次弹出钱包签名。

如页面刷新或换浏览器 Profile，使用已下载备份通过 **Restore Session from backup** 恢复；没有有效 signer 时自动功能不会工作。演示后先点 **Return reserve to connected wallet**，再 **Revoke Session**。启用自动化后，**Pause Session automations** 会阻止后续自动提交；已经发出的交易仍可能确认。

## 7. 展示链上 Trace、Memory 和 MCP

### Agent Trace

- `On-chain Execution records`：看每条 Execution 的 ID、输入/输出 SHA-256、最新确认时间和交易链接。新 Escrow release/refund 也会回写 funding Execution 状态。
- `On-chain Escrow states`：看 FUNDED/SETTLEMENT_PROPOSED/SETTLED/RELEASED/REFUNDED/CANCELLED、Worker、期限、task/result hashes 和最近交易。协商中的卡片直接显示 Worker/Employer 分账、提议钱包、窗口结束时间和提案账户链接；窗口未结束时退款按钮禁用。若提案读取失败，卡片显示原因；刷新后再核对。链上没有任务原文。
- Escrow 列表中的 **Copy** 控件可复制 commitment；打开 Solana Explorer 可核实交易/账户。
- `Agent Memory` 只显示 Runtime 保存且与 Devnet Execution 输出哈希匹配的内容。Memory 是本机 off-chain 内容，不会写入 Solana。

### MCP

Runtime 同时在 `http://127.0.0.1:8787/mcp` 提供本机 Streamable HTTP MCP endpoint。评委的 MCP client 必须与 Runtime 在同一台电脑。连接后可按以下顺序调用工具：

1. `agentos_runtime_status` 确认 Runtime mode 和配置。
2. `agentos_list_agents`、`agentos_list_escrows`、`agentos_list_executions` 读取刚才演示的链上结果。
3. 将 Trace 中的 PDA 传给 `agentos_get_escrow_transactions`，参数例：`{"escrow":"<Escrow PDA>","limit":5}`；或传给 `agentos_get_execution_transactions`，参数例：`{"execution":"<Execution PDA>","limit":5}`。
4. 可调用 `agentos_plan_task` 查看结构化的 policy-aware 计划，或读取 `agentos://devnet/escrows`、`agentos://devnet/executions` 资源。

MCP 目录与交易查询是只读工具；不会联系 Skill endpoint、签名、创建 Escrow 或转移资金。所有链上操作仍在网页的复核流程中完成。

## 8. Demo 前检查与故障排查

### 演示前 5 分钟

- [ ] Runtime `GET /api/health` 返回 `ok: true` 和 `devnet-preview`。
- [ ] Web 与 Runtime 使用相同的已部署 Program ID；钱包连接 Devnet。
- [ ] Wallet A 有足够 SOL 支付创建账户租金/交易费；Agent Vault 有足够的演示支出。
- [ ] Wallet A 的 Agent、Policy、Session 都是 Active，权限和额度覆盖 demo 金额。
- [ ] Wallet B 的 Worker Agent 已创建，地址已记录。
- [ ] 若演示 Skill，endpoint URL 与注册 URL 逐字一致，provider 终端正在监听。
- [ ] Session signer 所在页签未刷新；自动化 Demo 已下载备份并给 reserve 充值。
- [ ] Explorer 以 Devnet 显示；准备好把 Execution/Escrow PDA 链接展示给评委。

### 常见问题

| 现象 | 检查项 |
| --- | --- |
| 页面无法打开 / Runtime 离线 | 确认根目录 `npm run dev` 仍在运行；Web 为 5173，Runtime 为 8787；端口被占用时停止旧进程。 |
| `anchor build` 在 `uninstalling toolchain` / `Operation not permitted` 处停止 | Anchor 正在替换 Rustup 管理的 SBF toolchain，但当前终端不能写入 Rustup 工具链目录。若本机已有与缓存 platform-tools 匹配的 SBF Rust toolchain，可按准备清单中的命令仅做 SBF 编译；其产物仍须用完整 SDK 和目标集群预检后才能部署。否则在可管理本机 Rustup 的终端构建，并确认 Anchor、Solana CLI 与 platform-tools 版本相容；不要删除仓库里的 Program keypair。 |
| 提交交易前提示 RPC 不是 Devnet | 把 `VITE_SOLANA_RPC_URL` 改成 Devnet RPC，重启 Web；不要为了绕过提示改用主网。 |
| 钱包余额显示 `Unavailable` | Web 无法通过 RPC 的 genesis hash 校验。检查 `VITE_SOLANA_RPC_URL` 是可访问的 Devnet endpoint，再重启 Web。 |
| Runtime 提示 Program ID 与 Web 不匹配 | 将 Runtime `.env` 的 `AGENTOS_PROGRAM_ID` 和 Web `.env.local` 的 `VITE_AGENTOS_PROGRAM_ID` 设为完全相同、且已部署到 Devnet 的地址；重启两个服务。 |
| 看不到链上 Agent、Skill 或 Escrow | 检查钱包网络、`VITE_AGENTOS_PROGRAM_ID` 与 `AGENTOS_PROGRAM_ID` 是否一致、Program 是否部署到 Devnet；重启服务并重新打开相应页面。 |
| 签名失败或模拟失败 | 检查 Wallet A 的 SOL fee balance、Agent Vault 余额、Agent/Policy/Session 状态、授权位、过期时间、单笔与剩余日预算。 |
| Session 显示 signer 不可用 | 私钥不存浏览器。不要切换钱包或刷新；如已刷新，只能用加密备份恢复，或撤销/等待过期后创建新 Session。 |
| USDC deposit/payment 不可用 | 确认钱包有上述固定 Devnet Mint 的 USDC token account 与余额；只持有 SOL 不足以完成 USDC 流程。 |
| Skill endpoint commitment 不匹配 | 逐字核对协议、主机、端口、路径和尾部斜线；修改 URL 后必须更新链上 Skill commitment。 |
| Skill 付款成功但 provider 无结果 | 先看 provider 终端、CORS 和端口；核对 Weather 坐标或 OpenAI key。付款已经结算，不会自动退款；不要盲目重复。 |
| Escrow 没有 Refund 按钮 | 普通退款只对 `FUNDED` 且超过原 deadline 的 Escrow 开放；协商中的 Escrow 要等提案窗口（72 小时）结束后才可退款。 |
| Worker 没有 Cancel task 按钮 | 只对 Worker 自己承接的 `FUNDED` Escrow、尚未提交结果且未到 deadline 时开放；确认当前连接钱包是 Worker Agent owner。 |
| 自动化没有自动提交 | 确认签名 key 在当前 tab、Session 未过期/撤销/暂停、加密备份已下载、fee reserve > 0，并且相应 permission/开关有效；自动 Skill endpoint 必须先手动验证并保存。 |
| MCP 连接失败 | MCP client 与 Runtime 要在同一台主机；连接 `http://127.0.0.1:8787/mcp`，不要用另一台电脑的 `localhost`。 |

## 9. 收场与可重跑方式

- 记下本次 Agent、Policy、Session、Skill、Escrow、Execution PDA 和交易签名，以便会后复核。
- 如果做过自动化，把 Session fee reserve 退回后再撤销 Session；不要把备份文件留在共享演示电脑。
- Devnet 交易不能像本地数据库一样回滚。下一场演示可沿用相同 Agents/Vault，也可用新的 Devnet owner 钱包重新创建；同一个浏览器 Profile 会依靠本地 Agent 指针载入已选择的 Agent。
- 支出额度、权限或 Skill endpoint 改动需要重新发布到链上。更换 Program ID 则需同步改两个环境文件并重启 Web、Runtime 和 provider。

## 10. 建议讲解词（可选）

> “Planner 只负责提议动作。AgentOS 的 Policy 和 Session 将预算与权限写在 Solana 上。这里先看到一笔未执行的付款提案；只有经过人工复核后才由 Session 授权并结算。接着资金进入链上 Escrow，完成说明以哈希承诺记录，release 同时更新 Worker 的 Reputation。最后 Trace 和 MCP 都能读到同一条 Devnet 证据。”


## 11. 任务独立预算与中断恢复（新增）

这一节需要部署包含 Task、TaskAction 和 TaskSkillPayment 的最新 Program。当前用户选择继续功能实现、暂缓部署，因此以下链上步骤是待验收操作，不能把页面预览或构建成功作为已跑通的证据。

### 11.1 启动端口被占用时

如果默认 5173／8787 已被其他项目占用，可在两个终端分别启动本项目：

```sh
PORT=8788 npm run dev:runtime
```

```sh
AGENTOS_RUNTIME_URL=http://127.0.0.1:8788 npm run dev --workspace @agentos/web -- --port 5174 --strictPort
```

打开 `http://127.0.0.1:5174/`。Runtime 地址只用于本地开发代理；生产部署仍需正确配置同源 API 路由。不要停止其他项目的服务来腾端口。

### 11.2 创建与启动 Task

1. 按前面的步骤创建 Agent、给 Vault 充值，创建一个新的 Session。用于 Task 的 Session 必须尚未绑定其他 Task。
2. 若需要刷新后恢复 Session，创建时启用加密备份并下载；Task journal 不包含签名密钥。
3. 打开左侧 **Tasks**。填写任务描述、总 SOL／USDC 预算和截止小时数。预算使用十进制字符串解析，不经过浮点换算；两种资产可只启用一种。
4. 截止时间必须早于 Session 到期，总预算不超过 Session 的剩余总额。网络费、Task／Execution／TaskAction 及 token account 租金另由费用承担者支付。
5. 点击 **Review new task**，核对任务描述、Task PDA、Session、两种资产总额、截止时间和 fee payer 后签名。
6. 创建后的状态是 **ready**。点击 **Start / resume**，复核后签名，将状态改为 **running**。
7. 每个 Session 只绑定一个 Task。这个 Session 的旧支付入口被链上拒绝，网页付款与 Skill 审阅会自动选择任务专用指令。

### 11.3 演示独立预算与状态

1. 以总预算 `0.02 SOL` 为例，使用该 Session 的既有直接付款入口分别审阅小额转账；或者通过 Marketplace 调用收费 Skill。每笔审阅显示 Task 和稳定 action 编号。
2. 每次确认后，在 Tasks 刷新查看累计剩余额度；在 Agent trace 查看实际 Execution 和交易签名。
3. 尝试准备超过 Task 剩余额度的付款，网页应显示任务预算不足；链上任务指令也独立拒绝超支。真实拒绝证据仍需要实际 RPC simulation 或交易日志。
4. 点击 **Pause** 并签名，再尝试准备付款，应被拒绝。点击 **Start / resume** 并签名后继续。
5. **Review completion** 要求填写精确结果文本。完成属于 Owner 声明，不代表 Judge 已授权裁决，也不代表所有 Skill 均已返回结果。
6. 若 Session 丢失或失效，先创建并保存新 Session，再在对应未结束 Task 中点击 **Use current Session**。新 Session 要覆盖任务剩余预算和剩余期限。累计任务支出保留，旧 Session 保持绑定；若要清除其非支出权限，另行 revoke。
7. Task Session 可以通过现有 Worker Escrow 审阅入口注资，金额计入父 Task 总预算；子 Escrow 的截止时间不得晚于父 Task。父任务建议设置 6 小时以上，子 Escrow 可设置 1 小时。完成、退款、取消和双方协商结算原子减少父 Task 的 pending Escrows；有未结算资金时不能声明 Task Completed。退款不恢复累计支出额度。暂停 Task 会阻止新注资，但已有资金仍可依法退款或协商结算。

### 11.4 检查待确认交易

1. 任务支付审阅完成后，网页先保存 prepared 检查点。签名后、广播前保存交易签名和 lastValidBlockHeight。
2. 若签名或发送期间刷新页面，打开 **Tasks → Saved payment checkpoints**。刷新不会自动重新发送。
3. prepared 且没有签名的动作可以通过 **Discard unsent review** 丢弃；已经保存签名的动作必须点 **Check saved transaction**。
4. 工具必须读取原主签名对应的实际成功交易，核对费用承担方、Program、完整指令编码、全部账户及两个必要 signer；同时核对 canonical TaskAction 与 Execution 的 Task、动作编号、金额、资产、输入哈希。直接付款还核对输出哈希，Worker 注资还核对 Escrow 与 TaskEscrow。全部匹配后才转 confirmed，其他成功签名不能代替。
5. finalized 失败需核对匹配的原失败交易且没有本动作 TaskAction；或 finalized 高度超过原有效期、历史查不到签名且 TaskAction／Execution／Escrow 关联均不存在时，原动作才能被标为 failed。RPC 超时、仍未确认或回执不匹配时保持未解决状态，禁止再准备付款。
6. 恢复只核查原动作，不自动重付。新付款仍需重新复核；链上 TaskAction 同时阻止相同 action_id 再次付款。
7. 新付款检查点保存完整审阅指令、所有账户和费用承担方，签署前及广播前重新检查 Task／Session／链上已有付款效果。备份合并会把导入的已签名记录转为 unknown，即使本地原来是 prepared；不相信导入的 confirmed 状态。
8. 旧版本若未保存完整 review，页面标记 Legacy checkpoint，不能自动确认为成功或发送旧审阅。未签名的旧审阅可以丢弃后重新准备；已签名记录需保留并人工核对原 Explorer 交易，不要删除记录后直接重付。原已确认的历史标记不会被这次改动自动升级为新的真实验收证据。

### 11.5 保存及接续 Skill 结果

1. 收到 Skill 响应后，任务 journal 保存原始响应正文和 SHA-256；格式化的显示文本不能替代原始字节。
2. 刷新后打开 **Tasks**，点击对应 confirmed 检查点中的 **Open saved Skill result**。网页会重新验证正文 SHA-256、链上 Execution 归属、金额、资产和请求承诺。
3. 如尚未登记结果，恢复 Session 签名密钥后继续 **Record result hash**；如已登记且链上 hash 匹配，可继续 Memory 保存。
4. **Download journal** 下载交易信息和收到的 Skill 响应文本；**Restore journal** 可导入同一 Devnet Program／Agent 的记录。备份不含 Session 私钥，且可能含业务响应正文，应按业务数据保存。
5. 导入已签名记录会先变为 unknown；再次检查链上状态后才允许继续。不会信任导入文件中的“已完成”标签。
6. 当前上限为 500 条／约 500 KB，不会自动删除未解决动作。清除浏览器数据之前先下载 journal 和加密 Session 备份。
7. 如果 Provider 已执行但浏览器没有收到响应，journal 不会编造结果，也不会自动重放请求。Weather／Research Provider 已加入持久成功响应重取，按 12.6 操作；不支持重取的第三方 Provider 或未保存成功结果的请求仍不能展示成恢复成功。
8. Task 创建／状态更新及结果登记交易本身尚未使用完整的签名检查点；在网络异常时应先查 Task／Execution 的链上状态，再准备下一次审阅。


### 11.6 Task Worker Escrow 与自动规划

1. 创建 Task 时，使用 4–800 字符的精确描述；保留原文。Task 的默认截止时间是 6 小时，需在 Session 有效期内。
2. 开始 Task 后，通过 Marketplace 的 Worker **Hire** 或已有 **Create an Agent Escrow** 入口填写子任务、资产、金额和短于父 Task 的 deadline；审阅中应显示父 Task 编号、稳定动作编号和 TaskAction／TaskEscrow 租金。
3. 注资成功后在 Tasks 检查 pending Escrows 增加。Worker 提交、雇主 release、超时 refund、Worker cancel 或双方 settlement 使用原有入口；客户端会从链上读取正确 Task 关联，并在同一结算交易中关闭关联、减少计数。
4. 替换 Session 后，release 必须使用父 Task 的新 Session。退款及双方协商仍按原有身份与期限规则授权。未结算 Escrow 必须处理完才能声明父 Task Completed。
5. 若注资确认前后刷新，先查 journal 原交易。确认后点击 **Restore Escrow task**，网页核对正文哈希、Worker、金额、资产、deadline、Execution 和 TaskEscrow，再把已有任务正文恢复到 Agent trace 的交接操作。不会创建第二笔 Escrow。
6. 创建 Task 后，描述会填入 Playground。**Run Agent** 要求与父 Task 创建时的描述完全一致（去除两端空白后计算 SHA-256）；刷新后需重新填入原文。
7. Runtime 会把父 Task 剩余额度叠加到 Policy 和 Session 的规划限制上。Task 不为 running、Session 不匹配、过期或描述不匹配时，规划不会授权支付。
8. 若 Session 之前已启用相应 opt-in 自动化、加密备份和 fee reserve，Run Agent 的明确付款、收费 Skill、条款完整的 Worker Escrow 提案可通过任务专用路径自动提交。自动付款仍有持久检查点；Worker 执行、结果签署、Judge 和任务完成尚未形成无人值守闭环。
9. 本次新增功能仍待最新 Program 部署后的真实 Devnet 演示验收；当前页面显示和本地构建不能作为真实交易证据。


### 11.7 创建任务、更新状态与替换 Session 的中断恢复

这三类 Owner 操作也会在显示审阅前写入浏览器恢复记录。打开 **Tasks → Saved task creation and state changes** 可查看 `create`、状态目标或替换 Session。记录保留原 Task ID／PDA、描述／完成正文、金额预算、期限、Owner、完整指令及签名；不保存 Session 私钥。

1. 签署前关闭审阅，或刷新后留下 `prepared`：使用 **Discard unsent lifecycle review**。未签名记录可以丢弃；下一次创建可重新选择 Task ID。
2. 签署后刷新、发送／确认异常：记录变成 `signed` 或 `unknown`。关闭旧审阅，点击 **Check original transaction · no replay**。此操作只查 Devnet 原签名及实际交易，不发送新交易。
3. 确认成功会核对主签名、Owner／费用承担方、Program、指令编码、完整账户列表、Owner signer 和 Task 不可变信息。完成声明还核对最终正文哈希，失败／取消核对终态。已经成功的开始、暂停、Session 替换可能后来再次改变，因此核查历史原交易，不以当前状态相同冒充成功。
4. finalized 失败需要匹配的原失败交易，才关闭为 `failed`。创建交易已过期、历史状态缺失且 Task 账户不存在时可确认未创建；状态和 Session 的变更若原交易不可读取，继续保留待确认，不根据当前值猜测失败。换用保留完整交易历史的 Devnet RPC 后再查。
5. 页面禁止为同一 Task 准备第二个未解决的生命周期操作；未解决的创建／替换也阻止同一个目标 Session 的另一个绑定。发送与 Task 付款使用相同浏览器 Task 锁。其他设备和旧版本网页不在锁内，签署前及广播前会重新检查链上状态、Session 归属／撤销／期限／剩余额度。
6. 点击 **Download lifecycle backup** 下载本 Agent 的全部记录；这是独立于付款 journal 的备份，两个都需保存。更换浏览器后连接同一 Owner／Agent，点击 **Restore lifecycle backup**。导入会核对 Program、Devnet、Agent、canonical Task 与完整指令；合并保留本地历史并拒绝冲突，导入签名一律重新标记待核查，不信任备份中的 confirmed／failed 状态，不自动发送。
7. **Restore saved text** 只把任务描述或完成正文填回输入区域；不会创建任务、声明完成或开启自动执行。创建记录恢复的描述可重新用于 Planner，任务哈希仍由链上流程核对。

浏览器容量为每 Agent 最多 200 个生命周期尝试，超过容量时停止新增而不删除旧证据。备份包含任务／完成正文，演示时自行保留适当的本地副本。此功能尚未取得真实创建、替换或中断恢复交易的运行证据。

## 12. Worker 持久执行与自动发现

### 12.1 手动接单并恢复结果

1. 配置 Runtime 的 `AGENTOS_PROGRAM_ID`、Devnet RPC、`OPENAI_API_KEY` 和模型，启动 Runtime 和网页。本节不会替代最新 Program 的部署步骤。
2. 雇主创建 funded Escrow，并通过 **Share texts with local Runtime** 分享精确子任务；Worker 钱包切换到指定 Worker Agent，打开 incoming Escrow 的 **Submit Worker result**。
3. 点击 **Load verified employer task**。可填写经过人工核对的 notes，并选择最多三份属于该 Worker 的已完成 Skill Memory。建议首次 Demo 用自包含文本总结任务。
4. 在 **Persistent Worker execution** 点击 **Accept and execute in background**。任务与证据将发送给配置的 OpenAI，产生 API 费用；不会发送链上交易。状态先 accepted／running，然后 ready、needs_evidence 或 failed。
5. 关闭窗口或刷新网页，重新打开同一 Escrow 的提交窗口，队列自动读取已保存记录。Runtime 持久文件为 `apps/runtime/.data/worker-jobs.json`，包含业务正文，演示前保留备份；不要删除以尝试“重新执行”。
6. ready 后点击 **Use saved result for review**，核对内容；若要绑定来源，重新选择正确 Skill proofs。继续既有 **Review Worker submission**，钱包核对并签署。结果生成不代表外部工具已经执行。
7. 提交确认后分享结果正文给雇主。可点 **Check on-chain delivery status**，匹配已保存结果哈希才显示 delivered。雇主继续既有 release／Judge 建议审阅流程。delivered 不表示已经结算。
8. 若缺少外部证据，显示 needs_evidence，此版本不能自动继续付费工具工作。若失败或 Runtime 在执行中停止，显示 failed／interrupted；确认错误和原输入后点击 **Retry original execution**，会再次调用模型并产生费用。此版本不自动重试。
9. 重启时已经运行中的请求不会被静默重放；已接受但未开始的请求可继续执行。存储损坏／超限时保留原文件并报错，先停止 Runtime，备份并修复记录。

### 12.2 开启本地自动发现与接单

1. 先完成手动队列演示，再在 `apps/runtime/.env` 设置 `AGENTOS_WORKER_AUTORUN=<Worker Agent PDA>`；多个地址用逗号分隔，最多三个。这里填写 Agent 地址，不能填写 Owner 钱包或私钥。
2. 重启 Runtime。每 60 秒检查指定 active Worker 的 funded Escrow，任务未过期且没有结果／现有作业时，读取同一 Runtime 已分享的任务正文并核对链上承诺，随后自动本地接单与文本执行。
3. 雇主必须分享任务正文；仅有链上哈希不足以执行。每个 Worker 每次扫描最多五条；自动模式不自动选择 Skill sources，仅执行精确任务正文。
4. 在 Runtime 的 `/api/worker/status` 查看 enabled、lastScan、累计 accepted、awaitingTaskText 和错误。没有可用链上数据、Program 尚未部署、Worker 不 active 或缺少 OpenAI 配置时，不把错误展示成已接单。
5. 在 Worker 的交付窗口读取队列，审阅结果并签署交付；或完成 12.3 授权后，按 12.4 显式开启浏览器自动交付。Runtime 本身没有签名密钥、不会发送交易，结算仍需独立授权。
6. 暂停新任务自动发现：清空 `AGENTOS_WORKER_AUTORUN` 并重启 Runtime。已 accepted 的作业仍会继续，running 请求在重启后标为 interrupted；准备 Demo 时可先等待队列清空再停机。
7. 本节证明的是本地执行队列与发现代码能力。真实模型响应、刷新恢复和 Devnet 提交／释放仍需按以上步骤实际演示并保存证据；类型检查和构建不能替代这些证据。

### 12.3 单个 Escrow 的 Worker Session 交付授权

1. 本节需要包含 `grant_worker_delivery`／`submit_session_escrow_result` 的最新 Program；本轮没有部署或发送交易。
2. 连接指定 Worker 的 Owner 钱包，为这个 Worker 创建或恢复有 **Escrow** 权限的 Session。Policy 必须允许 Escrow 且未暂停。
3. 打开 incoming Escrow 的 **Submit Worker result**，在 **Optional Session delivery permission** 点击 **Review Session delivery grant**。核对 Devnet、Worker、Escrow、Session、公钥及 expiry。有效期取 Session 与 Escrow 的较早截止时间。
4. Owner 钱包确认授权。链上新建／复用 `worker_delivery + escrow` PDA，大小 115 字节；首次创建由 Owner 承担租金，审阅页面显示当前 RPC 租金与账户。再次授权在结果尚未提交时替换之前的 Session。
5. 重新打开 Worker 提交窗口，恢复精确任务与结果，可使用 12.1 的持久队列结果。勾选 **Use permitted Session for this result signature** 后继续审阅。
6. 网页先核对 Permit 的 Escrow、Worker、Session、未使用／未撤销与期限，并核对 Session 公钥、有效期与 Escrow 权限。链上再次核对 canonical PDA、active Worker、Policy、Session 和 Permit。
7. 签名者包括 Worker Session；当前审阅入口仍使用 Owner 钱包承担手续费，绑定来源时由费用钱包付 EscrowEvidence 租金。授权不扣 Vault 预算，也不包含资金释放／结算权限。
8. 结果与最多三个 Skill proofs 在同一交易中写入，Permit 标为 used；第二次提交被拒绝。proof 必须属于指定 Worker 的 completed Skill／TaskSkill Execution 且哈希匹配。
9. 若需要停止委托，打开窗口点击 **Review delivery revocation**，Owner 签名撤销。撤销 Permit 或 Session、暂停 Policy、Worker 变为 inactive、期限结束均阻止后续 delegated submit；不能撤销已提交结果。
10. 分享结果正文给雇主，继续 release／协商流程。Permit 只代表 Worker Owner 委托结果签署，不能替代雇主验收或 Judge 裁决。
11. 采集 Session 交付证据时，在 `escrow` 对象增加 `deliverySession`（Session PDA）和 `deliveryGrantSignature`（本次生效的 Owner grant 签名），同时保留原有 submissionSignature。脚本验证 grant、使用过的 Permit、Session signer、期限与 submission、release 顺序。
12. Runtime 后台队列仍无签名能力；现已提供 12.4 的浏览器显式自动交付、fee reserve 和发送检查点。


### 12.4 自动交付、费用余额及交易恢复

1. 完成 12.3 的单个 Escrow Permit 授权。Worker Session 需启用费用赞助、已下载加密备份并在当前页恢复 signer；保持自动化未暂停。Session 费用余额承担网络手续费，若手动绑定 Skill proofs，还需承担 269 字节 EscrowEvidence 的租金。网页在准备时读取实际余额和租金，不足则停止。
2. 打开该 Escrow 的提交窗口，点击 **Enable automatic delivery for this Escrow**。此选择绑定这个 Program／Worker／Escrow／Session，允许提交队列的 ready 结果，并分享精确任务与结果给本地 Runtime；自动交付不绑定 Skill proofs。needs_evidence、failed、interrupted 不会自动交付。
3. 保持网页打开并选中相同 Worker Agent。浏览器每 5 秒读取队列，复核精确任务和结果 SHA-256，再重新读取 Escrow、Session 和 Permit，检查期限、指定 Worker、结果未提交等条件。Session 替换／密钥缺失／备份未保存／费用赞助关闭／自动化暂停时，不发送。
4. 自动交付与手动提交均先保存 prepared 检查点，签名后在广播前保存 signature 和 lastValidBlockHeight，随后模拟和发送。模拟失败、确认中断或网络异常会留下 signed／unknown；不会静默重签。链上一次性结果和 used Permit 同时阻止重复提交。
5. 发送确认后浏览器保存确认状态，自动模式向同一 Runtime 分享正文并核对队列的 delivered 状态。若本地交接失败，链上结果和检查点仍保留，通过下一步恢复正文再分享；不重发交易。
6. 打开 **Agent trace → Saved Worker delivery checkpoints**。signed／unknown 点击 **Check saved delivery**：核对 Devnet、原签名历史、canonical Escrow、Worker、task／result 哈希、交易实际指令、来源列表与 fee payer，全部匹配才显示 confirmed。仅有相同链上结果或成功但不相关的交易不足以通过。
7. 原交易 finalized 失败且无结果承诺，或 finalized 高度超过原有效期、历史查不到签名且无结果承诺时，可标 failed；RPC 故障／暂未确认／结果不匹配保持未解决。未签名 prepared 可点击 **Discard unsent review**，跨标签页通过浏览器锁协调。
8. confirmed 后点击 **Restore confirmed result receipt**；先刷新 Escrow 记录，以核对链上任务和结果哈希。恢复后的精确正文可用于 **Share texts with local Runtime** 或导出交接文件。
9. **Download delivery journal** 下载这个 Worker 的正文、来源、签名和状态；**Restore delivery journal** 可在同一 Program／Devnet／Worker 下导入。导入有签名的记录统一改为 unknown，再读链核对；备份不包含 Session 私钥或自动开关，不能单凭导入状态恢复发送。上限 200 次尝试／存储约 500 KB，备份文件上限 520 KB，不会自动删除记录。
10. 自动模式遇到准备／发送错误会停止该 Escrow 的本次尝试。任何已有 delivery checkpoint 都阻止自动重试，包括 failed／cancelled；人工核对原因后，可通过普通审阅准备新尝试。成功或未知的原尝试不可重复准备。
11. 点击 **Disable automatic delivery**，或在 Agent trace 的设置记录中关闭；全局暂停 Session 自动化或关闭网页也会停止浏览器循环。已经签署并正在发送的交易可能继续确认，需核对原签名。恢复页面后需恢复 Session signer，持久开关才可能继续新尝试。
12. 本节尚待真实 Devnet／模型执行验收；本轮未部署或发送交易。浏览器关闭后的无人值守交付、付费工具执行、跨设备接单协调、Judge 裁决与自动资金结算仍未完成。

### 12.5 Worker 的付费工具执行

1. 本节需要已部署的 Task／Worker Permit Program，已注册并运行的收费 Skill Provider，以及配置 OpenAI 的 Runtime。本轮没有替你部署、付款或调用模型。
2. 使用指定 Worker 的 Owner 钱包创建 Session，启用 API 权限、费用赞助、自动 Skill 支付、自动结果登记、自动 Memory 保存，并下载加密备份；Runtime 建议设置 `AGENTOS_PERSIST_MEMORY=true`，避免重启丢失已保存的工具正文。
3. 给 Worker 创建独立 Task 总预算，描述使用雇主 Escrow 的精确任务正文；Task deadline 不得晚于 Escrow deadline，需处于 Session 有效期内；Start Task。该 Session 随后只允许 Task 路径付款，工具费用计入 Worker Task／Session／Policy，网络费用来自 Session 费用余额。
4. 打开 incoming Escrow 的提交窗口，加载任务。在 **Persistent Worker execution → Optional paid Skill requests** 选择已注册 Skill、SOL／USDC，填写其注册 endpoint 和精确请求；点击 **Add tool at quoted price ceiling**。价格上限取当前注册报价，不随后续涨价增加。最多三项工具与现有 Skill proofs 合计，不支持重复请求。
5. 点击 **Accept and execute in background**，作业进入 waiting_tools，不提前生成完成内容。已接受的工具计划不可改写；队列记录工具 ID、请求、资产、endpoint 和价格上限。
6. 点击 **Enable paid tools for this Escrow**。此开关绑定 Worker／Escrow／当前 Session，与自动交付开关独立。保持页面打开并选中 Worker，浏览器每 5 秒读取队列，一次执行一项。
7. 浏览器先核对独立 Task 的任务哈希、Session、running 状态和 deadline，再通过 Runtime 原子预约工具。预约有唯一 dispatch ID；多标签页／Runtime 重启不会自动重复预约同一工具。
8. 既有 Skill 流程核对 endpoint 承诺、x402 challenge、实时注册价格、上限、资产、余额和 Task 总预算。在广播前，Task journal 保存稳定 TaskAction；Runtime 同时固定 execution／taskId／actionId／dispatch ID。绑定失败时停止广播。
9. 确认付款后调用实际 Skill Provider，核对 settlement header，保存精确响应，自动登记输出 SHA-256并保存 Memory。Runtime 核对 Worker、canonical Execution、Skill 请求哈希、资产／金额、TaskAction、与 Escrow 一致的 Task 正文／期限及完整 Memory 输出哈希；通过后工具才标 complete。
10. 全部工具 complete 后，Runtime 把已验证结果作为证据继续生成 Worker 文本。若仍缺证据，状态 needs_evidence；ready 后按 12.3／12.4 手动或自动交付。自动交付仍不绑定来源 proofs；若需要链上 EscrowEvidence，在手动提交中选择这些 Memory proofs。
11. 若在预约后、付款绑定前停止，工具显示 dispatched 且无 Execution。先关闭付费工具开关、检查 Tasks 的未签名 prepared 审阅并丢弃，再点 **Release reservation with no payment binding**。该操作废止旧 dispatch ID，旧窗口无法用它绑定新付款；重新启用后可预约新尝试。
12. 若已有 Execution 绑定，不能释放预约或自动重付。先按 Tasks journal 核查原付款，再恢复已收到的 Skill 响应、登记 hash、保存 Memory；返回 Worker 窗口点击 **Verify recovered tool proof and continue**。Runtime 重新读链和 Memory，通过后继续。已付款但没有收到 Provider 响应时，可以按 12.6 重取支持该协议的 Provider 已保存响应；没有成功保存结果时保持停止，不能伪造工具结果。
13. 暂停使用 **Disable paid tools**，或 Agent trace 保存设置区的同名按钮。全局暂停 Session 或关闭网页也停止新工具执行；已经发送的付款／请求可能继续完成，需核对原回执。
14. 当前仍由用户选择工具计划；自动发现不自行编造付费计划。尚缺模型自动选择工具、已绑定失败付款的安全新尝试、第三方 Provider 重取支持、完整结果登记签名检查点、无人值守签署、真实链上验收。演示时不要将本地构建描述成已跑通交易。


### 12.6 已付款 Skill 的成功响应重取

1. Weather／Research Provider 启动后会持久保存新执行成功的精确响应。结果分别位于 `apps/runtime/.data/weather-results/`、`research-results/`，以 Program／Execution 区分；原 `weather-claims/`／`research-claims/` 防重放记录继续保留。重启 Provider 不清除这些文件。
2. 新 Task Skill 付款审阅在广播前保存 skillRequest：Skill PDA、provider、endpoint、精确 prompt 和 Skill 名称。原金额、资产、input hash、Execution、签名来自 Task journal。旧版本没有保存请求上下文的记录不会凭空补全。
3. 如果已付款、Provider 可能执行成功但浏览器没有收到响应，先在 **Tasks → Saved payment checkpoints** 点击 **Check saved transaction**，确认原付款；不得重新付款。
4. 对含原请求且尚无本地 Skill 结果的 confirmed 记录，点击 **Retrieve saved Provider response · no payment**。此操作重建这个自定义 x402 协议的原付款条件、带上原签名／Execution 和精确请求，并设置 `AGENTOS-RESULT-ONLY: true`；没有新的 Wallet 签名或付款交易。
5. Provider 重新核对 Devnet 交易、Program／Skill／Agent／金额／资产／request hash／endpoint，仅读取保存的响应。它不创建新的 claim，不调用天气或研究工具，也不使用 OpenAI 生成替代结果。
6. 取回成功后，网页核对 PAYMENT-RESPONSE、精确正文 SHA-256 并保存 Task journal；若 Execution 已有输出承诺，必须完全匹配，并显示 complete。尚未登记输出时仅恢复 received，用户继续审阅 **Record result hash**，这一步仍有独立网络费和签名；重取按钮本身不发交易。
7. 保存 Memory 后，Worker 的 dispatched 工具可点击 **Verify recovered tool proof and continue**。Runtime 验证原 TaskAction／请求／金额／输出和 Memory，再生成交付文本；不重新支付原工具。
8. 同一正常付费请求重复到达时，已有成功缓存会返回原响应；已 claim 但无成功响应时返回 409，不重复执行。只读重取没有缓存返回 404；不支持此协议的 Provider 返回 501；存储无法验证返回 503。错误不代表付款退回。
9. Provider 执行成功但写盘失败／进程在缓存发表前停止时，claim 仍保留，重取可能没有结果；这是未完成的恢复情况，不能删 claim 文件再重放。第三方 Provider、旧请求没有缓存、注册 endpoint 已改变也可能无法通过该入口重取。
10. 结果文件只记录成功正文，带付款／请求上下文、content type、SHA-256 和保存时间；采用独占发表，已有成功结果不能替换。停止 Provider 后可备份 claims 和 results 目录，停止 Runtime 后备份 Memory／Worker 作业，浏览器下载 Task journal；仅备份其中一侧不足以恢复完整流程。
11. 备用端口演示时，在 `apps/runtime/.env` 设置 `AGENTOS_WEB_ORIGINS=http://127.0.0.1:5174,http://localhost:5174`，重启 Runtime 与 Providers。默认是 5173。Runtime 与两个 Providers 共用精确来源白名单，禁止通配符和带路径的来源；Provider 地址仍需按所选端口重新注册 endpoint 承诺。
12. 本轮仅完成代码与构建检查；尚未收集真实 Provider 成功响应、重复请求、进程重启和重取验收证据。链上 Program 尚未按本轮目标部署。


### 12.7 Task Skill 结果登记的交易恢复

1. 本节适用于新 Task Skill 的结果登记，包括手动 **Record result hash** 和 Worker 的自动登记。普通、未绑定 Task 的旧 Skill 登记路径尚未接入这个检查点；Task 创建／状态变更也没有同等的签名恢复日志。
2. 成功响应先保存到 Task journal，再创建独立结果登记尝试。每个尝试记录 ID、Session PDA、费用承担方、状态、签名、有效区块高度和时间；付款签名保持原样。每份结果最多 20 次尝试，不自动删除历史。
3. 手动登记先审阅结果哈希与费用承担方，确认后签署并模拟；自动登记沿用已明确开启的 Session 自动化条件。两条路径均在广播前保存完整签名及有效区块高度。模拟失败不广播；已经签名的尝试仍需要核查，不能直接重签。
4. 中断后打开 **Tasks → Saved payment checkpoints**。若恢复来自下载的 journal，先确认原付款；导入的结果尝试有签名时转为 unknown，没有签名时转为 prepared。导入会合并新尝试，拒绝正文、付款或签名冲突；备份的 confirmed 状态和结果登记签名不作为链上确认依据。
5. 点击 **Check result transaction**。页面只读查询 Devnet 原签名、完整原交易和 Execution；核对 Program、交易费用承担方、Session、Agent、canonical Execution、Task、TaskAction、原付款请求、金额、资产以及精确输出哈希。只有原登记指令成功且链上输出一致，才保存 confirmed 和登记签名。
6. 如果原交易 finalized 且失败、链上没有输出承诺，或原签名历史缺失、finalized 区块高度已超过有效期且没有输出承诺，则尝试标为 failed。其他情况保留未知状态；查询不可用、发现其他输出或另一笔交易写入相同输出时，不据此自动重试。
7. 对 prepared 且没有签名的记录，可以点击 **Discard unsent result review**；正常关闭审阅也会执行丢弃。浏览器使用同一 Task 的协调锁，避免一个标签页签署时另一个标签页丢弃或重新登记。跨设备不共享此锁，演示请使用一台设备。
8. 核对 confirmed 后，点击 **Open saved Skill result**，继续保存 Memory；Worker 工具点击 **Verify recovered tool proof and continue**。恢复检查本身不付款、不重新调用 Provider，也不签署登记交易。
9. failed／cancelled 尝试保留在日志中。若链上仍无输出，可打开保存的结果重新审阅新登记尝试，只承担登记网络费；原 Skill 付款不会重复执行。任何 prepared／signed／unknown／confirmed 尝试都会阻止再创建登记尝试。
10. 备份包含精确 Skill 响应和交易记录，不含 Session 私钥。网页关闭后不会继续新的自动签署，已经广播的交易可能继续确认。本节目前只有类型和构建检查，尚未取得真实钱包签署、跨标签页、中断及链上恢复验收证据；部署继续暂缓。


### 13. 双方授权的 Judge 裁决与结算

> 本节是新增的授权流程。旧窗口里的 **Ask AI Judge** 仍只生成建议。本轮已构建，尚未部署或取得真实交易证据；准备 Demo 前须先部署对应版本。默认全部交易分别审阅；显式开启的浏览器自动裁决／结算见 13.5，没有 Runtime 后台签名服务。

#### 13.1 提前准备与双方约定

1. 准备 Employer、Worker、Judge 三个 Agent。Judge Agent 与两方都不同，Judge Owner 钱包也必须与两方 Owner 不同。建立 Judge Session，具备 API 权限，Judge Agent active、Policy 不暂停且允许 API；保留该 Session 的加密备份以在 Judge Profile 恢复 signer。
2. Employer 创建 funded Escrow（SOL 或 Devnet USDC），尚未提交 Worker 结果。若是 Task Escrow，父 Task 的 pending_escrows 会包含此笔。
3. Employer 打开 **Agent trace → Judge authorization and settlement**，填写 Escrow PDA，点击 **Load Judge state**。核对雇主、Worker、任务哈希、截止时间。
4. 填写独立 Judge Agent PDA、Judge Session PDA 和本地时间的 Judge 截止时间。该时间必须早于或等于 Escrow deadline，并不超过 Judge Session expiry。点击 **Review Judge proposal**，核对固定条款及费用后签署；雇主支付 220-byte JudgeMandate 租金和网络费，金额以实际模拟／租金查询为准。
5. 条款为 pass 全额支付 Worker、fail 全额退款 Employer、needs_review 保留资金。提议一经建立不可改换 Judge，且同一个 Escrow 只有一个提议。两方确认前任一 Owner 可以 **Review decline** 永久拒绝；随后只能用既有流程或创建新的 Escrow，不提供替换提议。
6. 切换到 Worker Profile 和 Owner 钱包，加载同一 Escrow。核对 Judge Agent、Session、授权期限及条款，点击 **Review Worker acceptance** 并签署。确认交易不创建账户，只收网络费；交易固定当时审阅的完整条款，任务／Judge／期限不匹配时拒绝。
7. 双方同意必须在 Worker 提交任何结果之前完成。确认后不能撤回或修改 Judge，授权只允许一个决定。当前仍保留 Owner release、退款及双方协商入口，不能把这个模式演示为排他仲裁。

#### 13.2 Worker 交付与 Judge 签署

1. Worker 按 12.3／12.4 提交结果，交接精确任务正文与结果正文。结果必须在 Escrow 期限内提交且不能覆盖。
2. 切换到 Judge Profile 和 Owner 钱包，恢复被选中的 Session signer。**Judge authorization and settlement** 可直接填写外部 Escrow PDA；Judge 不需要是雇主或 Worker，也不需要 Escrow 出现在自己的 incoming 列表。
3. 点击 **Load Judge state**，核对双方已同意、指定 Session、任务哈希、结果哈希及未用授权。
4. 在 **Exact task text** 和 **Exact submitted result text** 填写精确正文，点击 **Generate assessment · no transaction**。网页先校验链上哈希，再将正文发送到 Runtime 配置的模型；需配置 OPENAI_API_KEY，任务最多 400 字符，结果最多 6,000 字符，完整请求最多 32 KB。此按钮不会签名、付款或结算。
5. 评审 JSON 会填入 **Exact Runtime Judge response JSON**。也可粘贴从 Runtime `/api/escrow/judge` 得到的完整原响应。不要改写字段／原文；页面按 Runtime 固定字段顺序复算 SHA-256。检查 verdict、confidence、summary、逐条 checks、limitations 和证据。pass 必须有且全部 met，fail 必须有 not_met；无法明确验证时应 needs_review。
6. 点击 **Review signed Judge decision**。页面重新读取链上授权／结果，保存评审正文和哈希，再展示任务／结果／评审哈希、判定、摘要、Session 与费用承担钱包。判断结果合理后手动确认签名；Judge Session 与费用承担钱包共同签署，费用承担方支付 243-byte JudgeDecision 租金及网络费。
7. 签署成功后保存不可改写的 JudgeDecision，授权 used。任何 verdict（包括 needs_review）都消费这个唯一机会；不允许重裁决、改判或换 Session。当前链上只存正文 SHA-256，不存完整评审文本。
8. 在评审窗口点击 **Download saved judgment body** 保存精确正文、哈希和成功回调取得的签名。该记录保存在当前浏览器；正文导入与广播前签名检查点现已接入，见 13.4；数据库持久化尚未实现。交易确认中断时核对原签名，不要重新提交另一份判定；无法查明时保留未解决状态。
9. Judge Session 在裁决前被撤销、到期或 Policy 暂停会阻止签署；已形成的合法决定不会因后续撤销 Session 而消失。它仍受双方授权的结算期限约束。

#### 13.3 固定金额结算与异常分支

1. 对链上 pass 或 fail 决定，任意连接钱包的使用者都可加载该 Escrow，点击 **Review Judge settlement**。按判定固定全额接收方；调用者不能调整份额或重定向资金。
2. 核对全额原子金额、资产、接收 Agent、判定哈希、费用承担方后签署。SOL 到 canonical Agent Vault；USDC 到 Agent 的 canonical token account。USDC 若任一方 token account 不存在，调用者可能支付账户创建租金，需预留测试 SOL；这些费用不计入 Task 总预算。
3. 结算在一笔交易中转账、更新 Execution、Worker Reputation、decision.settled。Task Escrow 同时关闭 TaskEscrow 关联并减少 pending_escrows；漏传或传错父 Task／Execution 会整体失败，不部分转账。SDK 会从链上关联读取正确账户。
4. pass 增加 completed、successful、资产成交量以及 10 分（上限 10,000）；fail 增加 completed、failed 并减 10 分（最低 0）。仅生成评审或只登记裁决不会改变信誉。完整争议和信誉防刷规则尚未完成。
5. needs_review 没有 Judge settlement 按钮，也不能调用自动资金指令；改用现有 Owner 审阅、双方协商或到期退款。Judge deadline 或 Escrow deadline 到期后拒绝裁决／Judge 结算；到期退款仍按原 Escrow 条件进行。
6. 如果先通过旧 release／refund／互相协商完成，Escrow 已终结，随后 Judge settlement 必须拒绝；裁决记录若已存在仍保留，不再次转账或计分。重复结算、未同意授权、其他 Session、伪造或错误哈希、Needs Review 均不得转账。
7. 重新点击 **Load Judge state**，记录 JudgeMandate／JudgeDecision 地址、相关交易签名和 finalized 状态；保存精确正文、双方授权截图和 Vault／信誉／Task 的前后变化。当前 `evidence:devnet` 尚未扩展验证 Judge，不能用现有 Skill／Escrow 证据包宣称 Judge 已验收。
8. 显式 opt-in 浏览器自动裁决与结算操作见 13.5；仍待数据库正文备份及全分支真实验收，签名恢复操作见 13.4。本节提供手动复现步骤，构建通过不代表已经在 Devnet 跑通。


#### 13.4 Judge 操作中断恢复与备份

1. 五类操作（propose、accept、decline、record、settle）在准备审阅时都会写入 Judge journal，按 Devnet／Program／Escrow 区分。记录包含完整指令与账户、费用承担方、Escrow 的双方／原子金额／资产／任务哈希、尝试 ID、状态、时间，以及裁决登记的精确评审响应。日志不包含 Session 私钥。
2. 点击 **Download Judge journal** 保存整个 Escrow 的尝试历史。每个 Escrow 上限 100 条／1 MB；达到上限时停止新写入，不静默删除旧记录。保存受浏览器本地存储配额限制，备份文件须自行妥善保管。
3. 审阅确认后，签署完成的签名和 lastValidBlockHeight 在广播前写入，再做带签名验证的模拟和发送。模拟失败不广播，但这时已有签名，仍保留检查点；不能直接当作未签名审阅丢弃。
4. 页面关闭、刷新或确认失败后，重新加载同一个 Escrow。点击 signed／unknown 记录上的 **Check Judge transaction**。查询只读、不签署或发送交易。
5. 成功恢复需要原交易已 confirmed／finalized、原签名一致、费用承担方一致、Program／指令编码／全部账户序列与保存审阅一致，并且链上授权／裁决／结算结果匹配。record 还复算精确评审正文哈希；settle 核对 JudgeDecision settled 以及正确 released／refunded 状态。即使链上存在相同结果，也不据此冒认另一笔交易成功。
6. finalized 原交易明确失败且原完整交易匹配时，可将尝试标 failed。若原签名查无历史、finalized 区块高度超过有效期且没有对应链上效果，也可标 failed。查询失败、交易正文缺失、已存在效果但原历史不可查，均保留未知；不自动重试。
7. 任何 prepared／signed／unknown Judge 尝试会阻止该 Escrow 的新 Judge 审阅。已 confirmed 的相同操作也不能再准备。只有 prepared 且无签名的记录可用 **Discard unsent Judge review** 丢弃；正常取消交易审阅也会执行相同操作。
8. 同一浏览器的标签页共用按 Program／Escrow 的协调锁，签署、丢弃、恢复与导入互斥。此锁不覆盖其他设备，也不覆盖旧 Owner release／refund 窗口；演示请固定一台设备，处理未知尝试期间不要在其他窗口启动另一个结算流程。
9. 使用 **Restore Judge body / journal** 导入备份。journal 必须属于相同 Program、Devnet 和 Escrow；校验实时账户绑定、指令类型和正文哈希后合并，不删除本地历史。不同付款条件、指令、评审正文或签名冲突时拒绝。
10. 导入签名尝试统一转 unknown，没有签名的导入尝试转 prepared；备份中的 confirmed／failed 等状态不作为链上证据。先核对原签名，确认后再继续下一个操作。已有本地已确认记录保留；备份可补全同一 prepared 尝试的原签名，但不能重新打开本地 cancelled 审阅。
11. 原版 **Download saved judgment body** 文件也可以导入。页面校验完整正文与哈希及当前任务／结果，如果链上已有裁决则必须匹配 judgment hash；文件里的签名不会被视为已确认，也不会据此生成伪造的签名检查点。它没有有效区块高度，不能代替完整 journal。
12. failed／cancelled 尝试保留历史。核查当前链上仍允许此操作后，用户可以重新准备新审阅；恢复入口不会替用户重签。若旧操作已通过其他有效路径完成，只能读取状态，不能重新转账或重复记分。
13. 此轮仅做类型、前端构建和代码空白检查，尚未完成真实钱包、跨标签页、广播中断、导入和双资产恢复验收。Rust／SBF 与 13 节对应构建未变，部署继续暂缓；自动裁决和自动结算提交仍待实现。


#### 13.5 显式开启浏览器自动 Judge 与结算

1. 本节需要 13.1 的双方授权、指定 Judge Session 和链上已提交结果。当前不会自动发现新 Judge 任务或自动获得跨设备正文；先在 Judge Profile 加载指定 Escrow，保持 **Agent trace** 页面打开。本轮只有代码／构建检查，没有替你调用模型、签署或结算。
2. 恢复授权 Judge Session signer，开启费用赞助、保存加密备份，并保持 Session 自动化未暂停。Judge Agent active，Policy 未暂停且允许 API，Session 未撤销／未过期且允许 API；开启与每次签署前都会读链核对。自动交易的费用承担方是该 Session key，不是 Owner 钱包。
3. 若要自动生成评审，填写精确 task／result 正文，保持 **Let Runtime generate the assessment from the exact texts above** 勾选。开启前校验正文 SHA-256；Runtime 需要 OPENAI_API_KEY，正文会送到配置的模型，可能产生 API 费用。取消勾选则只使用已填入的原评审 JSON，并校验 judgmentHash。已有链上决定时只能使用与该决定相同的保存正文，不重新调用模型。
4. 默认不自动结算。需要完整流程时，明确勾选 **Also submit fixed pass/fail settlement automatically**。授权 pass 全额到 Worker、fail 全额到 Employer，needs_review 不提交任何结算。不会提出新 Judge、替 Worker 确认或修改双方条款。
5. 点击 **Prepare automatic Judge authorization**。预览仅只读：核对 Devnet／Escrow／双方／原子金额／资产／指定 Session／费用承担方、任务与结果哈希、评审来源、提供评审的判定／摘要／hash、是否自动结算及期限。正文或选项改变会清除预览，需重新准备。
6. 预览分别列出 243-byte JudgeDecision 的租金上限与缺失 USDC Agent token account 的租金上限；SOL 结算不创建新账户。每笔网络费上限固定 10,000 lamports，最多两笔；费用余额按租金上限加两笔费用上限预留。现有决定会使登记租金上限为零。不同于 Escrow 金额，这些费用来自 Session 余额，不计入 Task 支出总额。
7. 点击 **Enable exactly this automatic Judge authorization** 后，保存按 Devnet／Program／Escrow 隔离的授权，包含精确正文／哈希、Session、费用承担方、双方金额资产、期限、租金与网络费用上限。不开启按钮不执行；授权文件不会写入私钥，也不会通过普通 journal 导入自动重新授权。
8. 页面每 5 秒推进一个阶段。首次评估前持久写 evaluating；成功响应经固定字段／正文 hash 校验后保存，再准备 record 检查点。模型请求若中断、出错或响应无法验证，会 error 并关闭自动模式；不在下一轮重复请求。重新明确准备授权可能再次调用模型，请先确认旧响应是否可恢复。
9. 自动登记由指定 Judge Session 同时担任裁决签署方和 fee payer。写入原签名／有效区块高度、模拟和确认沿用 13.4。签署前通过实际未签名消息报价检查网络费上限；签署前与广播前重新检查本地授权仍启用、Session／Policy／Agent、截止时间、链上正文绑定、资金与租金报价。租金上限是客户端当前 RPC 报价检查，不是新增加的链上租金限额字段。
10. 若评审 needs_review，登记唯一裁决后关闭自动模式，状态 needs_review；Escrow 本金保留，按人工流程处理。若未勾自动结算，状态 recorded 并关闭；用户手动审阅结算即可。
11. 若勾选自动结算且已登记 pass／fail，下一轮确认保存的正文与链上 decision hash 一致，核对仍 funded、未 settled、费用和关联账户，再准备并发送固定 SOL／USDC 结算。成功 complete 并关闭。资金、Execution、Task pending_escrows 与信誉规则同 13.3，不通过模型自选金额或接收方。
12. 点击 **Disable automatic Judge** 可以立即撤销浏览器自动授权；暂停 Session 自动化、进入其他页面或关闭网页会停止启动新步骤。已经广播的交易可能继续确认，需按原签名查询；成功回调不会把手动关闭的开关重新开启。静止的持久授权可能在重新打开同页、恢复同一 Session 时继续尚未开始的阶段。
13. 自动模式与手动 Judge 审阅互斥。同一 Escrow 的自动阶段用浏览器锁串行推进，并与 13.4 的交易锁配合。页面正在处理其他交易／审阅时跳过新启动；正在进行的步骤若授权或上下文改变会停止，不重新创建动作。
14. 任意 prepared／signed／unknown 尝试都阻止自动推进，必须核查原签名。任何历史 record／settle 尝试都不会自动重签：登记失败／取消后，人工完成登记；只有已完成决定及核对过的正文可以重新授权后续首次结算。已有失败／取消结算尝试则继续手动处理，不通过重新开关自动重付。
15. 自动生成的正文仍可 **Download saved judgment body**；包含交易的完整 **Download Judge journal** 继续用于签名恢复。自动设置和正文目前在当前浏览器，按 Escrow 单独保存，最多 64 KB；没有数据库备份、自动发现／接收外部交付正文、通知或关闭网页后的无人值守签名服务。
16. Demo 验收须分别准备 SOL／USDC、pass／fail／needs_review、授权撤销／暂停／过期、余额／租金／费用报价不足、模型中断、广播中断、跨标签页等场景，保存真实原交易和正文。当前没有上述真实运行证据，不能把本地构建通过描述成这些流程已跑通。


#### 13.6 Judge 任务发现与已验证交付正文读取

1. Worker 结果提交确认后，在其浏览器回执点击 **Share texts with local Runtime**。自动 Worker delivery 成功时也会尝试分享精确正文；分享失败不重新提交结果，可从回执重试。分享动作只将内容发送到同一个本地 Runtime，不发布到公共服务器，不触发付款。
2. 需要跨 Runtime 重启保留正文时，在 Runtime 环境设置 `AGENTOS_PERSIST_ESCROW_HANDOFFS=true` 并重启。正文保存在 `apps/runtime/.data/escrow-handoffs.json`；备份时先停止 Runtime。当前 handoff 的 task／result 各最多 400 字符，Judge 手动评审允许的更长正文不会由此存储自动补全。
3. 切换到被指定的 Judge Agent，打开 **Agent trace → Judge authorization and settlement**，点击 **Discover authorized Judge tasks**。网页查询 `GET /api/on-chain/judge-tasks?judge=<Judge Agent PDA>`，按 Judge Agent 读取链上 JudgeMandate 和 JudgeDecision，并批量读取关联 Escrow。
4. 列表包含未确认、已接受、已提交结果、已裁决以及已结算的状态；**Result available for assessment** 仅表示任务／授权／Escrow 的结果与期限适合评审，不代表 Session／Policy／费用余额或结果质量已通过。行动前仍使用 13.5 的实时完整检查。
5. Runtime 校验 Program 所有权、discriminator、精确长度、canonical PDA／bump、Judge／Session／双方／任务结果哈希、裁决时间与 accepted_at／expiry，以及 settled 与 Escrow 的 Released／Refunded 状态。错误或暂时不一致的快照不作为有效任务返回，页面显示未验证数量；出现该提示先刷新，不凭目录进行转账。
6. 目录按已同意且未使用、尚未过期的授权优先，最多 100 个候选；底层 Program 查询上限 1,000 条。超限显示 Limited view，保留手动填写 Escrow PDA 的入口。该目录不宣称列出所有历史或所有任务；使用者须保留重要 Escrow 地址。
7. 点击 **Load this Judge task**。网页再次通过自己的 Devnet RPC 读取并核对完整实时状态，不能只凭 Runtime 返回的可用标记选择裁决、费用或金额。
8. 点击 **Read verified shared task and result · no transaction**。Runtime 从原显式分享记录读取，重新核对链上任务／结果承诺；网页校验 Program／network／Escrow、精确正文与 SHA-256，然后再次独立读链匹配。成功后填入 Exact task／result，清除旧自动授权预览。
9. 这个按钮不自动生成评审、不签署或开启自动模式。之后用户可按 13.2 生成并手动签署，或按 13.5 预览并明确开启自动流程。正在自动运行的 Escrow 需先关闭自动模式再更换正文或任务。
10. 若正文尚未分享、只分享任务没有结果、Runtime 与 Worker 使用不同实例、持久化未开启而重启，或正文哈希不匹配，读取拒绝；不猜测或重新生成交付正文。让 Worker 重试分享其已确认回执，或手动交接精确文本。
11. MCP 增加只读工具 `agentos_list_judge_tasks`，输入 `{ "judge": "<Judge Agent PDA>" }`，返回同一有上限、含 truncation／failures 的目录。既有 `agentos_get_escrow_handoff` 用 result 模式可读取显式分享的正文；这两个工具不会赋予签署权限或执行结算。
12. 目前是用户触发的本地任务发现，不自动订阅、后台接收远端正文或替所有 Judge Escrow 开启授权。公共部署的服务 metadata／endpoint 注册、数据库隔离和通知仍未完成。本轮 Runtime／Web 类型检查与前端构建通过，没有新增真实链上、Runtime 重启或正文读取验收证据，未部署或发送交易。

### 13.7 为评委保存 Judge 链上证据

完成本节授权、裁决与结算后，记录雇主提议、Worker 确认、Judge 登记和结算的主交易签名；下载并保留原评审 JSON。按 [DEVNET_EVIDENCE.md 第 7 节](DEVNET_EVIDENCE.md#7-judge-授权裁决与固定结算证据) 将原正文、评审和签名放入本地输入文件，运行只读 Judge 证据采集。需要程序实际部署且交易 finalized 后才能取得成功报告。

向评委展示 `report.json` 中的授权双方、Judge／Session、裁决分支、正文哈希、Explorer 链接和结算状态。需人工复核或尚未结算的报告只证明裁决登记；当前 Reputation 是快照，展示增量仍需结算前后的独立记录。把注资、交付的页面记录和签名一起保留，Judge 采集本身不核查这两笔原交易。

## 14. SQLite 存储、迁移与备份

### 14.1 开启数据库

SQLite 模式目前覆盖 **Worker jobs**、**Escrow handoffs** 和 **verified Memory**。Planner history／Provider 成功响应及浏览器交易 journal 仍使用各自存储；切换后不代表这些数据已统一迁移。SQLite 是本地单 Runtime 存储，尚无公共多租户权限隔离或跨 Runtime 协调。

1. 停止正在使用这个项目数据目录的 Runtime。先复制 `apps/runtime/.data/worker-jobs.json`、`escrow-handoffs.json` 和 `memory.json`（若存在）作为原始备份；不要删除原文件。
2. 确认 Node.js 24 或更新版本。SQLite 后端使用 Node 内置 `node:sqlite`，不需要另装数据库服务器；该模块在相关 Node 版本仍有 experimental／release candidate 标记，参见 [Node 官方说明](https://nodejs.org/api/sqlite.html)。JSON 模式保持原行为。
3. 编辑 `apps/runtime/.env`：

```dotenv
AGENTOS_STORAGE_BACKEND=sqlite
AGENTOS_DATABASE_PATH=
```

空路径默认 `apps/runtime/.data/agentos.sqlite`；自定义路径建议写绝对路径，并确保所在目录可写。SQLite 模式下正文交接持久化始终开启，不再受 `AGENTOS_PERSIST_ESCROW_HANDOFFS=false` 影响；仍需显式 Share texts，且每次读写继续核对 Devnet 承诺。

4. 启动 Runtime。打开健康接口 `/api/health`，应看到 `storageBackend: "sqlite"` 和 `databaseCollections: ["worker-jobs", "escrow-handoffs", "verified-memory"]`。这表示选择了后端，不证明迁移／模型／交易已成功。Memory 在监听前恢复／迁移；Worker 队列启动时迁移；正文集合首次使用时迁移。
5. 第一次使用每个集合，程序校验旧 JSON 的完整 schema、正文哈希、重复键与容量，然后用事务导入。空文件缺失会建立空集合；损坏文件会停止该集合恢复，原文件保留。后续只读数据库，不会再次覆盖导入旧 JSON。旧 `running` 工作转为 `interrupted`，不自动重跑模型。
6. 用 **Worker queue** 查看既有任务；对已分享 Escrow 使用正文读取，核对任务／结果是否保留。Worker／handoff 集合仍各限 200 条／2 MB；Memory 共限 200 条／16 MB，不能把切换数据库当作清空容量。

### 14.2 创建一致性备份

```sh
npm run backup:runtime
# 明确选择源和一个全新的目标文件：
npm run backup:runtime -- --database /absolute/path/agentos.sqlite --output /absolute/path/demo-backup.sqlite
```

命令使用 SQLite 的在线备份 API，可在 Runtime 运行期间采集一致性快照，校验数据库标识／版本和完整性，输出 SHA-256、字节数与各集合条数。默认备份在被 Git 忽略的 `apps/runtime/.data/backups/`。它清除副本的进程占用信息，不改变源数据库；目标存在时拒绝覆盖。备份含任务／结果／工具请求正文，不含 Session 私钥；它不证明链上结算或模型实际调用。

**不要直接复制正在运行的 `agentos.sqlite` 主文件作为备份**：WAL 模式还可能有 `-wal`／`-shm`。应使用上述命令。备份运行中的模型任务，恢复后可能成为 interrupted；模型支出不会因回滚本地文件自动退回。

### 14.3 手动恢复与回退

1. 停止源与目标 Runtime，并保留当前数据库的一致性备份。
2. 将 `AGENTOS_DATABASE_PATH` 改为备份文件的绝对路径，或复制备份为**新的文件名**后指向该副本。不要覆盖旧数据库，也不要把旧 `-wal`／`-shm` 混到新副本旁。
3. 启动 Runtime，查看健康接口、Worker queue 和交接正文。签名未知的浏览器交易继续使用原 journal 查询；数据库恢复不会重放支付、工具 HTTP 请求或交付签名。
4. 每个数据库只允许一个 Runtime 进程。启动时若已有活进程占用，会拒绝打开；不要删除占用信息绕过。异常终止后，同一主机检测到原 PID 已退出才可重新取得占用。异地主机旧占用需使用上述备份副本恢复，数据库直接复制不自动抢占。
5. 若改回 `AGENTOS_STORAGE_BACKEND=json`，Runtime 会重新使用原 JSON 文件，**不会把 SQLite 中的新增记录自动导出回 JSON**。这可能是较旧状态，先停止服务并保留数据库备份，避免在两个副本上同时执行同一工作。

当前只完成类型／静态检查，尚未取得实际 SQLite 迁移、在线备份和重启恢复演练证据；公共服务、信誉完善、其他数据集合与访问隔离仍需继续实现。


### 14.4 Memory 数据库恢复与链上复核

SQLite 模式下 Memory 始终持久化，即使 `AGENTOS_PERSIST_MEMORY=false`；JSON 模式仍由该变量决定。备份命令会自动包含 `verified-memory`，不用另复制 Memory 文件。

- 新记录保存 Program ID，数据库以 collection／Program／Execution 为键，Agent 为正文中的归属字段。搜索、最近记录、Worker 证据读取及计数仅使用当前 Program 的记录。Program 范围过滤不等于用户权限隔离；本地接口仍缺少多租户认证。
- 旧 `memory.json` 没有 Program 的记录迁移时归入配置的 `AGENTOS_PROGRAM_ID`，因此有此类旧记录时必须先配置正确地址。这是存储命名空间分配，**不是链上核验**；所有 Memory 搜索／读取和 Worker 证据使用仍会核对 Devnet、Program-owned Execution、canonical PDA、完成状态及精确正文哈希。
- 无效正文、重复键、错误哈希、超过 200 条／16 MB 的旧文件会让恢复报错并停止启动，不会跳过坏记录再把其余文件覆盖写回。先保留原文件，恢复可靠备份或整理副本后再启动；不要将空文件当作已成功恢复。
- 已满 200 条时，保存新 Execution 会拒绝，旧记录不自动淘汰。相同 Execution 的相同正文仍可查到；需新增时先做一致性备份并安排归档，目前没有网页归档／删除入口。
- 向评委演示：完成 Skill 结果登记 → 保存 Memory → 查询并核对哈希 → 执行数据库备份 → 停止 Runtime → 按 14.3 指向备份副本 → 重启 → 查询同一正文。只有实际链上 Execution 仍可读取且哈希匹配时，正文才能再次作为有效来源。

该流程尚待真实迁移、备份、重启和 RPC 读取演练；数据库中的存储数量不能代替已核验的 Demo 证据。


## 15. 公共 Skill 服务目录发现

本入口把链上的 Skill 与公开服务地址对应起来，便于 Marketplace 选择和 MCP 查询。部署仍暂缓；链上没有注册账户时，空目录不能演示付费调用。

### 15.1 准备目录

1. 复制 `docs/examples/service-catalog.json` 为自己的目录文件。示例 `services` 为空，不代表已有服务；`programId` 必须等于 Runtime 的 `AGENTOS_PROGRAM_ID`。
2. 每个已注册 Skill 添加以下字段（替换文字占位符）：

```json
{
  "skill": "实际 Skill PDA",
  "provider": "链上 Provider 公钥",
  "endpoint": "https://your-provider.example/api/skill",
  "name": "服务名称",
  "description": "服务介绍",
  "tags": ["research"]
}
```

地址必须是合法 Solana 公钥；同一 Skill 不得重复。端点必须是规范 HTTPS URL，或本地演示用 HTTP localhost／127.0.0.1／[::1]，不能含凭据或片段。URL 的精确 UTF-8 字节 SHA-256 必须等于注册 Skill 的 endpointHash，尾部斜线也影响哈希。名称 1–120 字符、介绍最多 500 字符、标签最多 8 个且每个 1–40 字符。不要写价格或 active 字段，这些值只取链上账户。

3. 将 JSON 放在可读取的 HTTPS 地址；本地演示可从仓库根目录用 `python3 -m http.server 8890 --bind 127.0.0.1 --directory docs/examples` 提供空示例。
4. 设置 Runtime 环境变量并重启：

```dotenv
AGENTOS_SERVICE_CATALOG_URL=http://127.0.0.1:8890/service-catalog.json
```

### 15.2 手动发现与调用

1. 打开 Marketplace，点击 **Read public catalog**。Runtime 读取链上 Skill，并验证 Program ownership、账户布局、canonical PDA、Provider 和端点哈希；网页再次核对端点哈希。
2. 查看匹配、未解析与失败数量。未匹配项不提供调用入口；inactive 或对应资产价格为零时不能选择该资产调用。未配置目录会显示未配置状态。
3. 选择 **Review SOL call** 或 USDC，服务地址填入既有付款表单。填写请求，再按原流程审阅并签署；付款准备仍读取当前链上 Skill／Session／Policy，不依赖目录价格。发现和选中服务不会启用自动调用。
4. MCP 客户端可调用只读 `agentos_discover_services`（无参数）；HTTP 为 `GET /api/on-chain/services`。两者不执行服务、不签署、不支付。

名称、介绍、标签只是目录声明；端点哈希匹配不证明质量、可用性或 Provider 签署过这些介绍。读取仅访问操作者配置的目录，不访问发现的服务地址。目录最多 200 条／512 KB，超限拒绝，禁止重定向，10 秒超时；链上读取最多 1,000 条，返回 truncated 时不能视为完整全网目录。目前没有公共托管注册中心、分页、Agent／Worker 服务画像或目录数据库缓存。

本轮完成类型检查与生产构建；尚未实际读取目录或完成链上付费 Demo。


## 16. 信誉展示与解释

在 Marketplace 读取 Agent 目录，再打开 Agent 的 Overview 查看 Reputation。目录核对 Program ownership、Agent／Reputation 精确布局与 canonical PDA／bump；缺失信誉账户或错误积分会报错，不能解释为新 Agent 的零分。

最新源码规则（须部署此版本才生效）：双方 Owner 钱包不同的成功释放 Escrow 或 Judge pass 结算使 Worker 加 10 分；Judge fail 结算减 10 分，积分限制在 0–10,000。同一 Owner 的 Agent 结算正常转账／退款，但不改变信誉计数、金额或积分，日志记录 ReputationExcludedSelfSettlement。积分是累计值，不是成功概率或满意度百分比。计数／金额覆盖 Escrow 的对应结算，不包含全部 Skill 调用。双方协商结算记录 dispute；到期退款不判断 Worker 是否完成工作。

Demo 时展示成功数、失败数、disputes、SOL／USDC 金额及原交易证据，说明 Judge 登记与最终结算是不同步骤，needs_review 未结算不会贡献成功积分。当前积分缺少独立评价、抗刷单、时间衰减和案件来源明细，不能当作完整可信评分。


### 14.5 Runtime 规划历史

SQLite 模式现在包含第四个集合 `runtime-history`，忽略 AGENTOS_PERSIST_HISTORY=false，首次启动校验并导入原 `history.json`，原文件保留。健康接口会报告此集合及 persistentHistory=true。JSON 模式仍由 AGENTOS_PERSIST_HISTORY 控制。

这是本地模拟规划日志，包含任务、规划器、摘要和模拟 trace，不是链上成功记录，也不证明模型实际调用。使用固定本地存储命名空间，不代表 System Program 归属。保持最近 25 条／8 MB；新增规划会淘汰最旧日志，网页 Clear history 会显式清空这一集合。交易 journal、Memory 和证据文件不受此清理影响。

恢复拒绝坏记录、重复 ID、错误绑定、超容量文件，不再静默过滤。读取失败会停止启动；先保留原文件并恢复可靠备份。新增与清空通过同一队列串行处理，先持久化再更新内存。保存失败会在接口报错，保留此前历史；模型可能已经完成调用，不要自动重跑请求或把未保存结果当作可恢复证据。

按 14.2 的备份方式会包含历史集合。演示步骤：运行一次规划 → 查看 activity → 备份 → 停止 Runtime → 指向备份副本 → 重启 → 查看原规划。切回 JSON 不会自动导出 SQLite 新历史。尚未实际进行此重启／迁移演练。


### 15.3 Worker 从公共目录选择付费工具

打开 Worker 交付／执行面板，在尚未接单时点击 Read public catalog。选择 Select SOL tool 或 Select USDC tool，会填入 Skill、资产与端点。目录记录必须匹配当前编辑器的链上 Skill 地址与两种资产价格，否则提示刷新 Agent 页面。

填写 Tool request（默认使用 Worker 的精确任务），点击 Add tool at quoted price ceiling 后检查工具列表。现有证明和新工具合计最多三个。之后显式接单，准备与此 Escrow 正文绑定的 Worker Task／预算，再单独启用付费工具。目录选择不会执行请求、签署付款、创建 Task 或开启自动授权；已接单后工具不可变，目录入口隐藏。

运行时仍核对链上 Skill 及端点承诺，付款沿用原 Task、Session、Policy 和预算检查；目录文字不能改变授权。目录过期或不匹配时不要绕过报错，应重新读取。此入口尚未取得真实目录／Worker 工具付款的演示证据。


### 16.1 查看 Worker 的 Escrow 明细

在 Marketplace 的 Agent 行展开 Inspect Worker Escrow outcomes，点击 Read outcome accounts。核对任务 ID、金额资产、Employer、任务／结果 SHA-256，再打开 Inspect Escrow and transactions 核对原交易。

Runtime 核对 Program ownership、精确 Escrow 布局、状态、资产及 canonical PDA／bump；网页验证响应 Program／Devnet／Worker 绑定与字段。当前返回最多 1,000 条，达到上限会提示可能截断，没有全网分页。明细是当前账户快照，不是完整信誉事件账本：released 无法单凭状态区分 Owner release 与 Judge pass，refunded 无法区分到期退款与 Judge fail；不要将这些状态直接换算成积分。Judge 原交易证据仍按第 13 节采集。

此入口仅显式读取，不签署、不支付、不改变信誉。尚未取得真实链上明细演示证据。


### 14.6 导出 Agent Memory 正文

在 Agent Trace 的 Agent Memory 区域点击 Export stored Memory，下载当前 Program／Agent 的 JSON 存储快照。只读接口为 `GET /api/memory/export?agent=公钥`。包含最多 200 条完整正文、Execution、标题、标签、内容哈希、存储时间、导出时间和 entriesSha256（精确 JSON.stringify(entries) UTF-8 的 SHA-256）。导出与 Memory mutation 使用同一队列，避免读取写入中的数组。

导出先校验本地记录结构及正文哈希，标识 verification=storage-hashes-only；不会进行最新 RPC 复核。旧 JSON 记录的 programId 可能缺失，外层 Program 是当前筛选范围，不能当作新增链上证明。留存原文件，展示正文时仍通过正常 Memory 读取核对当前 Execution。该文件包含完整结果正文，请按自己的分享范围保存。

导出不删记录、不释放容量；此多条快照目前没有批量导入入口；单条归档及恢复见 14.7／14.8。SQLite 的完整重启恢复仍使用 14.2 的一致性数据库备份。未实际执行导出／恢复 Demo。


### 14.7 审阅并归档单条 Memory

在 Agent Trace 的已核验 Memory 行点击 Review archive，核对 Execution 与 SHA-256，读完影响说明后点击 Archive and remove from active Memory。Runtime 校验当前记录与审阅哈希，先独占创建 `.data/memory-archives/Execution-随机ID.json`，同步文件及目录，之后移除活动记录并保存 JSON／SQLite。更新失败恢复缓存并保留归档副本；超时结果未知时先 Refresh，勿盲目重试。

归档释放活动容量，停止该正文参与搜索／Worker 证据查找，不修改链上账户／信誉。归档采用完整正文及 storage-hashes-only 标识，不执行 RPC；同 Runtime 仍无多租户认证，不能作为公共写接口开放。运行中或尚未链上终结的 Worker 任务引用此来源时，Runtime 会拒绝归档；先完成并结算相关 Escrow。到期但未退款仍算未终结。

归档文件不在 SQLite 在线备份内，必须另保存 `memory-archives` 目录。没有自动删除归档；单条恢复按 14.8 操作，保留归档原文件。尚未实际进行归档或重启演练。


### 14.8 从单条归档恢复 Memory

打开 Agent Trace → Agent Memory → Restore an archived Memory，选择 14.7 生成的单条 archive JSON（不是多条 snapshot）。网页校验最多 400 KB、格式／版本、Devnet、当前 Program／Agent、Execution 公钥、正文 64 KiB 限额与 SHA-256。审阅标题、Execution、哈希及完整正文，点击 Verify on chain and restore。

恢复复用正常 Memory 保存接口，重新读取实际 Devnet Execution、账户 ownership／PDA／完成状态／正文承诺；不信任文件里的 storedAt 或 source。成功后活动 Memory 使用新保存时间，既有相同 Execution 幂等返回原记录，不覆盖其他正文。满容量仍拒绝；链上缺失或不匹配时不恢复。加载文件不自动写入，Discard review 放弃本次审阅。

超时或响应不匹配时先 Refresh 核查该 Execution，勿依赖错误推断未保存。保留原归档文件。此功能不调用模型、不发送交易，仍待真实归档→恢复→Worker 证据查询演练。


### 14.9 数据库与 Memory 归档统一备份

仅用于 SQLite。正常停止 Runtime（不要在备份中重新启动），然后从仓库根目录执行：

```sh
npm run backup:runtime-bundle
# 自定义源和一个全新目标目录：
npm run backup:runtime-bundle -- --database /absolute/path/agentos.sqlite --archives /absolute/path/memory-archives --output /absolute/path/demo-bundle
```

工具拒绝数据库中仍有进程占用的源、符号链接、已有目标、未知归档文件及错误正文哈希。异常终止残留占用时先正常重启／停止 Runtime，不要手工删占用绕过。数据库复制复用在线一致性工具；外部归档最多 10,000 文件、每个 400 KB、总包 200 MB。文件采用新建及同步，最终才写 manifest.json，记录数据库／每条归档的字节数和 SHA-256。

没有 manifest.json 的目录是未完成备份，保留排查或选新目标重做，不能当恢复包。清单不是签名，SHA-256 检测字节变化，不证明来源可信或链上成功。恢复前核对清单的每个文件哈希；按 14.3 指向包内数据库，单条正文按 14.8 选择包内归档恢复。不要自动复制未知文件覆盖现有数据。

该包不含 JSON 模式数据、Provider 缓存、浏览器交易 journal 或 Session 密钥；这些仍按各自导出流程保存。尚未实际运行备份或恢复演练。


### 14.10 恢复前只读校验备份包

```sh
npm run verify:runtime-bundle -- --input /absolute/path/demo-bundle
```

只读检查 manifest 格式、重复／非法路径、缺失与额外文件、符号链接、大小及每个 SHA-256，核对归档正文哈希。数据库检查 application ID／schema v1、quick_check、空占用、集合条数及记录 body_sha256。失败退出，不恢复或覆盖文件；成功报告 storageIntegrity=verified 及清单哈希。保存原备份输出的 manifestSha256，在不同存储之间复制后再次比较。

校验不执行模型、任务或交易；哈希不是签名，不能证明发布者身份或链上结算。完整应用 schema 与 Execution 绑定仍由 Runtime 恢复／使用时校验。禁止在正在恢复／使用的包上同时运行校验；保留只读原件，另复制成工作副本。若 SQLite 生成额外 WAL／SHM，说明该包已被使用，不应冒充原始离线包。

目前仅完成工具静态语法检查，尚未运行真实备份包校验及完整恢复演练。


### 16.2 同 Owner 信誉排除规则

该规则覆盖 Owner／Session SOL 与 USDC release，以及 Judge SOL／USDC pass／fail 结算。不禁止同 Owner 的业务转账，只排除这类结算对 Reputation 的影响。计数、金额与积分统一排除，不会出现积分未变但成功数用于排名刷高的问题。Execution、Escrow 状态、TaskEscrow closed 与余额结算仍按原规则更新。

旧部署的历史信誉不会重算或清零；更新程序后新增结算才执行此规则，展示历史值时核对实际部署版本。不同钱包可能仍由同一人控制，不能宣称具备完整 Sybil／合谋防护。当前最新源码仍未部署，演示真实规则前需要最新二进制和 Devnet 验收。


### 14.11 Provider 结果与防重放记录备份

正常停止 Weather 和 Research Provider，在备份期间保持停止，然后执行：

```sh
npm run backup:providers -- --providers-stopped --output /absolute/path/new-provider-backup
```

`--providers-stopped` 是操作者声明，工具不能自动证明所有 Provider 进程已停止。工具仅读取 `weather-claims`、`weather-results`、`research-claims`、`research-results`，校验文件类型、名称／记录绑定、结果正文哈希和格式，再独占写入新目录。每目录最多 10,000 文件、单文件 500 KB、总包 200 MB。末尾写 manifest.json 的逐文件 SHA-256；没有清单的目录视为未完成，选新目标重做。它不读取 .env、密钥或调用模型／RPC。

Provider claim 可能存在而结果缺失，说明执行中断／结果未发布；保存该 claim，不能删除后重新使用同一付款触发执行。备份不证明链上付款或模型完成，实际结果恢复仍通过原付款验证和 RESULT-ONLY 请求。

恢复前核对清单哈希，停止 Provider 并保留现有状态，**同时恢复 claims 和 results 四目录**，不要只恢复结果或只恢复 claim。不要覆盖不同版本的记录或把旧备份当成当前所有付款的完整状态；在独立工作副本中安排恢复，保存新增状态。Runtime SQLite／Memory／浏览器 journal 分别使用此前备份流程。尚未运行真实 Provider 备份或恢复演练。


### 15.4 使用目录描述规划任务

配置 AGENTOS_SERVICE_CATALOG_URL 后运行正常任务规划。Runtime 每次读取当前链上 Skill 和目录，匹配通过的名称／介绍／标签可用于本地关键词选择及 OpenAI 候选描述；中文本地匹配使用相邻汉字。模型明确将目录内容视为不可信声明，不得用它改变政策、授权或声称已执行。

提供的 Skill 列表只限定候选地址，价格／active 以此次链上读取为准。当前规划候选仍最多 50 条，没有完整语义搜索或全网分页。目录读取／格式失败会使本次规划报错，不绕过配置继续相信旧介绍；修复配置后再运行，目录读取发生在模型调用前。未配置目录保留原注册列表规划方式。

规划仅提出候选，不执行服务或启用自动授权。服务地址仍在调用审阅／Worker 工具编辑器通过第 15.2／15.3 选择，付款继续实时校验。目录描述不能证明质量、可用性或任务适合性。尚未实际调用模型或进行真实目录规划演示。


### 12.12 归档已终结的 Worker 任务

在 Worker queue 中先 Check on-chain delivery status。closed／delivered 且没有 dispatched 工具的记录提供 Review archive，核对 Escrow 和 updatedAt 后点击 Archive terminal Worker job。

Runtime 重新读取并核对任务绑定，要求 Escrow 已 released／refunded／cancelled／settled，拒绝仍 funded（包括已过期但尚未退款）或 settlement_proposed 的记录。先在 `.data/worker-archives/` 保存并同步完整 job、当前终态、工具绑定和结果，再移出活动 JSON／SQLite 队列以释放 200 条容量；更新失败恢复记录并保留副本。记录变动会拒绝旧审阅，超时结果未知先刷新。

归档不会执行模型、支付、交付或删除链上记录。已终态的 Escrow 不会被自动发现重新接单，手动接单也受原实时终态检查拒绝。没有直接重新导入终态任务的入口，浏览器交易 journal 和 Memory 保持独立。

**另外备份 worker-archives 目录**：当前 Runtime 统一包只含 SQLite 与 memory-archives，不包含此目录。归档的终态标记只描述归档时链上快照，不是原交易证明。尚未实际进行 Worker 归档／恢复演练。


### 12.13 接单证据与归档并发保护

Worker 接单时先读取 sourceExecutions 对应 Memory 并重新核验 Execution，证据缺失／不匹配会拒绝保存新任务。已有任务保持原输入不可替换，不自动生成缺失证据。

Memory archive 检查本 Runtime 当前 Program／Worker 的 sourceExecutions 和付费工具 Execution 引用；running 直接拒绝，其他引用任务重新读链，Escrow funded 或 settlement_proposed 时拒绝。检查与归档提交期间持有 Worker 队列锁，因此新的接单／工具绑定不会绕过检查。已终态的非 running 任务可以归档来源。

保护范围是同一 Runtime 的已保存队列；其他 Runtime／外部客户端／未保存计划不在引用集合里。仍须保留备份和任务证据，不把此锁当跨设备协调。尚未实际进行并发／链上验收。


### 11.8 Task 付费 Skill 待登记计数

最新 Task 布局为 227 字节，末尾增加 pending_skill_results。Task SOL／USDC Skill 付款与计数加一在同一链上交易完成；record_task_skill_result 首次成功登记结果哈希后减一，并更新 Task 时间。Task 结果登记指令现在要求 writable Task；旧未签署指令应重新准备，不能沿用只读 Task 的指令。

Tasks 页面同时展示 Pending Escrows 和 Pending Skill results，两者都为零才可 Review completion。链上同样执行此检查，外部客户端不能绕过。结果重复登记拒绝，不会重复扣计数；Session 替换不重置预算或计数，原未登记结果可由绑定的当前 Session 登记。Failed／Cancelled 仍可用于停止未完成工作，不能冒充 Completed；没有结果的已付费 Skill 不会自动退款或被跳过。

这只证明所有计入 Task 的 Skill 已有结果哈希，以及 Escrow 已终结；Owner 的最终正文仍是声明，不证明内容质量或独立 Judge 全部验收。最新布局需要新部署；旧 219 字节 Task 不做自动迁移，保留旧证据并安排新的 Task。此前状态证据只证明当时 Program 不存在，不能证明此版本已部署。尚未取得付款→计数→登记→完成的真实链上证据。


### 11.9 查找已付款但未登记的 Skill 结果

在 Tasks 的 Task 卡片展开 Inspect paid Skill result commitments，点击 Read Task Skill receipts。只读查询核对 Task／TaskAction／Execution 的 Program ownership、布局、canonical PDA、Agent、金额与资产，显示 action ID、输入／输出哈希与原 Execution 交易链接。

HTTP 为 GET /api/on-chain/task-skill-results?agent=公钥&task=Task公钥；MCP 为 agentos_list_task_skill_results，参数 agent 与 task。每页最多检查 action ID 升序的 100 条动作（包括非 Skill 动作）；点击 Read next action page 继续。HTTP／MCP 可传 afterActionId，使用响应 nextCursor，null 表示本次返回集合没有后续页。底层目录仍最多 1,000 条，registryTruncated 时不是全部未完成结果；不能拿显示数量替代链上 pendingSkillResults。RPC 多次读取不是原子快照，计数和行可能随登记变化，刷新后核对。

Result not recorded 表示此 Execution 没有 output_hash；恢复需要原请求正文、Skill／URL 与付款签名（journal／导出），不能仅凭哈希重建请求。使用原 Provider RESULT-ONLY 恢复和原结果登记流程，不重新付款、不推测丢失正文。此查询本身不调用 Provider、不签署或登记结果，仍待真实链上恢复演示。


Task 结果翻页在读取每页时重新查询账户，不是固定快照。旧页里未登记结果可能已在下一页读取期间登记；需要当前状态时重新点击 Read Task Skill receipts 从头读取。action ID 可以不连续，不应自行加一猜游标；即使一页全是非 Skill 动作、没有结果行，也使用返回的 nextCursor 继续。未知／非 u64 游标拒绝，网页拒绝重复页／错误绑定，并限制最多展示 1,000 条结果。
