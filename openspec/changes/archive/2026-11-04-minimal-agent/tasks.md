# Tasks

## 1. 锁定依赖与执行基础

- [x] 1.1 选择 Node.js 24 兼容的 `@mastra/core` 具体稳定版本，以精确版本安装并验证类型导入检查通过。
- [x] 1.2 将现有开发依赖也改为精确版本，更新 npm 锁文件；验证所有直接依赖无 `latest`、`^`、`~`，Node.js 24 下 `npm ci` 成功且不改锁文件。
- [x] 1.3 配置 Node 自带测试运行器及测试执行脚本，不增加测试框架；在 `.gitignore` 中忽略 `./workspace/` 运行产物，验证测试文件能在现有 ESM/TypeScript 配置下运行。

## 2. 配置加载与安全输出

- [x] 2.1 实现根目录 `.env` 的原生加载与三项 `MODEL_*` 配置校验；添加测试覆盖文件不存在、进程变量优先（含空值）、单项及多项缺失、空串和空白，验证中文提示只含缺失变量名且退出失败。
- [x] 2.2 实现固定中文错误映射及当前密钥字面值遮蔽，避免序列化未知错误；测试错误含密钥、重复密钥和回答回显等情况，验证输出不含合成密钥、原始错误或堆栈。
- [x] 2.3 新增 `.env.example`（预填 `MODEL_BASE_URL=https://ai.jarcheng.top/`、`MODEL_API_KEY=`、`MODEL_NAME=gpt-6.1-sol`），对齐 README 中 `.env` 配置说明；验证模板无真实密钥，`git check-ignore .env` 命中。

## 3. Mastra Agent 与 Workspace 文件工具

- [x] 3.1 创建名为“个人资料助理”的 Mastra Agent，设置中文简洁指令，传入模型配置并挂载指向 `./workspace` 的 `Workspace`（`LocalFilesystem({ basePath: workspaceDir, contained: false })` + `LocalSandbox({ workingDirectory: workspaceDir })`）；不启用存储、记忆、遥测或请求日志，验证类型检查通过。
- [x] 3.2 用本地兼容 HTTP 服务测试实际 Agent 调用与 `Workspace` 工具挂载，验证请求路径、模型名、认证、问题与系统指令，以及连续两次调用无历史；测试不依赖真实密钥或外网。
- [x] 3.3 覆盖认证失败、服务错误回显密钥、网络失败和空回复，验证这些情况能进入受控失败处理；在使用说明中保留简短的地址、密钥、模型名和网络排查步骤。

## 4. 命令行入口

- [x] 4.1 增加先编译后执行的 `ask` 脚本及 CLI，检查恰好一个非空参数，执行一次生成并输出；用子进程测试正常问答、无参数、空白和多参数，验证 stdout/stderr、退出码与无效输入不发送请求。
- [x] 4.2 在 CLI 顶层接住配置、Agent 初始化与调用异常，关闭第三方日志并对最终文本脱敏；子进程捕获全部输出，验证缺失配置不请求模型、错误无堆栈、错误及成功回答回显合成密钥均不泄露。
- [x] 4.3 对齐 README 中 `npm ci`、复制环境模板、`npm run ask -- "问题"`、构建及测试命令；用本地服务按文档运行，核对单次退出与中文错误示例。

## 5. 整体验收

- [x] 5.1 在 Node.js 24 运行 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`，验证全部通过，测试不创建持久化对话数据。
- [x] 5.2 使用本地 `.env` 运行 `npm run ask -- "用一句话介绍你自己"` 及工作目录文件读写指令，人工确认真实回答为简洁中文且 `./workspace` 文件读写正常。
