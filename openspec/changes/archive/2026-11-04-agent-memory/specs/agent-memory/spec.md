# Spec Delta

## Purpose

为“个人资料助理”提供本地持久化的多轮会话历史（`thread` 维度，保留最近 20 条消息）与跨会话长期偏好工作记忆（`resource` 维度 Working Memory），支持在微信私聊与命令行中连续追问、进程重启后续聊，以及通过“新对话”指令隔离旧话题上下文同时保留用户长期偏好。

## ADDED Requirements

### Requirement: 本地持久化会话历史与多轮连续追问
系统 SHALL 使用本地 SQLite 数据库文件（默认位于 `.memory/memory.db`，目录不存在时自动创建）持久化保存对话消息，并为 Agent 开启最近 20 条消息的会话历史（`lastMessages: 20`）。当同一用户（`resource`）在同一活跃会话（`thread`）中连续发送消息时，系统 SHALL 自动加载该会话已保存的历史消息一并发送给模型，支持基于上下文的连续追问；进程停止并重新启动后，系统 SHALL 自动恢复用户上次活跃的 `thread` 及本地数据库中的历史消息，支持无缝续聊。本地记忆目录 `.memory/` MUST 被 `.gitignore` 忽略。

#### Scenario: 同一会话中连续追问上下文（含先发图片再发文字追问）
- **GIVEN** 用户在当前活跃会话中已发送“列 3 条提升专注力的建议”（或先发送了一张图片）并收到模型回复
- **WHEN** 同一用户继续发送“把第二项展开说说”（或针对刚发的图片追问“上面这张图片的内容是什么”）
- **THEN** 系统按用户串行处理消息，在请求模型时自动携带上一轮的用户消息（含多模态图片 `image_url`）与助理回答，模型基于上下文准确生成回答

#### Scenario: 进程重启后恢复活跃会话继续对话
- **GIVEN** 用户在微信或命令行中已完成一轮问答，历史消息与当前活跃 `thread` 已持久化至本地 `.memory/` 目录
- **WHEN** 进程停止并重新启动，同一用户继续提问“我们刚才聊的第 1 条建议是什么？”
- **THEN** 系统自动读取本地持久化的活跃 `thread` 与历史消息交给模型，无需重新铺垫上下文即可准确回答

#### Scenario: 本地记忆目录被 Git 忽略
- **GIVEN** 系统已运行并生成 `.memory/` 目录及数据库与会话状态文件
- **WHEN** 执行 `git status` 或 `git check-ignore` 检查 `.memory/`
- **THEN** `.memory/` 目录及其下所有文件均处于被 Git 忽略状态

### Requirement: 跨会话长期偏好记忆（Resource 级 Working Memory）
系统 SHALL 为 Agent 开启 `resource` 作用域的工作记忆（`workingMemory: { enabled: true, scope: 'resource', template: ... }`），提供包含用户称呼、回复风格、待办与资料整理习惯等条目的中文 Markdown 模板，并在系统指令中要求助理在用户提出“记住……”或表达长期偏好时主动调用工作记忆更新工具。系统 SHALL 不启用 `semanticRecall` 向量检索，不依赖额外的 Embedding 模型接口。

#### Scenario: 用户要求记住长期偏好时主动更新工作记忆
- **GIVEN** 用户在微信或命令行中发送“记住，以后整理待办都按负责人分组”
- **WHEN** Agent 处理该消息
- **THEN** Agent 接收包含工作记忆更新工具的上下文，调用工具将该偏好写入当前用户 `resource` 的工作记忆，并以中文回复确认已记住

#### Scenario: 不启用向量检索且无需额外 Embedding 配置
- **GIVEN** 仅配置了 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME` 三项基础环境变量，未配置任何额外向量或 Embedding 服务
- **WHEN** 用户进行多轮对话及更新长期偏好
- **THEN** 系统正常运行并完成记忆读写，不发起任何 Embedding 向量接口调用或报错

### Requirement: 开启新对话隔离旧上下文并保留长期偏好
系统 SHALL 在微信私聊中识别 `新对话` 或 `/new` 指令，并在命令行 `npm run ask` 中支持 `--new`、`新对话` 或 `/new` 指令。收到该指令时，系统 SHALL 为对应用户切换并持久化一个新的活跃 `thread` 标识，直接返回简短中文确认提示（如“已开启新对话，之前的长期偏好依然保留。”）而不发起模型请求。切换至新会话后，后续提问 SHALL 不再携带旧会话的聊天历史，但 MUST 继续加载并应用同一用户（`resource`）已保存的长期偏好（Working Memory）。

#### Scenario: 微信发送“新对话”或“/new”切换会话
- **GIVEN** 微信常驻进程正在运行，用户在旧会话中已有聊天记录
- **WHEN** 用户发送 `新对话` 或 `/new`
- **THEN** 系统立即为该微信用户生成并持久化新的活跃 `thread` 标识，直接向微信回复简短中文确认提示，不调用大模型；用户随后询问旧会话中的临时细节时，模型请求中不再包含旧会话的历史消息

#### Scenario: 开启新对话后长期偏好依然生效
- **GIVEN** 同一用户（相同 `resource`）此前已让助理记住“以后整理待办都按负责人分组”，随后发送 `新对话` 切换到了全新的 `thread`
- **WHEN** 用户在新会话中发送“帮我整理待办：张三准备投影仪，李四负责签到，张三还要联系场地”
- **THEN** 系统在请求模型时仍注入该用户 `resource` 级别的工作记忆（含“按负责人分组”偏好），助理按负责人分组输出整理结果

#### Scenario: 命令行支持开启新对话与多轮问答
- **GIVEN** 模型配置有效
- **WHEN** 用户运行 `npm run ask -- --new`（或 `npm run ask -- "新对话"` / `npm run ask -- "/new"`）
- **THEN** 系统为本地命令行用户切换并持久化新的活跃 `thread` 标识，在标准输出打印简短中文确认提示并以退出码 0 结束，不请求模型

### Requirement: 记忆数据脱敏与依赖精确锁定
系统 MUST 确保 `MODEL_API_KEY` 与微信登录凭证不会出现在终端输出、错误提示或发给用户的回复中。新增的 `@mastra/memory`（版本 `1.41.0`）与 `@mastra/libsql`（版本 `1.29.0`）及全部直接依赖 SHALL 使用精确版本号（无 `latest`、`^`、`~`）并锁定在 `package-lock.json` 中。

#### Scenario: 依赖版本精确锁定检查
- **WHEN** 检查 `package.json` 中的依赖声明与 `package-lock.json`
- **THEN** `@mastra/memory` 为 `1.41.0`、`@mastra/libsql` 为 `1.29.0`，所有直接依赖均为精确版本号，不包含 `latest`、`^` 或 `~`
