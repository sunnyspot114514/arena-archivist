# Arena Archivist: 基于 DSH 的个人红队档案与复盘系统

Arena Archivist 是一个本地优先、权限收窄的个人红队档案运行时：它通过人工登录和低频只读批次保存授权范围内的 Arena 记录，再用确定性分析与受控模型投影完成复盘。

它不是通用浏览器 Agent。当前版本只面向 Gray Swan，不包含提交、上传、任意点击、无人值守调度或通用 Playwright 工具。

## 当前状态

- Dashboard、localhost Runtime、SQLite canonical store、Playwright Worker、Browser Guardian、Rate Governor、Exporter 和 DSH 语义工具已接通。
- 离线 fixture 可完整执行 `proposal → validation → authorization → dispatch → observation → reconciliation → canonical_commit`，无需访问 Gray Swan。
- Action/Authorization ledger、稳定 keyset cursor、只读 Connector Registry 和确定性 Authorized Model Projection 均已持久化或接入运行路径。
- NVIDIA Provider 支持本地输入 API Key、读取官方模型目录、模糊搜索模型 ID 和显式切换；远程模型不会因离线演示自动调用。
- 当前测试基线为 118 个测试全部通过；`typecheck`、`build`、`lint` 和 `secret-scan` 通过。
- 真实采集默认关闭。仓库不附带假冒真实页面的 selector contract；必须使用经审阅、状态为 `verified` 的 contract 才能启用。

## 动机

个人红队工作的难点通常不在“能不能打开网页”，而在于能否长期保持清晰、可恢复、可审计的边界：

1. 人类负责登录、MFA、Passkey 和 CAPTCHA。
2. Agent 只获得少量语义化读取工具，不获得浏览器 primitive。
3. 每次同步先形成 proposal 和 authorization，再执行、观察、对账和提交。
4. 原始证据、规范化记录、checkpoint 和审计事件保存在本地 canonical store。
5. 只有经过本地确定性脱敏和策略授权的投影才可能进入 Provider 路由。

Arena Archivist 将这些约束做成运行时不变量，而不是依赖提示词约定。

## 仓库内容

```text
app/                         Dashboard
apps/runtime/                localhost API、Controller 与 CLI
packages/dsh-profile-arena/  DSH 语义工具与单调 guard
packages/browser-worker/     Playwright 只读状态机
packages/archive-connectors/ 通用只读 connector registry/interface
packages/gray-swan-adapter/  页面 contract、parser 与离线 fixture
packages/browser-policy/     语义、DOM 与网络策略
packages/rate-governor/      批次预算、冷却与退避
packages/archive-store/      SQLite、ledger、cursor、证据与 checkpoint
packages/auth-broker/        不透明凭据接口与本地秘密存储
packages/model-router/       确定性投影与数据分级路由
packages/analysis-engine/    确定性指标与 Markdown 报告
packages/exporter/           secret scan 与 analysis pack
policies/                    人类可审阅的策略配置
schemas/                     档案与标注 JSON Schema
docs/                        架构、威胁模型与数据字典
```

## Quick Start

要求 Node.js 22.19+；推荐 Node.js 24。

```bash
npm install
npm run dev
```

Dashboard 默认由 Vite 选择 localhost 端口；Runtime API 固定监听 `http://127.0.0.1:4317`。启动后先点击“运行离线演示”，它只读取仓库内的合成 fixture。

常用检查：

```bash
npm test
npm run typecheck
npm run build
npm run lint
npm run secret-scan
```

生成数据位于 `arena-archivist-data/`，专用浏览器 Profile 位于 `runtime/chrome-profile/`，本地凭据和 Provider 设置位于 `.arena-runtime/`。这些目录以及 `.env`、构建产物和数据库文件均已从 Git 排除。

## 登录与只读采集

点击 Dashboard 的“打开三个登录标签页”，或运行：

```bash
npm run arena -- auth
```

Windows 上的 `AUTH_MODE` 会使用系统默认的受支持浏览器（Edge 或 Chrome）打开项目专用 Profile。这个阶段不受 Playwright 控制，登录、MFA、Passkey 与 CAPTCHA 全部由用户完成。

登录完成后的 live 流程固定为：

```text
AUTH_MODE → 关闭整个登录浏览器 → 验证登录状态 → 手动启动 COLLECT_MODE
```

Runtime 会独立执行同样的门控：登录浏览器仍打开或会话尚未验证时，live sync 会 fail closed。离线 demo 不读取 Profile，因此可在人工登录期间独立运行。

### 启用真实采集前

由于站点结构和适用条款可能变化，不能把合成 fixture 的 selector 当作真实 selector。启用前需要：

1. 确认你有权读取目标记录，并查看当前适用条款；如有官方导出，优先使用官方导出。
2. 人工保存少量页面 fixture，删除秘密和无关个人信息。
3. 基于这些 fixture 创建 selector contract，将兼容状态设为 `verified`，并通过 parser/policy 测试。
4. 从 `.env.example` 创建本地 `.env`，设置 `ARENA_LIVE_COLLECTION=true`、`ARENA_INDEX_URL` 和 `ARENA_SELECTOR_CONTRACT`。
5. 重新启动 Runtime；项目根目录的 `.env` 会在 Runtime 配置构造前加载。
6. 关闭登录浏览器、验证会话，并手动启动一个小批次。

