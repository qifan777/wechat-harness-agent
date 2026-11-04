# Design

## Context

项目基于 Node.js 24、npm 与 TypeScript ESM（`NodeNext`）构建。当前仓库中第 1 章变更 `minimal-agent` 位于 `openspec/changes/minimal-agent/`（尚未实施归档，`src/` 下仅有 `.gitkeep`），其设计约定了 `src/config.ts`（环境变量加载与校验）、`src/agent.ts`（创建名为“个人资料助理”的 Mastra Agent）和 `src/cli.ts`（`npm run ask` 单次问答入口）。

本变更在此基础上引入外部依赖 `@wechatbot/wechatbot`（精确锁定版本 `2.2.0`），新增 `npm run wechat` 常驻进程入口，将微信个人号（ClawBot / iLink Bot）私聊消息与现有 Agent 连通。业务动机见 [proposal.md](./proposal.md)，行为契约见 [specs/wechat-agent/spec.md](./specs/wechat-agent/spec.md)。

## Goals / Non-Goals

**Goals:**
- 复用 `minimal-agent` 的配置校验、密钥脱敏与 Mastra Agent 实例工厂，确保 `npm run ask` 与 `npm run wechat` 共用同一套模型配置与助理指令且互不干扰。
- 支持所有类型的微信私聊消息（文字、表情、语音自动转写、图片/文件/视频路径或链接、引用消息），统一转换为 Agent 可理解的输入文本交由 Agent 处理。
- 将微信消息归一化、长文本切分、发送间隔控制与 `prepare failed` 退避重试、异常脱敏设计为可独立单元测试的纯函数或可注入依赖模块，无需真实微信登录即可在自动化测试中验证核心逻辑。
- 保证常驻进程在单次模型异常、网络抖动或微信接口报错时不会崩溃退出，且任何路径均不泄露 `MODEL_API_KEY` 与微信本地登录凭证。

**Non-Goals:**
- 不实现多轮对话上下文拼接或持久化记忆（留待第 3 章）。
- 不接入定时任务或 MCP 外部工具（留待第 5～6 章）。
- 不处理微信群聊消息或好友申请。

## Decisions

### 1. 独立入口与模块复用（`src/wechat.ts` + 共享核心）

在 `src/cli.ts` 之外新增 `src/wechat.ts` 作为微信常驻进程入口，并在 `package.json` 中增加 `"wechat": "npm run build && node dist/wechat.js"`。
- **理由**：与 `ask` 脚本保持一致的“先 `tsc` 编译、再 `node` 执行”模式，不引入 `tsx` 等额外运行时依赖；两个入口各自负责终端 CLI 与微信通道的生命周期，共同调用 `src/config.ts` 和 `src/agent.ts`，避免重复定义 Agent 或破坏原有的 `npm run ask`。
- **前置衔接**：若实施本变更时 `minimal-agent` 的基础模块（`src/config.ts`、`src/agent.ts`、`src/cli.ts`）尚未落地，需先按规格补齐基础模块，再接入 `src/wechat.ts`。

### 2. `@wechatbot/wechatbot@2.2.0` 接入与本地凭证管理

使用精确版本 `2.2.0` 的 `@wechatbot/wechatbot` 建立微信个人号（ClawBot / iLink Bot）连接：
- **显式传入登录回调**：由于 `@wechatbot/wechatbot@2.2.0` 构造函数中的 `loginCallbacks` 未向内部 `Authenticator` 透传，必须在调用 `bot.login({ callbacks })` 时显式传入 `onQrUrl` 等回调，确保终端能可靠打印扫码登录链接。
- **凭证与上下文存储位置**：将微信登录凭证与 `ContextStore`（含 `context_token`）以及接收到的媒体缓存固定保存在项目根目录下的本地忽略路径（如 `.wechat/` 目录以及 SDK 默认可能读写的本地凭证文件），并在 `.gitignore` 中显式忽略这些路径。
- **首次扫码与二次复用**：启动时先校验 `MODEL_*` 环境变量（缺失则立即输出中文提示并以退出码 1 退出，不启动微信登录）。配置有效后启动客户端：当本地无有效凭证时，终端打印中文扫码引导提示与登录链接；扫码成功后凭证落盘保存，后续重启自动读取本地凭证直接进入监听状态。

### 3. 全类型私聊消息归一化、“正在输入”状态与单次生成编排

收到微信消息事件时，按固定流水线处理：
1. **来源过滤**：忽略群聊消息及机器人自身发出的消息（注意：SDK 登录凭证中的 `accountId` 形如 `xxx@im.bot` 是机器人 ID，而 `userId` 形如 `xxx@im.wechat` 是扫码主人自身的微信 ID；仅过滤 `creds.accountId` 与非用户消息，绝不过滤 `creds.userId`），仅处理个人私聊消息。
2. **全类型消息归一化（`formatInboundMessage(msg)`）**：
   - **文字与表情**：提取 `msg.text`（微信面板表情如 `[Grin]` 与标准 Unicode 表情如 `😄` 均原样保留）。
   - **语音消息**：微信服务端已完成官方 ASR 语音转写并挂载在 `msg.text`，直接使用 `msg.text` 作为用户输入；若 `msg.text` 为空且存在语音媒体链接/路径，则附带语音媒体路径说明。
   - **图片、文件、视频等媒体消息**：不拦截拒绝，提取媒体类型、文件名、本地保存路径或 URL，连同可能附带的 `msg.text` 拼成结构化描述文本（例如 `[收到图片/文件: <path_or_url>]`）交给 Agent，由 Agent 根据自身能力尝试读取或回应。
   - **引用消息（`msg.quotedMessage`）**：若存在长按引用内容，将引用消息文本作为前置上下文一并拼入本次提问。
   - **空消息处理**：仅当归一化后既无有效文本又无任何媒体信息时，忽略或回复简短提示，不调用模型。
