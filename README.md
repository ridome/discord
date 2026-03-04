# Discord Codex Orchestrator

一个本地运行的 Discord 机器人，用于通过 Discord 指挥本地 VS Code + Codex 干活，采用 **Diff 优先** 工作流：

1. Discord 发起任务。
2. Codex 只生成结构化 JSON + unified diff。
3. 本地 Orchestrator 进行补丁校验、`git apply`、测试、自动提交。
4. 高危命令走二次确认。
5. 支持 Slash、中文自然语言、语音转指令（Google Speech API，可选）、Gemini 语义意图增强（可选）。

## 功能覆盖

- Slash 命令：`/ping` `/task` `/status` `/approve` `/reject` `/cancel` `/run` `/open` `/read` `/repos` `/voice_join` `/voice_leave` `/voice_status` `/memory_add` `/memory_list` `/memory_delete` `/memory_clear` `/memory_auto`
- 自然语言确认流：支持中英文命令词（如“创建任务/状态/批准/拒绝/取消/执行/打开/仓库”），先回显等价 Slash 再确认
- 自由表达兜底：允许直接说自然句（例如“我想创建一个文件夹，里面帮我写一个笑话”），会自动映射到 `/task`（单仓库场景自动推断 repo）
- 语音消息识别：识别音频附件（ogg/webm/mp3/wav/flac）为中文文本，再按自然语言命令执行确认流
- 语音通话基础控制：`/voice_join` `/voice_leave` `/voice_status`（先支持入会待命）
- Gemini 智能理解（可选）：当规则解析失败时，自动调用 Gemini 把自然语言转成结构化命令或给出中文帮助回复
- 短期上下文记忆：按用户+频道保存最近输入，辅助 Gemini 理解“这个/刚刚那个/上一个”这类指代
- 长期记忆：用户记忆 + Gemini 建议记忆 + 周期性失败复盘进化记忆
- 三重访问控制：用户 ID + 频道 ID + 角色 ID
- 任务状态机：`queued -> awaiting_plan_approval -> generating_patch -> awaiting_approval -> applying_patch -> running_tests -> ready_to_commit -> committed`
- Repo 互斥锁：同仓库串行，不同仓库并行
- 补丁 5 层校验：语法/路径/敏感文件/规模/`git apply --check`
- 测试失败不自动提交（保留改动，等待 `/run` 或 `/reject`）
- 危险命令二次确认：`rm|del|format|git push|docker|kubectl|ssh|scp|Invoke-WebRequest`
- SQLite 持久化与日志留存清理
- VS Code 桥接：`code -r` `code -g` `code chat`

## 目录结构

- `src/discord` Discord 网关与交互
- `src/orchestrator` 任务编排与状态机
- `src/adapters` Codex CLI 适配器
- `src/engines` Git/Patch/VSCode 引擎
- `src/store` SQLite 状态存储
- `src/security` 访问控制与命令风控
- `src/nlp` 自然语言解析
- `tests` 核心单测

## 环境要求

- Node.js >= 14.16
- 本机已安装并可执行：
  - `codex`
  - `git`
  - `code` (VS Code CLI)
- Discord Bot 已创建并拿到 token

## 配置

1. 安装依赖

```bash
npm install
```

2. 准备配置文件

```bash
copy .env.example .env
copy config\repos.example.json config\repos.json
```

3. 编辑 `.env`

