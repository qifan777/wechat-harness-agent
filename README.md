# 用 AI 做一个微信个人助理

在手机微信里发一句话，你电脑上的 AI 助理就去翻聊天记录、读本地资料，把待办按你的习惯整理好，存成一份文档。

![用 AI 做一个微信个人助理](docs/assets/cover.svg)

这个教程不要求你会写代码。你只需要会复制粘贴：把想要的功能用中文告诉 AI 编程工具，写代码、跑测试、修错误都交给它。我们从一个空文件夹开始，一共 4 章，每章多一项本事。

## 做完之后，你能得到什么

**微信官方 ClawBot 插件，直接在微信里使唤它。** 不用第三方破解协议，不用买云服务器，扫个码就能连上。文字、语音、图片、文件都可以发，它在你自己的电脑上干活。

**微信聊天记录 MCP 工具，群聊总结一句话搞定。** 教程会带你把开源项目 `chatlog-archive` 改造成后台每 60 秒自动增量同步的 MCP（Model Context Protocol）服务。助理可以按需搜索任意群聊和私聊的历史，"帮我看看某个群最近一周聊了什么"，问一句就有总结。

**Harness Agent 工程实战，不手写代码。** 不只是调个大模型接口聊天，而是搭一个真正能干活的 Harness Agent：能读写本地工作目录（Workspace），能自己多步调用工具完成任务（ReAct 循环），还能跨会话记住你的个人偏好（Memory）。全程用 OpenSpec 规格驱动开发（SDD）：每章把中文需求发给 AI 编程工具，写代码、跑测试、修 Bug 都由它完成。

## 一章一件事

每学完一章，你就能多对它说一类话：

| 章节 | 你对它说 | 这一章做了什么 |
| --- | --- | --- |
| [01 用 AI 创建你的第一个 Agent](docs/chapters/01-minimal-agent.md) | "随便问个问题" "在工作目录里存个文件" | 用 AI 建项目，接上模型 API，启用 Mastra 内置的 Workspace 和 ReAct 多步工具循环 |
| [02 把它搬进微信](docs/chapters/02-wechat-agent.md) | 在手机微信上发消息 | 扫码连上微信，让它回复时会显示"正在输入"，长回复自动分段 |
| [03 让它记住你](docs/chapters/03-agent-memory.md) | "把第二项展开说说" "记住，以后按负责人分组" | 能连续追问，重启后接着聊，换新话题时你的偏好依然保留 |
| [04 改造聊天归档项目，通过 MCP 接入助理](docs/chapters/04-chatlog-mcp.md) | "搜一下关于预算的聊天记录" "总结这个群，存成 Markdown" | 把只能手动全量导出的 `chatlog-archive` 改造成定时增量同步的 MCP 服务器，接入微信助理 |

## 开始之前

你需要准备：

- 一台电脑（Windows、macOS、Linux 都行），装好 Node.js 24
- 一个大模型的接口地址、密钥和模型名（需要支持工具调用，后面的章节要用）
- 从第 2 章开始：一个能使用 ClawBot 插件的微信号

先说一件要当心的事：这个助理可以读写你电脑上的文件，也能执行命令。刚开始试的时候，建议只让它使用项目里专门的 `workspace` 文件夹，不要指向存着重要资料的目录。

## 先跑起来看看

看不懂命令也没关系，第 1 章会一步步带你做。想先试试的话：

```sh
npm ci
cp .env.example .env   # 打开 .env，填入模型的接口地址、密钥和模型名
npm run ask -- "用一句话介绍你自己"
```

看到一段中文回答，就说明模型接通了。接着运行 `npm run wechat`，按终端提示用手机微信扫码，就能在微信里和它私聊。发 `新对话` 可以开启新话题，它记住的偏好会保留。

运行中遇到报错，把错误信息复制给 AI，一般都能帮你解决。

## 给想了解细节的人

开发方式叫"规格驱动开发"：先用文字写清楚助理该有什么行为，再让 AI 照着实现，最后自己运行验证。AI 写偏了，有规格可以对照；每次改动也都有记录。规格用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 管理（版本 1.16.0，`spec-driven` 模板）。

| 用途 | 用什么 |
| --- | --- |
| 语言与运行环境 | TypeScript、Node.js、npm |
| 助理框架 | Mastra |
| 模型接口 | OpenAI Chat Completions 格式 |
| 对话与记忆 | `@mastra/memory` |
| 本地存储 | `@mastra/libsql` |
| 微信接入 | `@wechatbot/wechatbot` 2.2.0 |
| 聊天记录接入 | Mastra 的 MCP 集成 |

开发时常用的检查命令：

```sh
npm run typecheck
npm run build
npm test
```

## 参考资料

[Mastra 文档](https://mastra.ai/docs) · [Mastra Memory](https://mastra.ai/docs/memory/overview) · [OpenSpec](https://github.com/Fission-AI/OpenSpec) · [WeChatBot SDK](https://github.com/corespeed-io/wechatbot) · [`@wechatbot/wechatbot` on npm](https://www.npmjs.com/package/@wechatbot/wechatbot)

---

## 联系方式

gpt/claude/gemini/grok/muse代充：ljc666max

详细价格查看https://shop.jarcheng.top/

其他关于程序运行安装报错请加QQ群：

- 416765656（满）
- 632067985（满）
- 1102705673