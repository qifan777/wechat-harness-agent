# Design

## Context

参见 `proposal.md - Why`。当前状态：
- 外部开源项目 `/Users/macm/Documents/workspace/clone/chatlog-archive` 已完成改造，其 `scripts/wechat/60_mcp_server.py` 实现了零外部依赖的 `stdio` MCP JSON-RPC 2.0 服务端（包含后台定时增量同步线程、SQLite/FTS5 归档库 `archive.sqlite3`，以及 `wechat_sync_now`、`wechat_status`、`wechat_list_chats`、`wechat_search_messages`、`wechat_get_chat_messages`、`wechat_get_recent_messages` 六个工具）。
- 本项目（`harness-tutorial`）使用 `@mastra/core@1.82.0`，与 `@mastra/mcp@2.8.0` 的 `peerDependencies`（`@mastra/core: >=1.79.0-0 <2.0.0-0`）完全兼容。

## Goals / Non-Goals

**Goals:**
- 通过 `@mastra/mcp@2.8.0` 的 `MCPClient` 以 `stdio` 方式连接 `60_mcp_server.py`，将其工具无缝注入 `createPersonalAssistantAgent`。
- 将 `CHATLOG_MCP_SCRIPT` 设计为可选环境变量配置：配置且文件存在时启用 MCP 工具；未配置或文件不存在时静默跳过，保证所有既有功能与测试零破坏。
- 确保 `npm run ask` 单次执行后正确调用 `mcpClient.disconnect()`，防止 `60_mcp_server.py` 子进程驻留导致 CLI 无法退出。

**Non-Goals:**
- 不在本仓库复制 `chatlog-archive` 的 Python 代码，而是通过 `CHATLOG_MCP_SCRIPT` 路径跨进程调用 `stdio` MCP 服务。
- 不要求在无 Python 环境或未配置 `CHATLOG_MCP_SCRIPT` 的机器上强制启动 MCP。

## Decisions

### 1. MCP 配置解析与优雅降级（`src/mcp.ts`）
- **决定**：
  - 新增 `src/mcp.ts` 模块，提供 `loadChatlogMcpConfig(options)`：從 `env` 或 `.env` 文件读取 `CHATLOG_MCP_SCRIPT` 与 `CHATLOG_PYTHON_BIN`（默认 `"python3"`）。
  - 若 `CHATLOG_MCP_SCRIPT` 未设置、为空字符串，或者 `fs.existsSync(resolvedScriptPath)` 为 `false`，则返回 `null`（不抛错），使上层调用直接跳过 MCP 挂载。
  - 若路径存在，则使用 `@mastra/mcp` 的 `MCPClient` 创建客户端：
    ```ts
    new MCPClient({
      id: "chatlog-mcp-client",
      registerProcessHooks: false,
      servers: {
        chatlog: {
          command: config.pythonBin,
          args: [config.scriptPath],
        },
      },
    })
    ```
  - 提供 `connectChatlogMcpTools(options)` 返回 `{ client, tools, disconnect }`，其中 `tools = await client.listTools()`；若连接或 `listTools()` 异常，安全调用 `client.disconnect()` 并降级返回空工具集，避免因外部 Python 环境问题导致主程序崩溃。

### 2. Agent 动态工具挂载与多步循环优化（`src/agent.ts`）
- **决定**：
  - 在 `CreateAgentOptions` 中增加可选的 `tools?: ToolsInput | undefined`。
  - 在 `createPersonalAssistantAgent` 中，若传入了 `options.tools` 且非空，将其传给 `new Agent({ ..., tools: options.tools })`。
  - **不在 `ASSISTANT_INSTRUCTIONS` 中硬编码任何 MCP 工具名**：MCP 的核心设计正是通过 `tools/list` 动态向模型暴露工具的 `name`、`description` 与 `inputSchema`，Agent 只需挂载 `tools` 即可由大模型自主发现并调用。
  - **多步循环上限与最终步骤文本提取**：在 `askPersonalAssistant` 调用 `agent.generate` 时显式设置 `maxSteps: 15`（避免默认的 `maxSteps = 5` 在“同步 → 查群 → 分页拉取多天记录 → 汇总”时提前耗尽步数），并优先提取最后一个已完成且无未决工具调用的步骤文本作为最终回复，避免只返回第 1 步调用工具时的过渡语（如“我来读取……”）。

### 3. CLI 与微信常驻进程的 MCP 生命周期管理
- **决定**：
  - 在 `src/cli.ts`（`runCli`）中：初始化 Agent 前调用 `connectChatlogMcpTools({ env, envFilePath })` 获取 `{ tools, disconnect }`，将 `tools` 传给 `createAgentFn(config, { workspaceDir, memoryDir, tools })`；在 `runCli` 的 `finally` 块中执行 `await disconnect()`，确保单次 CLI 问答结束后立即关闭 `stdio` 子进程。
  - 在 `src/wechat.ts`（`runWeChatDaemon`）中：启动时调用 `connectChatlogMcpTools({ env, envFilePath })` 并将 `tools` 传给 `createPersonalAssistantAgent`，在常驻期间保持连接复用（这样 `60_mcp_server.py` 内部的后台 60 秒定时同步线程也会随常驻进程持续工作）。

## Risks / Trade-offs

- **[Risk] `MCPClient` 默认注册 `exit-hook` 影响测试或宿主退出** → **Mitigation**：创建 `MCPClient` 时显式设置 `registerProcessHooks: false`，由 `runCli` 的 `finally` 块和生命周期函数显式调用 `disconnect()`。
- **[Risk] `60_mcp_server.py` 依赖其所在仓库目录读取 `config.json`** → **Mitigation**：`60_mcp_server.py` 内部通过 `HERE = Path(__file__).resolve().parent` 定位 `cfg.py` 与项目根目录 `config.json`，因此无论宿主进程 `cwd` 在哪里，只要传入 `60_mcp_server.py` 的路径即可正确解析配置与 `work/wechat/live/archive.sqlite3`。