- `DISCORD_BOT_TOKEN` Bot Token
- `DISCORD_APP_ID` Application ID
- `DISCORD_PROXY_URL` 可选，网络受限时填代理（如 `http://127.0.0.1:10809`）
- `CODEX_EXECUTABLE` 可选，指定 Codex CLI 路径（出现 `spawn codex ENOENT` 时建议设置）
- `GEMINI_API_KEY` 可选，开启 Gemini 语义理解增强
- `GEMINI_MODEL` 可选，默认 `gemini-2.0-flash`
- `GEMINI_API_BASE_URL` 可选，默认 `https://generativelanguage.googleapis.com/v1beta`
- `GEMINI_TIMEOUT_MS` 可选，请求超时（毫秒），默认 `20000`
- `GEMINI_FIRST` Gemini 优先理解开关（默认 `true`）
- `GEMINI_STRICT_MODEL` 严格使用 `GEMINI_MODEL`（默认 `false`，建议保持关闭以便自动回退模型）
- `MEMORY_GEMINI_AUTO` Gemini 判断“值得记住”时是否自动写入本地记忆（默认 `true`）
- `MEMORY_CONTEXT_LIMIT` 每次注入给 Gemini 的记忆条数（默认 `8`）
- `USER_CONTEXT_LIMIT` 每次注入给 Gemini 的最近用户输入条数（默认 `12`）
- `USER_CONTEXT_RETENTION_DAYS` 用户输入上下文保留天数（默认 `14`）
- `EVOLUTION_ENABLED` 是否开启周期性自我复盘进化（默认 `true`）
- `EVOLUTION_INTERVAL_MINUTES` 进化循环间隔分钟（默认 `45`）
- `EVOLUTION_FAILURE_CONTEXT_LIMIT` 每轮进化读取失败任务数量（默认 `12`）
- `EVOLUTION_MEMORY_LIMIT` 每轮注入历史进化记忆数量（默认 `12`）
- `GOOGLE_API_KEY` 可选，开启语音识别（Google Speech-to-Text）
- `GOOGLE_SPEECH_LANGUAGE_CODE` 语音语言，默认 `zh-CN`
- `GOOGLE_SPEECH_TIMEOUT_MS` 语音识别超时，默认 `20000`
- `ALLOWED_USER_IDS` 允许发起任务的用户 ID（逗号分隔）
- `ALLOWED_CHANNEL_IDS` 允许执行命令的频道 ID（逗号分隔）
- `ALLOWED_ROLE_IDS` 允许角色 ID（逗号分隔，可留空表示不限制角色）
- `BOT_PREFIX` 自然语言前缀（默认 `!codex`）
- `REQUIRE_TRIGGER` 是否必须 `@bot` 或前缀触发（默认 `false`，即允许在白名单频道直接自然语言）
- `ALLOW_LOCAL_PATH_REPO` 是否允许 `/task repo=<本地路径>`（默认 `true`）
- `PLAN_APPROVAL_REQUIRED` 是否启用“执行前计划确认”（默认 `true`）。设为 `false` 后，`/task` 会直接进入补丁生成阶段。
- `AUTO_STASH_BEFORE_APPLY` 是否在 `/approve` 前自动 `git stash -u` 清理脏工作区（默认 `true`）

4. 编辑 `config/repos.json`

- `id`: repo 标识（供 `/task repo=<id>` 使用）
- `path`: 本地仓库路径
- `defaultBaseBranch`: 默认基线分支
- `testProfiles`: 测试 profile -> 命令数组

## 启动

开发模式：

```bash
npm run dev
```

双击脚本（Windows）：

- `start-bot.bat`：后台启动机器人（最小化窗口），日志写入 `data/dev.log`
- `stop-bot.bat`：按 `data/bot.lock` 停止当前机器人进程并清理锁
- `restart-bot.bat`：一键重启（先停后启）

编译并启动：

```bash
npm run build
npm start
```

## PM2 常驻建议

```bash
npm install -g pm2
pm2 start "npm run dev" --name discord-codex-orchestrator
pm2 save
pm2 startup
```

## 命令示例

