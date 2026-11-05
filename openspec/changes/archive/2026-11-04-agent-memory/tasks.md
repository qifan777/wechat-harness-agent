# Tasks

## 1. 依赖安装与 Git 忽略配置

- [x] 1.1 安装精确锁定版本的 `@mastra/memory@1.41.0` 与 `@mastra/libsql@1.29.0`，验证 `package.json` 中所有直接依赖均无 `^`、`~` 或 `latest` 且 `package-lock.json` 更新成功
- [x] 1.2 在 `.gitignore` 中添加 `.memory/` 本地记忆存储目录忽略规则，并通过 `git check-ignore` 验证忽略生效

## 2. 记忆存储与活跃会话管理模块

- [x] 2.1 创建 `src/memory.ts`，实现基于 `LibSQLStore`（显式指定 `id` 并自动创建 `.memory/` 目录）与 `Memory`（`lastMessages: 20`、`workingMemory: { enabled: true, scope: 'resource', template: ... }`、关闭 `semanticRecall`）的工厂函数，以及活跃 `threadId` 持久化读写（`getOrCreateActiveThreadId`、`rotateActiveThreadId`）和“新对话”指令识别函数（`isNewConversationCommand`）
- [x] 2.2 更新 `src/agent.ts`，为“个人资料助理” Agent 挂载 `Memory`、扩展系统指令引导长期偏好更新，并在 `askPersonalAssistant` 中支持可选的 `memoryContext: { resource, thread }` 参数，同时保持无该参数时的向后兼容

## 3. 微信通道与命令行入口接入记忆与新对话

- [x] 3.1 更新 `src/wechat.ts`，在私聊消息处理中识别 `新对话` / `/new` 指令以切换活跃 `threadId` 并直接回复中文确认（不调用模型），对普通私聊消息按 `msg.userId` 自动恢复活跃 `threadId` 并携带 `{ resource: msg.userId, thread: threadId }` 调用 Agent
- [x] 3.2 更新 `src/cli.ts`（及 `README.md` 说明），支持 `npm run ask -- --new`（或 `"新对话"` / `"/new"`）切换命令行活跃会话，对普通命令行提问默认携带本地 CLI 用户的 `{ resource, thread }` 调用 Agent

## 4. 自动化测试与构建验证

- [x] 4.1 编写 `src/memory.test.ts` 并扩展测试，覆盖：同一 `thread` 连续追问上下文携带、重启后从本地 `.memory/` 恢复活跃会话、`resource` 级 Working Memory 更新与跨新会话保留、`新对话` / `/new` / `--new` 指令隔离旧会话历史且不调模型、以及依赖版本精确锁定检查，运行 `npm run typecheck`、`npm run build`、`npm test` 全部通过
