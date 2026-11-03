# Design

## Context

项目已有 Node.js 24、npm、TypeScript ESM 与严格模式配置，源码目录仅有占位文件，没有现有规格或 Agent。开发依赖目前使用 `^`，需要一并改为精确版本。动机见 [proposal.md](./proposal.md)。已有教程约定 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`；README 已描述尚未实现的 CLI 行为，实施时需与实际命令和测试对齐。

本次引入 `@mastra/core` 构建 Agent，并开启内置工作空间文件工具（`Workspace` + `LocalFilesystem`）。

## Goals / Non-Goals

**Goals:** 配置在请求前验证，模型访问可用本地兼容服务测试，Agent 原生挂载限定在 `./workspace` 目录的内置文件读写工具，CLI 所有输出均经过受控边界；仅加载必要模块，保持单次调用生命周期。

**Non-Goals:** 不构建 Mastra 服务端或 Web 界面，不引入数据库、多轮记忆、微信或调度。

## Decisions

### 1. 编译后运行，分离三个职责

计划使用 `src/cli.ts` 编排参数检查、配置、生成与输出，`src/config.ts` 负责环境加载和校验，`src/agent.ts` 创建 Mastra Agent（含内置 `Workspace`）。`ask` 脚本先用现有 `tsc` 构建，再运行编译后的 CLI；沿用 ESM 与 NodeNext。相较新增 `tsx` 或开发服务器，这不增加执行工具依赖且直接复用现有构建配置。

先检查一个非空参数，再加载环境并验证三项配置；配置错误不得启动模型请求。普通错误统一写入 stderr，退出码 1；成功打印非流式文本，退出码 0。npm 自身的脚本提示与应用输出区分验收。

### 2. Mastra Agent 模型配置与内置 `Workspace` 文件工具

使用 `@mastra/core/agent` 的 `Agent`，设置稳定内部 id、名称“个人资料助理”和“你是个人资料助理，请用中文简洁回答”的指令：
- **模型配置**：直接向 `Agent` 的 `model` 字段传入配置对象 `{ id: \`openai/${config.modelName}\`, url: config.baseUrl, apiKey: config.apiKey }`，接入 OpenAI Chat Completions 兼容接口。
- **内置 `Workspace` 文件与命令工具**：从 `@mastra/core/workspace` 导入 `Workspace`、`LocalFilesystem` 与 `LocalSandbox`，配置 `LocalFilesystem({ basePath: workspaceDir, contained: false })`（默认工作目录为 `./workspace`，`contained: false` 允许访问本机其他有权限的路径）与 `LocalSandbox({ workingDirectory: workspaceDir })`（开启 `execute_command` 等本地命令工具），挂载到 `Agent` 的 `workspace` 属性上。

不启用 Mastra memory、storage 或默认遥测输出。实施时锁定 `@mastra/core` 具体稳定版本，不以 `latest` 安装。

### 3. Node 原生环境加载与 `.env.example`

使用 Node.js 24 原生 `.env` 加载能力，读取项目根目录文件，仅忽略文件不存在的情况；文件不可读或格式加载失败给出固定中文配置错误。进程环境优先，包括显式空值。验证三项变量的缺失、空串及空白，固定顺序列出缺失名称。

`.env.example` 预填示例地址和模型名，密钥留空：
```dotenv
MODEL_BASE_URL=https://ai.jarcheng.top/
MODEL_API_KEY=
MODEL_NAME=gpt-6.1-sol
```

### 4. 固定错误与输出脱敏

CLI 顶层捕获配置、初始化和请求异常，仅输出允许的中文消息，不序列化未知错误、cause、配置或请求。调用失败统一提示检查地址、密钥、模型名与网络；这比输出服务原文更容易保证密钥不泄露，但诊断信息较少。禁用可能输出请求内容的日志和遥测，验证异常发生在初始化阶段时也不会绕过该边界。

密钥只用于认证，不注入提示词；最终回答及应用消息打印前遮蔽当前密钥所有字面匹配，避免兼容服务意外回显。测试仅使用合成密钥，不读取用户真实凭证。空文本视为失败，避免成功退出却无回答。

### 5. 精确依赖与分层验证

所有直接依赖（含现有开发依赖）改为具体版本并更新 `package-lock.json`，用 `npm ci` 验证。自动化测试优先使用 Node 自带测试运行器，不引入测试框架：配置校验与 `Workspace` 初始化可做单元测试，子进程 CLI 配合本地 HTTP 兼容服务检查端点、模型、消息、工具挂载、认证及 stdout/stderr/退出码。无效输入和缺失配置断言服务收不到请求；正常、错误回显、空回复均覆盖。

## Risks / Trade-offs

- [第三方日志绕过错误边界] → 关闭日志/遥测，以子进程捕获全部输出，使用服务错误回显合成密钥的用例验证。
- [`./workspace` 目录初始不存在] → 在初始化 `LocalFilesystem` 前通过 `fs.mkdirSync('./workspace', { recursive: true })` 确保工作目录存在，并在 `.gitignore` 中忽略 `./workspace/` 下的本地运行文件。
- [每次先编译增加启动耗时] → 最小版本接受该成本，保持运行流程和依赖简单。

## Migration Plan

无数据迁移。实施后在 Node.js 24 运行 `npm ci`、类型检查、构建和测试，复制 `.env.example` 到本地 `.env` 填入 API Key 后人工验收。失败时可还原新增 CLI/Agent/配置模块、npm 脚本与依赖声明及锁文件。
