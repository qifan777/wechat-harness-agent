# Proposal

## Why

前三章完成了个人资料助理的模型接入、工作目录文件读写（Workspace）、微信私聊接入以及多轮会话与长期偏好记忆（Memory），但助理还无法访问用户本机真实的微信历史聊天记录。通过 `@mastra/mcp` 将已完成改造（支持后台定时增量同步与 `stdio` JSON-RPC 2.0 协议）的开源项目 `chatlog-archive`（`scripts/wechat/60_mcp_server.py`）接入个人资料助理，能够让用户在微信或终端中直接检索个人微信历史聊天记录、查看近期群聊动态，并结合已记住的长期偏好将整理结果保存为 Markdown 文档。

## What Changes

- 引入并精确锁定 `@mastra/mcp`（版本 `2.8.0`，不使用 `latest`、`^` 或 `~`）。
- 配置与环境变量支持：
  - 支持从环境变量或 `.env` 读取可选的 `CHATLOG_MCP_SCRIPT`（指向 `chatlog-archive` 的 `scripts/wechat/60_mcp_server.py` 脚本路径）和可选的 `CHATLOG_PYTHON_BIN`（默认 `python3`）；在 `.env.example` 中补充说明。
  - 当未配置 `CHATLOG_MCP_SCRIPT` 或目标脚本不存在时，助理优雅降级，保持原有全部能力（问答、工作目录读写、会话与偏好记忆）正常工作，不报错崩溃。
  - 当配置了有效的 `CHATLOG_MCP_SCRIPT` 时，使用 `@mastra/mcp` 的 `MCPClient` 通过 `stdio`（`command: CHATLOG_PYTHON_BIN`, `args: [CHATLOG_MCP_SCRIPT]`）连接该 MCP 服务器，获取其暴露的工具集（`wechat_status`、`wechat_sync_now`、`wechat_list_chats`、`wechat_search_messages`、`wechat_get_chat_messages`、`wechat_get_recent_messages`）并注入给个人资料助理 Agent。
- 生命周期管理与动态工具挂载：
  - 通过 `MCPClient.listTools()` 动态发现外部 MCP 工具并注入 Agent（不将具体 MCP 工具名硬编码进 `ASSISTANT_INSTRUCTIONS`，由 MCP 协议 `tools/list` 返回的 description 与 inputSchema 驱动模型自主选择工具）。
  - 命令行端（`npm run ask`）单次问答结束后，在 `finally` 中主动断开 `MCPClient` 连接（`disconnect()`），避免 `stdio` 子进程残留导致命令行进程挂起不退出；微信常驻端（`npm run wechat`）在常驻期间复用 MCP 连接。
- 保持密钥与凭证安全边界：API Key、微信登录凭证及敏感信息不得出现在代码、日志、终端输出和发给用户的消息中。

## Capabilities

### New Capabilities
- `chatlog-mcp`: 基于 `@mastra/mcp`（`2.8.0`）的 `chatlog-archive` 微信聊天归档 MCP 服务器（`60_mcp_server.py`）可选接入、工具动态注入、未配置时的优雅降级、命令行子进程连接回收，以及跨 MCP 检索、长期偏好与工作目录文件写入的协同能力。

### Modified Capabilities
无。扩展第 1～3 章已有的 Agent、命令行与微信入口，保持原有环境变量校验、媒体消息处理、分段限速发送、多轮会话与长期偏好记忆及密钥脱敏行为不变。

## Impact

- **依赖与配置**：`package.json` 与 `package-lock.json` 新增精确版本依赖 `@mastra/mcp@2.8.0`；`.env.example` 新增可选的 `CHATLOG_MCP_SCRIPT` 与 `CHATLOG_PYTHON_BIN` 配置示例。
- **代码模块**：
  - 新增 `src/mcp.ts`：封装 `loadChatlogMcpConfig`、`createChatlogMcpClient` 与 `resolveChatlogMcpTools`，处理 `CHATLOG_MCP_SCRIPT` 校验、`MCPClient` 实例化、工具加载与 `disconnect` 安全回收。
  - 更新 `src/agent.ts`：扩展 `ASSISTANT_INSTRUCTIONS` 引导使用微信聊天归档 MCP 工具，支持在 `createPersonalAssistantAgent` 或 `askPersonalAssistant` 中挂载 MCP 工具集（`tools` / `toolsets`）。
  - 更新 `src/cli.ts` 与 `src/wechat.ts`：在存在有效 `CHATLOG_MCP_SCRIPT` 配置时加载 MCP 工具并在 CLI 结束时调用 `disconnect()`。
- **测试**：新增 `src/mcp.test.ts` 并更新现有测试，覆盖未配置时的优雅降级、配置有效时的 `MCPClient` 工具加载与 `60_mcp_server.py` 真实 `stdio` 协议握手与工具调用、CLI 退出时 `disconnect()` 回收以及依赖版本精确锁定检查。
