# Proposal

## Why

前两章完成后，“个人资料助理”虽然已经可以在命令行和微信私聊中收发消息，但每次调用模型都是无状态的独立问答：既无法在同一话题里连续追问（如“把刚才第二项展开说说”），也无法跨对话记住用户的长期个人偏好（如“记住，以后待办按负责人分组”），进程重启后上下文也会丢失。引入多轮会话历史与长期工作记忆（Working Memory）并持久化到本地数据库，才能让助理真正记住对话脉络和用户习惯。

## What Changes

- 引入并精确锁定 `@mastra/memory`（版本 `1.41.0`）和 `@mastra/libsql`（版本 `1.29.0`），使用 `LibSQLStore`（显式指定 `id`，本地数据库文件存放在 `.memory/memory.db`，初始化前自动创建 `.memory/` 目录）持久化记忆数据，无需部署外部数据库；在 `.gitignore` 中忽略 `.memory/` 目录。
- 为“个人资料助理” Mastra Agent 挂载 `Memory` 实例：
  - 开启会话历史（`lastMessages: 20`），按 `thread` 隔离并加载单次会话的最近对话上下文，支持多轮连续追问与进程重启后续聊。
  - 开启跨会话的长期偏好工作记忆（`workingMemory: { enabled: true, scope: 'resource', template: ... }`），提供结构化中文 Markdown 偏好模板（涵盖称呼、回复风格、待办/资料整理习惯、长期关注事项等），并在 Agent 系统指令中明确引导：当用户提出“记住……”或表达个人习惯与偏好时，主动调用内置工作记忆工具更新并遵循这些偏好；不启用 `semanticRecall`，避免引入额外的向量 Embedding 接口依赖。
- 微信通道（`npm run wechat`）接入会话记忆与“新对话”指令：
  - 以微信私聊发送方 `msg.userId` 作为 `resource` 标识，在本地 `.memory/` 下持久化记录每个用户当前活跃的 `threadId`，使消息多轮续接且进程重启后自动恢复当前会话。
  - 当用户发送 `新对话` 或 `/new` 指令时，直接为该用户切换并持久化一个新的 `threadId`，立即向微信返回简短中文确认提示（不调用大模型），从而隔离旧话题聊天记录，同时完整保留该用户 `resource` 级别的工作记忆（长期偏好）。
- 命令行入口（`npm run ask`）接入会话记忆与“新对话”指令：
  - 原有 `npm run ask -- "问题"` 保持兼容可用，默认复用固定的本地命令行用户 `resource` 与当前活跃 `threadId`，支持多次命令行运行间的连续追问与长期偏好共享。
  - 支持 `npm run ask -- --new`、`npm run ask -- "新对话"` 或 `npm run ask -- "/new"` 切换新的命令行会话 `threadId`，打印简短中文确认并以退出码 0 结束。
- 保持密钥与凭证安全边界：API Key、微信登录凭证及敏感信息不得出现在代码、日志、终端输出和发给用户的消息中；所有新增依赖使用精确版本号（无 `latest`、`^` 或 `~`）。
- 本变更不包含：向量语义检索（Semantic Recall）、多步长任务进度播报与取消（第 4 章）、定时任务（第 5 章）、MCP 外部工具（第 6 章）。

## Capabilities

### New Capabilities
- `agent-memory`: 基于 `@mastra/memory` 与 `@mastra/libsql` 的本地持久化会话历史（`thread` 级，最近 20 条）与跨会话长期偏好工作记忆（`resource` 级 Working Memory）、微信与命令行活跃会话持久化恢复、以及保留长期偏好的“新对话”（`新对话` / `/new` / `--new`）会话切换能力。

### Modified Capabilities
无。扩展第 1、2 章已有的 Agent、命令行与微信入口，保持原有环境变量校验、媒体消息处理、分段限速发送及密钥脱敏行为不变。

## Impact

- **依赖与配置**：`package.json` 与 `package-lock.json` 新增精确版本依赖 `@mastra/memory@1.41.0` 和 `@mastra/libsql@1.29.0`；`.gitignore` 新增 `.memory/` 本地记忆存储目录忽略规则。
- **代码模块**：
  - 新增或扩展记忆与会话管理模块（如 `src/memory.ts` 或在 `src/agent.ts` 中集成），封装 `LibSQLStore`、`Memory` 实例创建、中文偏好 Markdown 模板以及本地活跃 `threadId` 映射持久化（如 `.memory/sessions.json`）。
  - 更新 `src/agent.ts`：为 Agent 挂载 `Memory`、扩展系统指令以引导偏好记录，并支持在 `askPersonalAssistant` 中传入 `{ resource, thread }`。
  - 更新 `src/wechat.ts`：拦截 `新对话` / `/new` 会话切换指令并直接回复确认；普通私聊消息按 `msg.userId` 查找当前活跃 `threadId` 并携带 `{ resource: msg.userId, thread: threadId }` 调用 Agent。
  - 更新 `src/cli.ts` 与 `src/config.ts`：支持 `--new` / `新对话` / `/new` 切换命令行会话，普通提问默认携带本地 CLI 用户的 `{ resource, thread }` 调用 Agent。
- **测试与文档**：新增并更新针对多轮会话历史携带、重启后会话恢复、`新对话` 隔离旧上下文但保留 `resource` 级 Working Memory 偏好、CLI 与微信端会话切换及依赖锁定的自动化测试。