3. **触发并持续续期“正在输入”**：对有效消息，在调用 Agent 前先调用 `bot.sendTyping(msg.userId)` 触发微信“正在输入”状态；由于手机微信客户端单次 typing 状态约 5～6 秒会自动消失，在模型生成与分段发送期间每隔 `4000ms` 定时续期一次 `sendTyping`，直到全部消息分段发送完毕后在 `finally` 中清除定时器并调用 `bot.stopTyping(msg.userId)`。若状态触发接口本身报错，仅捕获并忽略，不中断后续模型调用。
4. **独立调用 Agent**：调用现有“个人资料助理” Agent 生成回复文本，不传入历史多轮会话上下文。若返回空文本则按模型调用失败处理。

### 4. 长回复自然边界切分、1.5 秒发送限速与 `prepare failed` 退避

针对微信单条消息长度上限（4000 字符）及高频连发（如 500ms 连发第 4 条）会触发微信服务端滑动窗口阻断 `prepare failed` 的限制，采用保守阈值（单条上限 `1500` 字符，处于 `2000` 字符安全线内；相邻两条间隔 `1500ms`；遇 `prepare failed` 退避 `5000ms` 重试）：
- **分段算法（`splitReplyText(text, maxChars = 1500)`）**：
  - 若文本长度 `<= maxChars`，直接作为单条消息返回。
  - 若超过 `maxChars`，在当前窗口 `[0, maxChars]` 内按优先级寻找最后一个自然切分点：
    1. 段落边界（双换行 `\n\n` 或单换行 `\n`）；
    2. 句子边界（中文及英文句末标点：`。`、`！`、`？`、`；`、`!`、`?`、`;` 后）；
    3. 空格或逗号等次级标点；
    4. 若窗口内无任何自然边界（如连续超长无标点字符），则在 `maxChars` 处硬切分。
  - 切分后去除分段首尾多余空行，循环处理剩余文本，保证所有分段非空且顺序与原文完全一致。
- **限速与退避发送（`sendSegmentedReply`）**：
  - 依次发送切分后的每一段；在发送第 `i` 段（`i >= 1`）前固定等待 `1500ms`（1.5 秒）。
  - 若某一段发送抛出包含 `prepare failed` 的错误，等待 `5000ms`（5 秒）后自动重试一次。通过将延时函数 `sleep(ms)` 设计为可注入参数，自动化测试可传入虚拟计时函数验证等待时长、重试行为与调用顺序，无需真实等待。

### 5. 常驻进程异常隔离与双向脱敏

- **异常隔离**：每条消息的处理逻辑包裹在独立的 `try / catch` 中，同时在进程级别监听未捕获异常与 `unhandledRejection`。当单次模型请求失败或返回空内容时，向微信用户发送固定中文提示（`抱歉，助理暂时无法生成回复，请稍后重试。`）；若发送消息本身失败，则在终端标准错误输出脱敏后的简短中文提示，进程继续保持监听。
- **双向脱敏**：复用并扩展脱敏工具函数，将 `MODEL_API_KEY` 以及内存中已加载的微信凭证令牌（如 token / context_token 等敏感字段）加入敏感词表，对所有发往微信客户端的文本与打印到终端的日志统一执行字面量遮蔽，杜绝序列化原始错误对象、请求头或堆栈。

## Risks / Trade-offs

- **[前置变更 `minimal-agent` 尚未实施]** → 在 `tasks.md` 中将检查并确保基础配置、Agent 与 `ask` CLI 模块就绪列为首步前置任务，保证两个入口共同通过验证。
- **[微信高频发送或单条过长导致 `prepare failed`]** → 采用 1500 字符切分阈值（低于 2000 字符保守上限）、1500ms 固定间隔与 `prepare failed` 5000ms 退避重试；若重试后仍失败，捕获异常并记录脱敏日志，防止进程崩溃。
- **[微信媒体文件与内置 Workspace 工具联动]** → 将接收到的图片、文件、视频下载保存在工作空间可访问目录（或将路径/URL 与元信息作为文本上下文传给 Agent），使 Agent 可直接调用第 1 章已挂载的内置 `Workspace` 文件工具尝试读取或给出合理中文回应。
- **[本地微信登录凭证过期或失效]** → 捕获连接/鉴权失效错误并在终端输出简短中文提示，指引用户删除本地凭证文件后重新运行 `npm run wechat` 扫码。

## Migration Plan

无需数据迁移。实施时：
1. 安装精确版本的 `@wechatbot/wechatbot@2.2.0` 及所需依赖，锁定 `package-lock.json` 并确保无 `^`、`~` 或 `latest`。
2. 更新 `.gitignore` 忽略本地微信凭证及媒体缓存目录与文件。
3. 实现微信通道、全类型消息归一化、分段限速退避与容错逻辑，补充自动化单元测试并运行 `npm run typecheck`、`npm run build`、`npm test`。
4. 通过 `npm run ask -- "你好"` 与 `npm run wechat` 分别验收原有命令行与微信扫码收发。若需回滚，移除 `src/wechat.ts`、`package.json` 中的 `wechat` 脚本与 `@wechatbot/wechatbot` 依赖以及本地凭证目录即可。
