# Tasks

## 1. 安装依赖与实现 MCP 客户端模块

- [x] 1.1 安装 `@mastra/mcp@2.8.0`（使用 `--save-exact` 精确锁定版本），并在 `.env.example` 中补充可选的 `CHATLOG_MCP_SCRIPT` 与 `CHATLOG_PYTHON_BIN` 配置说明，检查 `package.json` 确认无 `^`、`~` 或 `latest`
- [x] 1.2 创建 `src/mcp.ts`，实现 `loadChatlogMcpConfig`、`createChatlogMcpClient` 与 `connectChatlogMcpTools`（支持未配置或脚本不存在时优雅降级返回空工具集，配置有效时通过 `@mastra/mcp` `MCPClient` 加载 `stdio` 工具并提供 `disconnect()` 回收方法）

## 2. 接入 Agent、CLI 与微信常驻入口

- [x] 2.1 更新 `src/agent.ts`：在 `CreateAgentOptions` 与 `createPersonalAssistantAgent` 中支持动态挂载外部 `tools`（不硬编码 MCP 工具名到系统提示词）
- [x] 2.2 更新 `src/cli.ts` 与 `src/wechat.ts`：在启动时通过 `connectChatlogMcpTools` 加载可选的 MCP 工具传入 Agent，并在 `src/cli.ts` 的 `finally` 块中调用 `disconnect()` 确保单次命令执行完后立即释放 MCP 子进程

## 3. 自动化测试与真实 MCP 联调验证

- [x] 3.1 创建 `src/mcp.test.ts` 并更新 `src/agent.test.ts`、`src/cli.test.ts`，覆盖：未配置 `CHATLOG_MCP_SCRIPT` 时优雅降级、配置有效 `stdio` MCP 脚本（含真实 `/Users/macm/Documents/workspace/clone/chatlog-archive/scripts/wechat/60_mcp_server.py`）时成功发现并调用 `chatlog_wechat_status` 等 6 个工具、CLI 结束后调用 `disconnect()` 释放子进程、以及 `@mastra/mcp@2.8.0` 版本精确锁定测试，运行 `npm run typecheck` 与 `npm test` 全部通过

## Workflow follow-up

- 完成运行验收后，使用 `openspec-archive-change` 归档 `chatlog-mcp` 变更。
