# minimal-agent Specification

## Purpose

为本地用户提供单次命令行问答入口与“个人资料助理” Agent 核心能力，涵盖命令行参数校验、输出与退出码、OpenAI Chat Completions 兼容模型调用、内置 `Workspace` 本地文件读写编辑与命令执行工具、环境变量配置及密钥脱敏保护。每次运行独立，不依赖多轮会话历史或后台服务。

## Requirements

### Requirement: 单次命令行问答
系统 SHALL 提供 `npm run ask -- "问题"`，把一个非空问题交给 Agent，打印其完整文本回答后以退出码 0 结束。应用自身的成功输出 SHALL 仅含回答，不包含调试信息。

#### Scenario: 成功回答
- **GIVEN** 三项模型配置有效，模型服务可用
- **WHEN** 用户运行 `npm run ask -- "用一句话介绍你自己"`
- **THEN** Agent 收到该问题，应用在标准输出打印模型回答并以退出码 0 结束

### Requirement: 检查问题参数
系统 SHALL 只接受一个非空问题参数。未提供、仅有空白或提供多个参数时，SHALL 在调用模型前以标准错误输出中文用法提示，并以退出码 1 结束。

#### Scenario: 缺少或空白问题
- **WHEN** 用户不传问题，或传入仅有空白的一个参数
- **THEN** 显示 `用法：npm run ask -- "问题"（请提供一个非空问题）`，不请求模型，退出码为 1

#### Scenario: 多个问题参数
- **WHEN** 用户传入两个或更多独立参数
- **THEN** 显示相同中文用法提示，不请求模型，退出码为 1

### Requirement: 助理身份与回答风格
助理 SHALL 名为“个人资料助理”，每次调用均携带要求其用中文简洁回答的系统指令。

#### Scenario: 中文自我介绍
- **WHEN** 用户询问“用一句话介绍你自己”
- **THEN** 发送给模型的指令包含助理名称及中文简洁回答要求，真实模型验收时回答应为简短中文自我介绍

### Requirement: OpenAI Chat Completions 兼容模型调用
系统 SHALL 使用 `@mastra/core` 读取 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME` 指定的服务地址、认证密钥和模型名，通过 OpenAI Chat Completions 兼容接口请求回答。

#### Scenario: 按环境变量配置请求模型服务
- **GIVEN** 配置了兼容服务基础地址、合成密钥和模型名
- **WHEN** 执行问答
- **THEN** 请求发往配置的兼容服务地址，模型字段等于配置值，密钥用于认证

### Requirement: 内置 Workspace 本地文件与命令工具
系统 SHALL 为 Agent 配置 `@mastra/core/workspace` 内置的 `Workspace`、`LocalFilesystem`（默认工作目录为 `./workspace`，`contained: false` 不限制访问本机外部路径）与 `LocalSandbox`（工作目录为 `./workspace`），自动确保 `./workspace` 目录存在，使 Agent 原生具备文件读写编辑与本地命令执行的工具能力。

#### Scenario: 挂载 Workspace 工具并读写文件或执行命令
- **GIVEN** Agent 已初始化并配置了指向 `./workspace` 的 `Workspace`（含 `LocalFilesystem({ basePath: './workspace', contained: false })` 与 `LocalSandbox({ workingDirectory: './workspace' })`）
- **WHEN** 用户通过命令要求助理在工作目录中创建/编辑文件、读取外部路径文件或执行命令
- **THEN** Agent 具备内置 `Workspace` 文件工具与 `execute_command` 命令工具，可正常操作 `./workspace` 及本机有权限的路径

### Requirement: 本地配置与缺失提示
系统 SHALL 支持从项目根目录 `.env` 加载配置，已有进程环境变量优先（包括空值）。任何必需变量未设置、为空或仅有空白时，SHALL 在模型初始化和请求前输出中文错误，列出全部缺失变量名，退出码为 1，不包含变量值或堆栈。

#### Scenario: 任一配置缺失
- **WHEN** 三项必需配置中任意一项或多项缺失、为空或仅有空白
- **THEN** 标准错误输出 `缺少必要的环境变量：<缺失变量名列表>，请配置后重试`，不请求模型，退出码为 1

#### Scenario: 进程环境变量覆盖文件
- **GIVEN** `.env` 和进程环境中配置了不同值
- **WHEN** 加载配置
- **THEN** 使用进程环境值；进程中显式空值仍判定缺失，不以文件值补齐

#### Scenario: 无环境文件
- **GIVEN** 根目录没有 `.env`，但进程环境提供完整配置
- **WHEN** 执行问答
- **THEN** 正常请求指定模型，不因缺少 `.env` 而失败

### Requirement: 调用失败可读与密钥不外露
系统 SHALL 在模型请求失败或没有得到非空文本回答时，在标准错误输出简短中文提示，以退出码 1 结束。系统 MUST 不将真实 API Key 写入代码、模板、日志或错误输出，不输出原始 SDK 错误、请求头、配置对象或堆栈；模型回答若包含当前密钥，MUST 在打印前遮蔽。`.env.example` SHALL 预填 `MODEL_BASE_URL=https://ai.jarcheng.top/`、`MODEL_NAME=gpt-6.1-sol` 且 `MODEL_API_KEY=` 留空，真实 `.env` SHALL 被 Git 忽略。

#### Scenario: 认证、网络、服务错误或空回答
- **WHEN** 服务返回认证错误、在错误正文中回显合成密钥、发生网络错误或未生成非空文本回答
- **THEN** 标准错误仅显示 `模型调用失败，请检查基础地址、密钥、模型名及网络后重试`，不输出密钥、原始错误正文或堆栈，退出码为 1

#### Scenario: 回答回显密钥
- **WHEN** 模型文本回答中包含当前配置的合成密钥
- **THEN** 输出中的全部该密钥字面值均被遮蔽，不泄露原值

#### Scenario: 本地凭证与模板
- **WHEN** 检查 `.env.example`、源代码、日志输出和 Git 忽略行为
- **THEN** `.env.example` 包含示例地址 `https://ai.jarcheng.top/`、模型名 `gpt-6.1-sol` 且 `MODEL_API_KEY=` 为空，代码及日志无真实密钥，本地 `.env` 被忽略

### Requirement: 每次运行无多轮会话历史与可复现依赖
系统 SHALL 只处理本次问题，不持久化或加载对话历史，不启用微信接入或定时任务。项目 SHALL 使用 Node.js 24 和 npm；所有直接生产与开发依赖 SHALL 使用精确版本号，不使用 `latest`、`^` 或 `~`，并提交匹配的 npm 锁文件。

#### Scenario: 再次运行无历史且依赖精确锁定
- **WHEN** 用户先后执行两次问答命令，并在 Node.js 24 环境检查依赖声明与 `npm ci`
- **THEN** 第二次请求不携带第一次的对话历史；直接依赖均为精确版本，`npm ci` 依照锁文件成功完成