- `/task repo:sample prompt:"修复登录重定向" open_vscode:true`
- `/task repo:D:\work\test prompt:"分析这个目录下的代码结构"`
- `/ping`
- `/status task_id:task-xxxx`
- `/approve task_id:task-xxxx`
- `/run task_id:task-xxxx cmd:"git status"`
- `/read path:D:\work\sample-repo\README.md`
- `/read repo:sample path:new\a_share_20_30yi.md start_line:1 end_line:80`
- `/voice_join`
- `/voice_status`
- `/voice_leave`
- `/memory_add content:"我偏好中文回复，简洁一点"`
- `/memory_list limit:10`
- `/memory_list scope:system limit:10`
- `/memory_delete id:3`
- `/memory_clear`
- `/memory_auto enabled:false`

自然语言：

- `!codex task repo=sample prompt="修复登录重定向"`
- `!codex run task_id=task-xxxx cmd="npm test"`
- `!codex 创建任务 repo=sample prompt="修复登录重定向"`
- `!codex 状态 task_id=task-xxxx`
- `!codex 读取 D:\work\sample-repo\README.md`

## 测试与质量检查

```bash
npm run typecheck
npm test
npm run build
```

## 运行注意

- `/approve` 采用“立即应答 + 后台执行”模式，防止 Discord 3 秒超时。
- `/approve` 同一任务会自动去重；重复点击不会重复应用补丁。
- 新任务会先下发执行计划卡片（Plan Ready）；只有确认计划后才会进入补丁生成。
- 可通过 `.env` 的 `PLAN_APPROVAL_REQUIRED=false` 关闭计划确认，恢复为旧流程（直接生成补丁）。
- `/ping` 会显示当前 Gemini 模型与 `require_trigger` 状态，便于确认实际运行配置。
- 当 `ALLOW_LOCAL_PATH_REPO=true` 时，`/task` 的 `repo` 支持本地 Git 仓库绝对路径；也可继续使用 `config/repos.json` 的 repo id。
- 本地记忆按用户隔离存储在 SQLite。你可用 `/memory_*` 手动管理；Gemini 自动记忆受全局 `MEMORY_GEMINI_AUTO` 和用户级 `/memory_auto` 双重控制。
- 用户输入上下文按“用户+频道”隔离存储在 SQLite，默认保留 14 天，用于提升自然语言连续对话理解，不会直接触发执行。
- 当 `EVOLUTION_ENABLED=true` 时，机器人会周期性分析失败任务，沉淀系统级进化记忆（可用 `/memory_list scope:system` 查看）。
- 若 `/approve` 被工作区脏改动阻塞，任务会保持在可重试状态（`awaiting_approval`），先清理本地改动再重试即可。
- 当 `AUTO_STASH_BEFORE_APPLY=true` 时，机器人会在应用补丁前自动 stash 本地脏改动。若只剩无关未跟踪文件（如被占用目录）将继续执行；仅在仍有 tracked 变更时才阻塞。
- 自动提交只提交本次补丁已暂存内容，不会把仓库里无关未跟踪文件一并提交。
- 每个任务在补丁中都会自动附带一个唯一文件：`bot_tasks/<taskId>.md`，用于任务留痕和快速定位，不会与其他任务重名。
- 高危命令会发出确认卡片；点击确认后才实际执行。
- 日志会对 token/cookie/password 等字段做脱敏。
- 默认不执行 `git push`。
- 如果启动时报 `ETIMEDOUT ...:443`，通常是网关连通问题。请在 `.env` 设置 `DISCORD_PROXY_URL=http://127.0.0.1:10809`（按你的代理端口调整）。
- 如果任务时报 `Repo path not found` 或 `not a git repository`，请检查 `config/repos.json` 中该 repo 的 `path` 是否存在且为本地 Git 仓库，然后重启机器人。
- 对 Codex 建议的测试命令会做过滤（例如 `git apply ... <patch-file>` 这类占位命令会忽略），并自动回退到仓库默认测试。
- Gemini 只用于“意图解析/答复增强”，不会直接执行命令或改代码；所有高风险动作仍走原有确认链路。
- 当主模型遇到 `429/503/网络超时` 或模型不支持时，会自动尝试回退模型（`gemini-2.0-flash` / `gemini-1.5-flash`）。
