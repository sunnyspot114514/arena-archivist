# Arena Archivist

基于 DSH 的个人红队档案、恢复与复盘运行时。它不是通用浏览器 Agent：第一版只面向 Gray Swan，只读、人工登录、手动启动批次、单并发、本地优先，并且代码中没有提交或上传能力。

## 已实现的边界

- DSH 只看到四个语义工具：`arena_session_status`、`arena_sync_next_batch`、`arena_read_archived_record`、`arena_export`。
- Browser Guardian 在语义工具、DOM 事件和网络请求三层 fail closed。
- `AUTH_MODE` 只打开专用 Chrome Profile，登录、MFA、Passkey、CAPTCHA 全部由用户完成。
- `COLLECT_MODE` 只有导航、读取与保存本地证据；GraphQL mutation、未知 POST、上传和跨 origin 文档均拒绝。
- 原始证据先脱敏、计算 SHA-256，再与规范化记录和 checkpoint 原子提交到 SQLite。
- 默认数据级别是 `local_only`；多模型路由在每次请求前检查数据策略、embargo、脱敏和 ZDR 条件。
- 离线 fixture 覆盖完整状态机，因此不登录 Gray Swan 也能验证采集、幂等、恢复和策略拒绝。

## 本地启动

要求 Node.js 24（项目也兼容 DSH 声明的 Node 22.19+）。

```bash
npm install
npm run dev:all
```

Dashboard 默认在 Vite 输出的 localhost 地址，Runtime API 固定监听 `http://127.0.0.1:4317`。首次运行建议点击“运行离线演示”，它只读仓库内的合成 fixture。

常用命令：

```bash
npm test
npm run typecheck
npm run build
npm run demo
npm run secret-scan
```

生成的数据位于 `arena-archivist-data/`，专用浏览器 Profile 位于 `runtime/chrome-profile/`；二者均已从 Git 排除，并按 Edge/Chrome 分目录保存。Windows 上会读取系统默认浏览器；正式支持 Edge 和 Chrome，默认浏览器不受自动化运行时支持时会安全回退到已安装的 Edge 或 Chrome。

## NVIDIA 模型连接与切换

启动 Dashboard 后，点击右上角“配置 NVIDIA 模型”：

1. 输入 NVIDIA API Key，点击“保存 Key 并读取模型”。Windows 上的 Key 使用当前用户绑定的 DPAPI 加密后写入 `.arena-runtime/credentials/`；明文不会进入 SQLite、日志、前端存储或导出包。
2. Runtime 会从 NVIDIA 官方 `GET /v1/models` 读取完整模型 ID；模型列表支持忽略大小写和分隔符的模糊搜索（例如输入 `k3` 可找到 `moonshotai/kimi-k3`）。选择一个模型后点击“切换到所选模型”。界面和 Runtime 都只接受当前目录返回的 ID，不允许手工填写目录外的值。
3. 后续点击“更新模型列表”即可重新读取 NVIDIA 目录；目录有变化时，已失效的当前模型会被明确标记并要求重新选择。
4. 以后切换模型不必重新输入 Key。点击“断开并清除 Key”会删除本地加密凭据，但保留非秘密的模型选择。

参考 CC Switch 的是 Provider 状态、模型发现和显式切换交互；没有照搬它把整套 Provider 配置序列化进 SQLite 的存储方式。当前 NVIDIA endpoint 固定为 `https://integrate.api.nvidia.com/v1`，避免把 Key 转发到任意地址。

## 人工登录

点击 Dashboard 的“打开三个登录标签页”，或运行：

```bash
npm run arena -- auth
```

Windows 上的 `AUTH_MODE` 会直接启动普通 Edge 或 Chrome，并在项目专用 profile 中打开三个登录标签页。它不受 Playwright 控制，因此兼容 Google OAuth；登录完成后关闭整个登录浏览器，`COLLECT_MODE` 才会以单页、单并发和只读策略复用该 profile。

这会打开一个独立 Chrome Profile。Arena Archivist 不读取或记录密码、Cookie、localStorage、authorization header，也不应指向你日常使用的 Chrome Profile。登录失效或出现 CAPTCHA 时，采集器暂停等待人工接管。

## 启用真实采集前

真实采集默认关闭。由于 Gray Swan 页面结构和适用条款可能变化，不能把合成 fixture 的 selector 当作真实 selector。启用前需要：

1. 查看当前适用的站点条款；若有官方导出，优先使用官方导出。
2. 人工保存少量你有权读取的页面 fixture，并删除秘密或无关个人信息。
3. 基于 fixture 创建 selector contract，将兼容状态设为 `verified` 并通过全部 parser/policy 测试。
4. 在 `.env` 中设置 `ARENA_LIVE_COLLECTION=true`、`ARENA_INDEX_URL` 和 `ARENA_SELECTOR_CONTRACT`。
5. 保持浏览器可见，每次只手动启动一批。

任何 403、429、登录页、CAPTCHA、bot challenge、parser drift 或 mutation deny 都会立即停止批次。

## DSH 集成

DSH 冻结在：

```text
tag: dsh-v0.1.1-rc.2
commit: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
Cordis: 4.0.1
```

版本锁在 `dsh/VERSION.lock`，专用插件位于 `packages/dsh-profile-arena/`。`dsh/arena-profile.patch.yml` 是最小 profile 片段；不要把它叠加在加载了 shell、filesystem、web、editor、workflow、subagent、scheduler 或通用 Playwright MCP 的默认 profile 上。应从空 profile 组合，并用 DSH 的 `--dump-config` 审核最终插件树。

DSH 是 Agent/session/model orchestration 层，不是安全沙箱或档案真源。`arena.sqlite` 与 crawler checkpoint 才是 canonical state。

## 项目结构

```text
app/                         Dashboard
apps/runtime/                localhost API 与 CLI
packages/dsh-profile-arena/  DSH 语义工具与单调 guard
packages/browser-worker/     Playwright 只读状态机
packages/gray-swan-adapter/  页面 contract、parser、fixture
packages/browser-policy/     语义/DOM/网络策略
packages/rate-governor/      批次预算与退避
packages/archive-store/      SQLite、证据哈希、checkpoint
packages/auth-broker/        不透明凭据接口
packages/model-router/       数据分级路由
packages/analysis-engine/    确定性指标与报告
packages/exporter/           secret scan 与 analysis pack
policies/                    人类可审阅的策略配置
schemas/                     档案与标注 JSON Schema
docs/                        架构、威胁模型、数据字典
```

安全设计与不变量详见 [docs/threat-model.md](docs/threat-model.md)，数据流详见 [docs/architecture.md](docs/architecture.md)。