任何 403、429、登录页、CAPTCHA、bot challenge、parser drift 或 mutation deny 都会立即停止批次。

## NVIDIA 模型连接与切换

Dashboard 右上角的“配置 NVIDIA 模型”提供一个本地 Provider 控制面：

1. 输入 NVIDIA API Key，点击“保存 Key 并读取模型”。Windows 上的 Key 使用当前用户绑定的 DPAPI 加密后写入 `.arena-runtime/credentials/`；明文不进入 SQLite、日志、前端存储或导出包。
2. Runtime 从 NVIDIA 官方 `GET /v1/models` 读取模型 ID。搜索忽略大小写和常见分隔符，例如 `k3` 可匹配 `moonshotai/kimi-k3`。
3. 只能选择目录中真实存在的模型 ID；后续可刷新目录并显式切换。
4. “断开并清除 Key”只删除本地加密凭据，保留非秘密的模型选择。

该交互参考了 CC Switch 的 Provider 状态、模型发现和显式切换思路，但没有引入第二套配置或凭据系统。NVIDIA endpoint 固定为 `https://integrate.api.nvidia.com/v1`，防止 Key 被转发到调用方指定地址。

## 安全模型

- DSH 只看到五个语义工具：`arena_session_status`、`arena_sync_next_batch`、`arena_query_archive`、`arena_read_archived_record`、`arena_export`。
- Browser Guardian 在语义工具、DOM 事件和网络请求三层 fail closed；GraphQL mutation、未知 POST、上传和跨 origin 文档均拒绝。
- 原始证据先脱敏并计算 SHA-256，再与规范化记录和 checkpoint 在同一 SQLite 事务中提交。
- 每个同步批次都有持久 ledger；独立 authorization record 绑定 action/run、request、scope、policy、connector、principal、source 和授权时间。授权不等于结果提交。
- 查询使用稳定 keyset cursor。cursor 绑定规范化 query hash、持久 catalog ID 和事务性 generation；catalog 改变后旧 cursor 返回 `STALE_QUERY_CURSOR`。
- Model Router 不接受调用方的 `redacted: true`。它只消费由当前 `ArchiveStore` attestation 生成、带 source/content/policy/projection/authorization hash 的本地品牌投影。
- DSH 查询只返回无正文句柄和投影收据；Cookie、浏览器状态、原始 URL、附件名、evidence path 和 Playwright primitive 不进入模型工具结果。

完整威胁与控制映射见 [docs/threat-model.md](docs/threat-model.md)。

## DSH 集成

DSH 版本冻结在：

```text
tag: dsh-v0.1.1-rc.2
commit: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
Cordis: 4.0.1
```

版本锁位于 `dsh/VERSION.lock`，专用插件位于 `packages/dsh-profile-arena/`。`dsh/arena-profile.patch.yml` 必须从空 profile 组合，不应叠加 shell、filesystem、web、editor、workflow、subagent、scheduler 或通用 Playwright MCP。DSH 是 session/model orchestration 层，不是安全沙箱或档案真源；`arena.sqlite` 才是 canonical state。

## 已知限制

- 目前只有 Gray Swan connector；没有通用网站采集模式。
- 仓库只提供合成 fixture baseline，不提供未经现场审阅的 live selector contract。
- 人工登录浏览器在 Runtime 重启后不会恢复进程级“仍打开”指示；重启前应先关闭该浏览器，重启后再验证 Profile 会话。
- Dashboard 当前以运行总览为主，完整 policy/action ledger 通过 localhost API 和 SQLite 查看。
- `analyze` 默认是确定性离线分析；不会为了演示自动发送原始档案到远程模型。
- 没有定时任务、批量并发、自动 CAPTCHA/MFA 或写入站点的能力。

## Roadmap

- 增加由用户授权、脱敏 fixture 驱动的 live contract 审阅工作流。
- 恢复 Runtime 重启后的原生 AUTH_MODE 进程交接状态。
- 在 Dashboard 增加 action/authorization timeline、policy deny 和 cursor stale 诊断。
- 在相同只读 Connector 接口下增加经过审阅的官方导出或其他档案来源。
- 为公开发布补充 CI、版本化发行说明和明确的软件许可证。

## 文档

- [Architecture](docs/architecture.md)：运行时边界、状态机、ledger、connector、cursor 与 projection 数据流。
- [Threat Model](docs/threat-model.md)：威胁、fail-closed 控制与剩余风险。
- [Data Dictionary](docs/data-dictionary.md)：SQLite 表、字段、cursor 与投影形状。
- [Web Archive Agent Merge](docs/web-archive-agent-merge.md)：供体设计的吸收和替代关系。

本仓库是 Arena Archivist 的唯一产品与 canonical 代码库。`web-archive-agent` 原型中的增量设计已经按现有 TypeScript/SQLite 边界重写吸收；运行时不读取、不启动、也不依赖该原型目录。
