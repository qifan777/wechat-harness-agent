import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { IncomingMessage } from "@wechatbot/wechatbot";
import {
  askPersonalAssistant,
  createPersonalAssistantAgent,
} from "./agent.js";
import { runCli } from "./cli.js";
import {
  NEW_CONVERSATION_REPLY,
  getOrCreateActiveThreadId,
  isNewConversationCommand,
  rotateActiveThreadId,
} from "./memory.js";
import { startMockOpenAIServer } from "./test-helpers.js";
import {
  enqueueWeChatUserTask,
  handleIncomingWeChatMessage,
} from "./wechat.js";

describe("Agent Memory & Session Persistence (Chapter 3)", () => {
  it("locks @mastra/memory@1.41.0 and @mastra/libsql@1.29.0 with exact versions and ignores .memory/ in .gitignore (1.1 & 1.2)", () => {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    assert.equal(pkg.dependencies?.["@mastra/memory"], "1.41.0");
    assert.equal(pkg.dependencies?.["@mastra/libsql"], "1.29.0");

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const [name, version] of Object.entries(allDeps)) {
      assert.doesNotMatch(
        version,
        /^[\^~]|latest/,
        `Dependency ${name} must use exact version, got ${version}`,
      );
    }

    const gitignore = fs.readFileSync(
      path.resolve(process.cwd(), ".gitignore"),
      "utf8",
    );
    assert.match(gitignore, /^\.memory\/$/m);
  });

  it("persists active threadId per resource across calls and rotates threadId on new conversation commands (2.1)", () => {
    const tempMemoryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-memory-sessions-"),
    );

    try {
      assert.equal(isNewConversationCommand("新对话"), true);
      assert.equal(isNewConversationCommand("  /new "), true);
      assert.equal(isNewConversationCommand("--new"), true);
      assert.equal(isNewConversationCommand("开启新对话"), true);
      assert.equal(isNewConversationCommand("把第二项展开说说"), false);

      const firstThread = getOrCreateActiveThreadId(
        "user-alice@im.wechat",
        tempMemoryDir,
      );
      const secondThread = getOrCreateActiveThreadId(
        "user-alice@im.wechat",
        tempMemoryDir,
      );
      assert.equal(firstThread, secondThread);

      const bobThread = getOrCreateActiveThreadId(
        "user-bob@im.wechat",
        tempMemoryDir,
      );
      assert.notEqual(firstThread, bobThread);

      const rotatedAliceThread = rotateActiveThreadId(
        "user-alice@im.wechat",
        tempMemoryDir,
      );
      assert.notEqual(rotatedAliceThread, firstThread);
      assert.equal(
        getOrCreateActiveThreadId("user-alice@im.wechat", tempMemoryDir),
        rotatedAliceThread,
      );
      assert.equal(
        getOrCreateActiveThreadId("user-bob@im.wechat", tempMemoryDir),
        bobThread,
      );
    } finally {
      fs.rmSync(tempMemoryDir, { recursive: true, force: true });
    }
  });

  it("carries multi-turn history within a thread, persists across agent restarts, and retains resource-scoped Working Memory across new threads (2.2 & 4.1)", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-memory-e2e-"),
    );
    const tempWorkspace = path.join(tempRoot, "workspace");
    const tempMemoryDir = path.join(tempRoot, ".memory");

    const mockServer = await startMockOpenAIServer((_req, index) => {
      if (index === 0) {
        return {
          content: "1. 关闭通知；2. 25 分钟番茄钟；3. 睡前写明日三件事。",
        };
      }
      if (index === 1) {
        return {
          content: "第 2 项“25 分钟番茄钟”是指专注工作 25 分钟后休息 5 分钟。",
        };
      }
      if (index === 2) {
        return {
          content: "我们刚才聊的第 1 条建议是：关闭通知。",
        };
      }
      if (index === 3) {
        return {
          toolCall: {
            id: "call_wm_1",
            name: "updateWorkingMemory",
            arguments: {
              memory: `# 用户长期偏好与个人资料
- **称呼与身份**: 小明
- **回复风格偏好**: 简洁中文
- **待办与资料整理习惯**: 整理待办时始终按负责人分组
- **常驻背景与长期事项**:
`,
            },
          },
        };
      }
      if (index === 4) {
        return {
          content: "好，记下了，以后整理待办都会按负责人分组。",
        };
      }
      return {
        content: "按负责人整理如下：\n- 张三：准备投影仪、联系场地\n- 李四：负责签到",
      };
    });

    try {
      const modelConfig = {
        baseUrl: mockServer.baseUrl,
        apiKey: "sk-synth-memory-key",
        modelName: "gpt-6.1-sol",
      };
      const resourceId = "wx-user-001@im.wechat";

      // Process 1: Initial conversation + follow-up
      const agent1 = createPersonalAssistantAgent(modelConfig, {
        workspaceDir: tempWorkspace,
        memoryDir: tempMemoryDir,
      });
      const threadA = getOrCreateActiveThreadId(resourceId, tempMemoryDir);

      const reply1 = await askPersonalAssistant(
        agent1,
        "给我列 3 条提升专注力的建议",
        [modelConfig.apiKey],
        { resource: resourceId, thread: threadA },
      );
      assert.match(reply1, /番茄钟/);

      const reply2 = await askPersonalAssistant(
        agent1,
        "把第二项展开说说",
        [modelConfig.apiKey],
        { resource: resourceId, thread: threadA },
      );
      assert.match(reply2, /25 分钟番茄钟/);

      // Verify request 2 carried turn 1's user question and assistant answer
      const req2Messages = JSON.stringify(mockServer.requests[1]!.body.messages);
      assert.ok(req2Messages.includes("给我列 3 条提升专注力的建议"));
      assert.ok(req2Messages.includes("25 分钟番茄钟"));
      assert.ok(req2Messages.includes("把第二项展开说说"));

      // Process 2 (simulated restart): Create a brand new Agent instance pointing to the same tempMemoryDir
      const agent2 = createPersonalAssistantAgent(modelConfig, {
        workspaceDir: tempWorkspace,
        memoryDir: tempMemoryDir,
      });
      const recoveredThread = getOrCreateActiveThreadId(
        resourceId,
        tempMemoryDir,
      );
      assert.equal(recoveredThread, threadA);

      const reply3 = await askPersonalAssistant(
        agent2,
        "我们刚才聊的第 1 条建议是什么？",
        [modelConfig.apiKey],
        { resource: resourceId, thread: recoveredThread },
      );
      assert.match(reply3, /关闭通知/);

      const req3Messages = JSON.stringify(mockServer.requests[2]!.body.messages);
      assert.ok(req3Messages.includes("给我列 3 条提升专注力的建议"));
      assert.ok(req3Messages.includes("把第二项展开说说"));

      // Save long-term preference into resource-scoped Working Memory
      const reply4 = await askPersonalAssistant(
        agent2,
        "记住，以后整理待办都按负责人分组",
        [modelConfig.apiKey],
        { resource: resourceId, thread: recoveredThread },
      );
      assert.match(reply4, /按负责人分组/);

      // Start a new conversation (Thread B)
      const threadB = rotateActiveThreadId(resourceId, tempMemoryDir);
      assert.notEqual(threadB, threadA);

      const reply5 = await askPersonalAssistant(
        agent2,
        "帮我整理这几项待办：张三准备投影仪，李四负责签到，张三还要联系场地",
        [modelConfig.apiKey],
        { resource: resourceId, thread: threadB },
      );
      assert.match(reply5, /张三/);

      // Verify the final request in Thread B does NOT contain Thread A's chat history,
      // but DOES contain the resource-scoped Working Memory ("整理待办时始终按负责人分组")!
      const lastReqMessages = JSON.stringify(
        mockServer.requests[mockServer.requests.length - 1]!.body.messages,
      );
      assert.ok(!lastReqMessages.includes("给我列 3 条提升专注力的建议"));
      assert.ok(!lastReqMessages.includes("把第二项展开说说"));
      assert.ok(lastReqMessages.includes("整理待办时始终按负责人分组"));
    } finally {
      await mockServer.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("handles WeChat '新对话' / '/new' commands without calling LLM and rotates threadId for subsequent messages (3.1)", async () => {
    const tempMemoryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "wechat-memory-cmd-"),
    );
    const askedContexts: Array<{ prompt: string; resource: string; thread: string }> =
      [];
    const sentReplies: Array<{ userId: string; text: string }> = [];
    let typingCount = 0;

    const makeTextMsg = (text: string): IncomingMessage =>
      ({
        id: `msg-${Date.now()}-${Math.random()}`,
        userId: "owner@im.wechat",
        type: "text",
        text,
        timestamp: Date.now(),
        isGroup: false,
        raw: {},
      }) as unknown as IncomingMessage;

    try {
      const deps = {
        memoryDir: tempMemoryDir,
        sendTyping: async () => {
          typingCount += 1;
        },
        askAgent: async (
          prompt: string,
          _secrets: readonly (string | undefined)[],
          memoryContext: { resource: string; thread: string },
        ) => {
          askedContexts.push({
            prompt,
            resource: memoryContext.resource,
            thread: memoryContext.thread,
          });
          return `收到：${prompt}`;
        },
        sendReply: async (userId: string, segment: string) => {
          sentReplies.push({ userId, text: segment });
        },
      };

      // 1. First message
      await handleIncomingWeChatMessage(makeTextMsg("第一个问题"), deps);
      // 2. Follow-up message in same thread
      await handleIncomingWeChatMessage(makeTextMsg("把第二项展开说说"), deps);
      assert.equal(askedContexts.length, 2);
      assert.equal(askedContexts[0]!.thread, askedContexts[1]!.thread);

      // 3. Send "新对话" -> must NOT call askAgent or sendTyping, must reply confirmation and rotate thread
      const typingBeforeNew = typingCount;
      await handleIncomingWeChatMessage(makeTextMsg("新对话"), deps);
      assert.equal(askedContexts.length, 2);
      assert.equal(typingCount, typingBeforeNew);
      assert.equal(sentReplies[2]!.text, NEW_CONVERSATION_REPLY);

      // 4. Next message uses the rotated threadId
      await handleIncomingWeChatMessage(makeTextMsg("新话题的第一个问题"), deps);
      assert.equal(askedContexts.length, 3);
      assert.equal(askedContexts[2]!.resource, "owner@im.wechat");
      assert.notEqual(askedContexts[2]!.thread, askedContexts[0]!.thread);
    } finally {
      fs.rmSync(tempMemoryDir, { recursive: true, force: true });
    }
  });

  it("supports CLI multi-turn history and '--new' / '新对话' session rotation without calling model (3.2)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-memory-test-"));
    const mockServer = await startMockOpenAIServer((_req, index) => ({
      content: `第 ${index + 1} 次 CLI 回复`,
    }));

    try {
      const env = {
        MODEL_BASE_URL: mockServer.baseUrl,
        MODEL_API_KEY: "sk-synth-cli-mem-key",
        MODEL_NAME: "gpt-6.1-sol",
      };

      // Turn 1
      let out1 = "";
      const code1 = await runCli({
        argv: ["第一句提问"],
        cwd: tempDir,
        env,
        stdout: (t) => {
          out1 += t;
        },
      });
      assert.equal(code1, 0);
      assert.equal(out1, "第 1 次 CLI 回复\n");

      // Turn 2 (same thread -> carries Turn 1 history)
      let out2 = "";
      const code2 = await runCli({
        argv: ["第二句追问"],
        cwd: tempDir,
        env,
        stdout: (t) => {
          out2 += t;
        },
      });
      assert.equal(code2, 0);
      assert.equal(out2, "第 2 次 CLI 回复\n");
      assert.equal(mockServer.requests.length, 2);
      const req2Messages = JSON.stringify(mockServer.requests[1]!.body.messages);
      assert.ok(req2Messages.includes("第一句提问"));
      assert.ok(req2Messages.includes("第 1 次 CLI 回复"));

      // Run `npm run ask -- --new` -> rotates thread without calling model
      let outNew = "";
      const codeNew = await runCli({
        argv: ["--new"],
        cwd: tempDir,
        env,
        stdout: (t) => {
          outNew += t;
        },
      });
      assert.equal(codeNew, 0);
      assert.equal(outNew, `${NEW_CONVERSATION_REPLY}\n`);
      assert.equal(mockServer.requests.length, 2);

      // Turn 3 after `--new` -> does NOT carry Turn 1/2 chat history
      let out3 = "";
      const code3 = await runCli({
        argv: ["全新话题提问"],
        cwd: tempDir,
        env,
        stdout: (t) => {
          out3 += t;
        },
      });
      assert.equal(code3, 0);
      assert.equal(out3, "第 3 次 CLI 回复\n");
      assert.equal(mockServer.requests.length, 3);
      const req3Messages = JSON.stringify(mockServer.requests[2]!.body.messages);
      assert.ok(req3Messages.includes("全新话题提问"));
      assert.ok(!req3Messages.includes("第一句提问"));
    } finally {
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sends WeChat images as multimodal image_url parts and retains image in history for follow-up text questions", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "wechat-img-memory-"),
    );
    const tempWorkspace = path.join(tempRoot, "workspace");
    const tempMemoryDir = path.join(tempRoot, ".memory");
    fs.mkdirSync(tempWorkspace, { recursive: true });

    const samplePngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const sampleImgPath = path.join(tempWorkspace, "sample.png");
    fs.writeFileSync(sampleImgPath, Buffer.from(samplePngBase64, "base64"));

    const mockServer = await startMockOpenAIServer((_req, index) => ({
      content:
        index === 0
          ? "这是一张套餐价格表图片。"
          : "图片里的内容是 Claude 套餐价格表：Pro 135 元。",
    }));

    try {
      const modelConfig = {
        baseUrl: mockServer.baseUrl,
        apiKey: "sk-synth-img-mem-key",
        modelName: "gpt-6.1-sol",
      };
      const agent = createPersonalAssistantAgent(modelConfig, {
        workspaceDir: tempWorkspace,
        memoryDir: tempMemoryDir,
      });

      const replies: string[] = [];
      const makeDeps = (mediaPaths: readonly string[] = []) => ({
        memoryDir: tempMemoryDir,
        resolveMediaPaths: async () => mediaPaths,
        sendTyping: async () => {},
        askAgent: async (
          prompt: string,
          secrets: readonly (string | undefined)[],
          memoryContext: { resource: string; thread: string },
          imageAttachments: readonly { dataUrl: string; mimeType: string }[],
        ) =>
          askPersonalAssistant(
            agent,
            prompt,
            secrets,
            memoryContext,
            imageAttachments,
          ),
        sendReply: async (_userId: string, segment: string) => {
          replies.push(segment);
        },
      });

      const imgMsg = {
        id: "msg-img-1",
        userId: "user-img@im.wechat",
        type: "image",
        text: "[image]",
        images: [{ width: 210, height: 140 }],
        timestamp: Date.now(),
        isGroup: false,
        raw: {},
      } as unknown as IncomingMessage;

      const followUpMsg = {
        id: "msg-txt-2",
        userId: "user-img@im.wechat",
        type: "text",
        text: "上面这张图片的内容是什么",
        timestamp: Date.now() + 1000,
        isGroup: false,
        raw: {},
      } as unknown as IncomingMessage;

      // Enqueue both back-to-back without awaiting the first one first, simulating rapid WeChat image + text
      const p1 = enqueueWeChatUserTask(imgMsg.userId, () =>
        handleIncomingWeChatMessage(imgMsg, makeDeps([sampleImgPath])),
      );
      const p2 = enqueueWeChatUserTask(followUpMsg.userId, () =>
        handleIncomingWeChatMessage(followUpMsg, makeDeps([])),
      );
      await Promise.all([p1, p2]);

      assert.equal(replies.length, 2);
      assert.equal(replies[0], "这是一张套餐价格表图片。");
      assert.equal(replies[1], "图片里的内容是 Claude 套餐价格表：Pro 135 元。");

      assert.equal(mockServer.requests.length, 2);
      const req1Str = JSON.stringify(mockServer.requests[0]!.body.messages);
      const req2Str = JSON.stringify(mockServer.requests[1]!.body.messages);

      // Both Turn 1 (image) and Turn 2 (follow-up text) must carry the image_url base64 data!
      assert.ok(req1Str.includes("image_url"));
      assert.ok(req1Str.includes(samplePngBase64));
      assert.ok(req2Str.includes("image_url"));
      assert.ok(req2Str.includes(samplePngBase64));
      assert.ok(req2Str.includes("上面这张图片的内容是什么"));
    } finally {
      await mockServer.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
