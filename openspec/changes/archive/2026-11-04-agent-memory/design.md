# Design

## Context

项目已完成第 1 章 `minimal-agent` 与第 2 章 `wechat-agent`：当前 `src/agent.ts` 创建名为“个人资料助理”的 Mastra Agent（挂载了 `./workspace` 本地文件与命令工具），`src/cli.ts` 提供 `npm run ask` 命令行问答入口，`src/wechat.ts` 提供 `npm run wechat` 微信常驻监听入口。但目前 `askPersonalAssistant()` 直接调用 `agent.generate(question)`，既未配置 `Memory` 与存储后端，也未传递 `memory: { resource, thread }`，因此每次问答完全独立。

本变更在此基础上引入 `@mastra/memory@1.41.0` 与 `@mastra/libsql@1.29.0`，使用本地 SQLite 文件持久化多轮会话历史（`thread` 维度）与长期个人偏好（`resource` 维度 Working Memory）。业务动机见 [proposal.md](./proposal.md)，行为契约见 [specs/agent-memory/spec.md](./specs/agent-memory/spec.md)。

## Goals / Non-Goals

**Goals:**
- 使用 `@mastra/libsql` 的 `LibSQLStore` 将会话消息与用户工作记忆保存在本地 `.memory/memory.db`，零外部数据库部署成本，进程重启后数据不丢失。
- 清晰分离两个记忆维度：`thread` 维度保存最近 20 条对话历史（`lastMessages: 20`），支持连续追问；`resource` 维度保存跨会话长期偏好（`workingMemory: { enabled: true, scope: 'resource', template: ... }`），支持开启新对话后偏好依然保留。
- 在本地 `.memory/sessions.json` 中轻量持久化每个 `resource` 当前活跃的 `threadId`，支持微信端（`新对话` / `/new`）与命令行端（`--new` / `新对话` / `/new`）即时切换新会话且不调用大模型。
- 保持现有无 `memoryOptions` 调用时的向后兼容（使第 1、2 章已有的单元测试无需推倒重来，同时为新增记忆能力提供完整的端到端与单元验证）。

**Non-Goals:**
- 不启用 `semanticRecall`（向量检索），不引入任何 Embedding 模型或向量库配置。
- 不实现自动生成会话标题（`generateTitle: false`），避免每次新会话产生额外的后台 LLM 请求。
- 不实现多步长任务进度反馈、中途取消或定时任务（分别留待第 4、5 章）。

## Decisions

### 1. 存储与记忆模块设计（`src/memory.ts`）

新增 `src/memory.ts` 集中管理 Mastra `Memory`、`LibSQLStore` 及活跃会话映射：
- **本地 SQLite 存储初始化**：
  - 默认记忆目录为项目根目录下的 `.memory/`（可通过参数 `memoryDir` 覆盖，方便测试使用临时目录隔离）。
  - 在创建 `LibSQLStore` 前先调用 `fs.mkdirSync(memoryDir, { recursive: true })` 确保父目录存在，防止 SQLite 报 `SQLITE_CANTOPEN`。
  - 构造 `new LibSQLStore({ id: "personal-assistant-storage", url: \`file:\${dbPath}\` })`（Mastra v1 要求显式传入 `id`）。
- **`Memory` 配置**：
  - `lastMessages: 20`：保留当前 `thread` 最近 20 条消息，兼顾多轮追问连贯性与上下文窗口开销。
  - `semanticRecall: false`、`generateTitle: false`：显式关闭向量检索与自动标题生成，避免额外 API 调用或因缺少 embedder 报错。
  - `workingMemory`：
    ```ts
    workingMemory: {
      enabled: true,
      scope: "resource",
      template: `# 用户长期偏好与个人资料
- **称呼与身份**:
- **回复风格偏好**:
- **待办与资料整理习惯**:
- **常驻背景与长期事项**:
`,
    }
    ```
  - 同时对 `memory` 与 `storage` 调用 `__setLogger(noopLogger)`，保持终端输出干净且不泄露内部结构。

### 2. 活跃会话（`threadId`）持久化与“新对话”指令

为了同时满足“重启后续聊”和“发送 `新对话` 开启新话题”：
- **会话状态文件（`.memory/sessions.json`）**：
  - 维护 `Record<resourceId, threadId>` 的 JSON 映射文件。
  - `getOrCreateActiveThreadId(resourceId, memoryDir)`：若本地映射中已有该 `resourceId` 的 `threadId` 则直接返回（实现跨调用、跨进程重启续聊）；若不存在则生成新的唯一 `threadId`（如 `thread-${resourceId}-${Date.now()}-${random}`），写入 `sessions.json` 后返回。
  - `rotateActiveThreadId(resourceId, memoryDir)`：为指定 `resourceId` 生成全新的 `threadId` 并更新 `sessions.json`，不会修改或清除数据库中该 `resourceId` 的 `mastra_resources`（Working Memory）记录。
