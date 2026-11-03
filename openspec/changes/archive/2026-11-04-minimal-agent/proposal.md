# Proposal

## Why

项目目前只有 TypeScript 和 Node.js 24 骨架，尚无可运行的问答入口。先建立一次可验证、不会泄露密钥的真实模型调用，并开启 Mastra 内置的 `Workspace` 工作目录文件工具，为个人资料助理后续接入微信、记忆与定时任务提供简洁可靠的基础。

## What Changes

- 增加 `npm run ask -- "问题"`，一次命令完成一次独立问答，打印回答后退出。
- 使用 `@mastra/core` 创建名为“个人资料助理”的 Agent，指示其使用简洁中文回答，并开启内置的 `Workspace` 文件与命令工具（默认工作目录为 `./workspace`，`LocalFilesystem` 设为 `contained: false` 不限制访问外部路径，挂载 `LocalSandbox` 支持执行本地命令）。
- 从 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME` 读取 OpenAI Chat Completions 兼容服务配置，支持本地 `.env`。
- 提供预填示例地址与模型名、密钥留空的 `.env.example`（`MODEL_BASE_URL=https://ai.jarcheng.top/`、`MODEL_API_KEY=`、`MODEL_NAME=gpt-6.1-sol`）；直接依赖使用精确版本，提交 npm 锁文件。
- 缺失配置、输入无效及调用失败均输出简短中文错误，不暴露堆栈、密钥或原始 SDK 错误。
- 不包含多轮会话记忆、微信接入或定时任务。

## Capabilities

### New Capabilities

- `minimal-agent`: 单次命令行问答入口、参数检查、Mastra Agent 身份与指令、模型配置、内置 `Workspace` 本地文件与命令工具、环境变量配置及密钥脱敏保护。

### Modified Capabilities

无；项目尚无已有规格。

## Impact

预计新增 CLI、配置加载与 Agent 定义模块（挂载 `Workspace` + `LocalFilesystem`）、`.env.example` 模板和测试，更新 npm 脚本、`.gitignore`（忽略 `./workspace/` 运行产物）、依赖锁文件及使用说明。运行继续采用 Node.js 24、npm 和现有 TypeScript ESM 配置；引入 `@mastra/core` 作为 Agent 核心依赖，不引入存储、记忆、微信或调度依赖。真实验收需要用户本地提供 API Key，自动化测试使用本地模拟服务与合成密钥。
