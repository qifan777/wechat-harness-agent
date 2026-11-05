# chatlog-mcp Specification

## Purpose

通过 `@mastra/mcp` 将支持后台定时增量同步的 `chatlog-archive` 微信聊天记录 MCP 服务器（`60_mcp_server.py`）以可选配置方式接入“个人资料助理”，使助理能够在微信私聊与命令行中调用 MCP 工具检索本机微信聊天记录、查看近期消息与归档状态，并结合长期偏好记忆与工作目录文件工具完成整理与落盘。

## Requirements

### Requirement: 可选配置接入 chatlog-archive MCP 服务器与优雅降级
系统 SHALL 支持从环境变量或 `.env` 文件读取可选的 `CHATLOG_MCP_SCRIPT`（指向 `60_mcp_server.py` 脚本路径）与可选的 `CHATLOG_PYTHON_BIN`（默认 `python3`）。当 `CHATLOG_MCP_SCRIPT` 未配置、为空或路径不存在时，系统 SHALL 优雅降级，不启动 MCP 客户端且不报错，保持原有的问答、工作目录读写与会话记忆能力正常可用。当 `CHATLOG_MCP_SCRIPT` 配置为有效存在的脚本路径时，系统 SHALL 使用 `@mastra/mcp` 的 `MCPClient` 通过 `stdio` 连接该脚本并加载其提供的微信聊天归档工具集挂载至 Agent。

#### Scenario: 未配置 CHATLOG_MCP_SCRIPT 时优雅降级正常运行
- **GIVEN** 环境变量与 `.env` 中均未设置 `CHATLOG_MCP_SCRIPT`（或指向的路径不存在）
- **WHEN** 用户运行 `npm run ask -- "你好"` 或启动 `npm run wechat`
- **THEN** 系统不报错、不启动 MCP 子进程，Agent 正常调用模型并返回中文回复

#### Scenario: 配置有效 CHATLOG_MCP_SCRIPT 时成功加载微信聊天归档 MCP 工具
- **GIVEN** `CHATLOG_MCP_SCRIPT` 指向有效的 `60_mcp_server.py`（或兼容的 stdio MCP 服务端脚本）
- **WHEN** 系统初始化 MCP 客户端并加载工具
- **THEN** `MCPClient` 通过 `stdio` 成功发现并返回 `wechat_status`、`wechat_sync_now`、`wechat_list_chats`、`wechat_search_messages`、`wechat_get_chat_messages`、`wechat_get_recent_messages` 工具并挂载给 Agent

### Requirement: 动态工具挂载与多步循环协同
系统 SHALL 将通过 `MCPClient.listTools()` 动态发现的外部 MCP 工具集挂载至 Agent（无需在系统指令中硬编码具体 MCP 工具名，直接利用 MCP 协议自身的工具描述与参数 Schema），并为 `agent.generate` 配置充足的多步循环上限（如 `maxSteps: 15`）及提取最终完成步骤文本，使 Agent 在用户询问微信聊天记录、群聊动态或归档状态时能够自主完成多步 MCP 工具调用、结合 Working Memory 中的长期偏好整理内容，或在用户要求保存时通过 Workspace 工具写入 `./workspace/` 下的 Markdown 文件。

#### Scenario: 询问微信归档状态或检索历史记录时调用 MCP 工具
- **GIVEN** 已配置有效的 `CHATLOG_MCP_SCRIPT` 且 Agent 已挂载 MCP 工具集
- **WHEN** 用户询问“查看我的微信聊天归档库状态”或“帮我看一下某个群最近聊了什么”
- **THEN** Agent 通过动态挂载的 MCP 工具完成多步检索并基于真实数据生成完整中文回答（不因中间工具调用步骤的过渡语而提前截断）

### Requirement: 命令行单次执行完毕后回收 MCP 子进程连接
在命令行入口（`npm run ask`）中，当启用了 `MCPClient` 时，系统 MUST 在单次问答执行完毕后（无论成功或抛出异常）在 `finally` 阶段主动调用 `disconnect()` 关闭 `MCPClient` 连接，确保 `stdio` 启动的 Python MCP 子进程被干净回收、命令行进程能够正常退出而不挂起。

#### Scenario: 命令行调用开启 MCP 的助理后正常断开连接并退出
- **GIVEN** 已配置有效的 `CHATLOG_MCP_SCRIPT`
- **WHEN** 执行 `npm run ask -- "查看微信聊天归档状态"` 完成单次问答
- **THEN** 系统在输出回答后主动调用 `MCPClient.disconnect()` 释放子进程并以退出码 `0` 结束

### Requirement: 依赖版本锁定与敏感信息脱敏保护
`package.json` 中新增的 `@mastra/mcp` 依赖版本 MUST 精确锁定为 `2.8.0`，不得使用 `latest`、`^` 或 `~`；MCP 工具调用与返回结果经过助理输出时 MUST 继续执行敏感信息脱敏（过滤 `MODEL_API_KEY` 与微信登录凭证）。

#### Scenario: 校验 @mastra/mcp 依赖版本精确锁定
- **GIVEN** 项目 `package.json`
- **WHEN** 检查 `dependencies["@mastra/mcp"]`
- **THEN** 其版本号精确为 `"2.8.0"`，不含 `^`、`~` 或 `latest`