- **“新对话”指令识别（`isNewConversationCommand(text)`）**：
  - 去除首尾空白后匹配 `"新对话"`、`"开启新对话"`、`"/new"`（忽略大小写）或 CLI 参数 `"--new"`。
  - 命中后直接调用 `rotateActiveThreadId()` 并立即返回固定中文确认文案：`已开启新对话，之前的长期偏好依然保留。`，不调用大模型 API。

### 3. Agent 指令与调用接口扩展（`src/agent.ts`）

- **系统指令升级**：
  - 将 `ASSISTANT_INSTRUCTIONS` 扩展为同时包含原有“你是个人资料助理，请用中文简洁回答。”以及工作记忆使用说明：“当用户要求‘记住……’或表达个人偏好、整理习惯（如按负责人分组）时，请主动调用 updateWorkingMemory 工具更新长期偏好，并在后续所有对话中自动遵循已记录的偏好。”（保留原前缀以兼容既有断言）。
- **记忆挂载与可选会话参数**：
  - `CreateAgentOptions` 增加可选 `memoryDir?: string | undefined` 与 `enableMemory?: boolean | undefined`（默认为 `true`）。当 `memoryDir` 提供或默认开启时，为 Agent 挂载 `createPersonalMemory(memoryDir)`。
  - `askPersonalAssistant(agent, question, secrets, memoryContext?: { resource: string; thread: string })`：
    - 当传入 `memoryContext` 时，调用 `agent.generate(question, { memory: { resource: memoryContext.resource, thread: memoryContext.thread } })`。
    - 当未传入 `memoryContext` 时，保持 `agent.generate(question)` 无状态调用，确保第 1、2 章已有的纯函数测试无缝通过。

### 4. 微信端与命令行端接入（`src/wechat.ts` & `src/cli.ts`）

- **微信端（`src/wechat.ts`）**：
  - 在 `handleIncomingWeChatMessage` 中，若用户发送的纯文本消息匹配 `isNewConversationCommand(rawText)`，则跳过模型调用，直接触发 `onNewConversation(msg.userId)` 切换 `threadId` 并向用户发送 `已开启新对话，之前的长期偏好依然保留。`。
  - 对于普通私聊消息，以 `msg.userId` 作为 `resource`，通过 `getOrCreateActiveThreadId(msg.userId, memoryDir)` 获取当前 `threadId`，调用 `askPersonalAssistant(agent, prompt, secrets, { resource: msg.userId, thread: threadId })`。
- **命令行端（`src/cli.ts`）**：
  - 固定本地命令行用户标识 `CLI_RESOURCE_ID = "local-cli-user"`。
  - 若参数为 `["--new"]`、`["新对话"]` 或 `["/new"]`，无需请求模型（但仍可在校验或直接切换后打印 `已开启新对话，之前的长期偏好依然保留。\n` 并以退出码 0 结束）。
  - 对于普通问题参数，获取 `CLI_RESOURCE_ID` 的当前活跃 `threadId`，携带 `{ resource: CLI_RESOURCE_ID, thread: threadId }` 调用 `askPersonalAssistant`。

## Risks / Trade-offs

- **[模型未触发 `updateWorkingMemory` 工具或多次工具步数]** → 在 `ASSISTANT_INSTRUCTIONS` 中明确指示模型在收到“记住……”时调用 `updateWorkingMemory` 工具，并确保 Agent 生成时支持工具调用多步往返（Mastra 默认支持多步 tool call 直至生成最终文本回答）。
- **[本地 SQLite 目录未创建导致 `SQLITE_CANTOPEN`]** → 在 `createPersonalMemory` 中始终先同步创建 `memoryDir` 目录。
- **[既有单元测试期望默认无历史]** → `askPersonalAssistant` 仅在显式传入 `memoryContext` 时启用 `memory: { resource, thread }`；而 `cli.ts` 与 `wechat.ts` 默认传入各自基于 `cwd` / `memoryDir` 的 `memoryContext`。由于 `cli.test.ts` 中每个测试使用独立的临时 `cwd`（或单次调用），互不污染，同时新增专门的多轮记忆与 Working Memory 测试。

## Migration Plan

1. 安装精确锁定版本的 `@mastra/memory@1.41.0` 和 `@mastra/libsql@1.29.0`，更新 `package.json` 与 `package-lock.json`。
2. 在 `.gitignore` 中添加 `.memory/` 忽略规则。
3. 新增 `src/memory.ts`，更新 `src/agent.ts`、`src/cli.ts`、`src/wechat.ts` 并补充单元测试 `src/memory.test.ts`。
4. 运行 `npm run typecheck`、`npm run build`、`npm test` 验证全部通过。
