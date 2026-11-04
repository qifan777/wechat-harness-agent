# Tasks

## 1. 基础前置与依赖锁定

- [x] 1.1 检查前置变更 `minimal-agent` 的核心模块（`src/config.ts`、`src/agent.ts`、`src/cli.ts` 及 `ask` 脚本）是否已就绪；若尚未实施，先按 `minimal-agent` 规格完成基础配置加载、Agent 定义与 `npm run ask` 命令行入口，并通过 `npm test` 与子进程调用验证 `npm run ask` 正常工作。
- [x] 1.2 以精确版本号安装 `@wechatbot/wechatbot@2.2.0`，确认 `package.json` 中所有直接生产与开发依赖均无 `latest`、`^` 或 `~`，更新 `package-lock.json` 并运行 `npm ci` 与 `npm run typecheck` 验证通过。
- [x] 1.3 在 `.gitignore` 中添加本地微信登录凭证及媒体缓存目录与文件规则（如 `.wechat/` 及 SDK 本地凭证文件），运行 `git check-ignore` 验证凭证路径被正确忽略。

## 2. 长回复切分、发送限速退避与敏感信息脱敏

- [x] 2.1 实现长回复分段纯函数（默认阈值 1500 字符，优先按段落换行、句子结束标点切分，超长无标点片段按阈值硬切分）与相邻消息间隔不少于 1500ms、遇到 `prepare failed` 等待 5000ms 重试的限速发送辅助函数；编写并运行单元测试验证短消息直发、3200+ 字符多段落/长句切分边界、分段顺序、1500ms 间隔调用以及 `prepare failed` 退避重试。
- [x] 2.2 扩展敏感信息脱敏函数以同时遮蔽 `MODEL_API_KEY` 与微信本地登录凭证中的敏感字段，覆盖终端日志输出与发送给微信用户的消息；编写并运行单元测试验证正常回复与异常提示中包含密钥或凭证字面量时均被遮蔽。

## 3. 全类型微信消息归一化、“正在输入”与常驻容错处理

- [x] 3.1 实现微信消息归一化与事件处理器：忽略群聊与自身消息；支持文字、表情、语音（直接使用微信自带 ASR 转写后的 `msg.text`）、图片/文件/视频（提取媒体 URL 或本地路径及元信息）以及引用消息（`msg.quotedMessage`）组装为 Agent 输入文本；编写并运行模拟测试验证文字、语音转写、图片/文件及引用消息均能正确组装并触发 Agent 调用，群聊消息被忽略。
- [x] 3.2 对有效私聊消息接入“先通过 `bot.sendTyping(msg.userId)` 触发微信正在输入状态、再独立调用个人资料助理 Agent、最后分段限速发送回复”的完整流程，并包裹单次请求与发送级 `try / catch` 容错；编写并运行模拟测试验证“正在输入”先于模型调用触发、连续两次问答不携带多轮历史、单次模型或发送报错时回复简短中文错误提示且进程不退出。

## 4. `npm run wechat` 入口、文档更新与整体验收

- [x] 4.1 创建 `src/wechat.ts` 常驻监听入口（启动前校验 `MODEL_*` 配置、通过 `bot.login({ callbacks })` 引导扫码登录并持久化复用本地凭证、注册消息处理与未捕获异常保护），在 `package.json` 中新增 `"wechat"` 脚本，并在 `README.md` 中补充 `npm run wechat` 启动与扫码说明；通过子进程测试验证缺失环境变量时输出中文提示并以退出码 1 退出。
- [x] 4.2 运行 `npm run typecheck`、`npm run build`、`npm test` 并验证 `npm run ask -- "用一句话介绍你自己"` 保持可用，且 `git status` 中不出现 `.env` 或微信登录凭证文件。
- [x] 4.3 在本地终端运行 `npm run wechat` 完成真实微信扫码登录与手机端验收：验证文字与语音问答（含“正在输入”状态）、超长回复分段限速发送（无 `prepare failed`）、发送图片/文件正常收到回复且进程不崩溃、重启进程自动复用登录凭证无需重扫。

## Workflow follow-up

- 全部自动化测试与手机微信真实验收通过后，使用 `openspec-archive-change` 归档 `wechat-agent`。
