import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { IncomingMessage } from "@wechatbot/wechatbot";
import {
  askPersonalAssistant,
  createPersonalAssistantAgent,
} from "./agent.js";
import {
  REDACTED_PLACEHOLDER,
  collectCandidateSecrets,
  collectWeChatSecrets,
  redactSecrets,
} from "./config.js";
import { startMockOpenAIServer } from "./test-helpers.js";
import {
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_PREPARE_FAILED_RETRY_MS,
  DEFAULT_SEND_INTERVAL_MS,
  WECHAT_FALLBACK_REPLY,
  createRedactedWeChatLogger,
  formatInboundMessage,
  handleIncomingWeChatMessage,
  isIgnoredWeChatMessage,
  runWeChatDaemon,
  sendSegmentedReply,
  splitReplyText,
} from "./wechat.js";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-agent-test-"));
  const cleanup = () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    const result = fn(tempDir);
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function createMockIncomingMessage(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  const baseWire = {
    from_user_id: overrides.userId ?? "wxid_private_user",
    to_user_id: "wxid_bot",
    client_id: "client-1",
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    context_token: overrides._contextToken ?? "ctx-token-default",
    item_list: [],
  };

  return {
    userId: "wxid_private_user",
    text: "你好",
    type: "text",
    timestamp: new Date(),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: baseWire,
    _contextToken: "ctx-token-default",
    ...overrides,
  };
}

describe("splitReplyText & sendSegmentedReply (2.1)", () => {
  it("sends short messages (<= 1500 chars) as a single segment without delay", async () => {
    const shortText = "这是一条简短的中文回复，不需要切分。";
    const segments = splitReplyText(shortText);
    assert.deepEqual(segments, [shortText]);

    const sent: string[] = [];
    const sleeps: number[] = [];
    await sendSegmentedReply(
      async (seg) => {
        sent.push(seg);
      },
      shortText,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.deepEqual(sent, [shortText]);
    assert.deepEqual(sleeps, []);
  });

  it("splits 3200+ char multi-paragraph and long-sentence replies on natural boundaries and spaces sends by 1500ms", async () => {
    const paragraph1 = `${"第一段内容包含完整的句子。".repeat(90)}第一段结尾。`; // ~1085 chars
    const paragraph2 = `${"第二段内容也是完整的句子！".repeat(95)}第二段结尾！`; // ~1145 chars
    const paragraph3 = `${"第三段内容继续补充细节？".repeat(90)}第三段结尾？`; // ~1085 chars
    const longReply = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;
    assert.ok(longReply.length >= 3200);

    const segments = splitReplyText(longReply, DEFAULT_MAX_REPLY_CHARS);
    assert.equal(segments.length, 3);
    for (const seg of segments) {
      assert.ok(seg.length <= DEFAULT_MAX_REPLY_CHARS);
    }
    assert.equal(segments[0], paragraph1);
    assert.equal(segments[1], paragraph2);
    assert.equal(segments[2], paragraph3);

    const sent: string[] = [];
    const sleeps: number[] = [];
    await sendSegmentedReply(
      async (seg) => {
        sent.push(seg);
      },
      longReply,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.deepEqual(sent, [paragraph1, paragraph2, paragraph3]);
    assert.deepEqual(sleeps, [
      DEFAULT_SEND_INTERVAL_MS,
      DEFAULT_SEND_INTERVAL_MS,
    ]);
  });

  it("falls back to hard split at threshold when a segment has no punctuation or line breaks", () => {
    const noPunct = "甲".repeat(3250);
    const segments = splitReplyText(noPunct, 1500);
    assert.equal(segments.length, 3);
    assert.equal(segments[0]?.length, 1500);
    assert.equal(segments[1]?.length, 1500);
    assert.equal(segments[2]?.length, 250);
    assert.equal(segments.join(""), noPunct);
  });

  it("waits 5000ms and retries when sending throws prepare failed", async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    let attemptsOnSecond = 0;

    const text = `${"第1段。".repeat(300)}\n\n${"第2段。".repeat(300)}`;
    await sendSegmentedReply(
      async (seg) => {
        if (seg.startsWith("第2段") && attemptsOnSecond === 0) {
          attemptsOnSecond += 1;
          throw new Error("SendMessage error: prepare failed (-1)");
        }
        sent.push(seg);
      },
      text,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.equal(sent.length, 2);
    assert.equal(attemptsOnSecond, 1);
    assert.deepEqual(sleeps, [
      DEFAULT_SEND_INTERVAL_MS,
      DEFAULT_PREPARE_FAILED_RETRY_MS,
    ]);
  });
});

describe("WeChat & API key secret redaction (2.2)", () => {
  it("collects and redacts both MODEL_API_KEY and local WeChat credential tokens in replies and logs", async () => {
    await withTempDir(async (dir) => {
      const storageDir = path.join(dir, ".wechat");
      fs.mkdirSync(storageDir, { recursive: true });

      const apiKey = "sk-synth-wechat-api-key-998877";
      const wechatToken = "wc-bot-token-secret-112233";
      const ctxToken = "wc-ctx-token-secret-445566";

      fs.writeFileSync(
        path.join(storageDir, "credentials.json"),
        JSON.stringify({
          token: wechatToken,
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-acc",
          userId: "wxid_bot",
          savedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(storageDir, "context_tokens.json"),
        JSON.stringify({
          wxid_user_1: ctxToken,
        }),
        "utf8",
      );

      const wechatSecrets = collectWeChatSecrets(storageDir);
      assert.ok(wechatSecrets.includes(wechatToken));
      assert.ok(wechatSecrets.includes(ctxToken));

      const allSecrets = collectCandidateSecrets({
        env: { MODEL_API_KEY: apiKey },
        envFilePath: path.join(dir, ".env"),
        wechatStorageDir: storageDir,
      });

      const rawText = `密钥=${apiKey}，凭证=${wechatToken}，上下文=${ctxToken}`;
      const redacted = redactSecrets(rawText, allSecrets);
      assert.ok(!redacted.includes(apiKey));
      assert.ok(!redacted.includes(wechatToken));
      assert.ok(!redacted.includes(ctxToken));
      assert.ok(redacted.includes(REDACTED_PLACEHOLDER));

      const outLogs: string[] = [];
      const errLogs: string[] = [];
      const logger = createRedactedWeChatLogger(
        () => allSecrets,
        (t) => outLogs.push(t),
        (t) => errLogs.push(t),
      );

      logger.info(`连接成功 token=${wechatToken}`);
      logger.error(`请求异常 key=${apiKey} ctx=${ctxToken}`);

      assert.ok(!outLogs.join("").includes(wechatToken));
      assert.ok(!errLogs.join("").includes(apiKey));
      assert.ok(!errLogs.join("").includes(ctxToken));
    });
  });
});

describe("WeChat message normalization & filtering (3.1)", () => {
  it("ignores group messages and bot self messages", () => {
    const groupByUserId = createMockIncomingMessage({
      userId: "123456@chatroom",
      text: "群聊消息",
    });
    assert.equal(isIgnoredWeChatMessage(groupByUserId), true);

    const groupByField = createMockIncomingMessage({
      userId: "wxid_member",
      raw: {
        from_user_id: "wxid_member",
        to_user_id: "wxid_bot",
        client_id: "c-1",
        create_time_ms: Date.now(),
        group_id: "998877@chatroom",
        message_type: 1,
        message_state: 2,
        context_token: "ctx",
        item_list: [],
      },
    });
    assert.equal(isIgnoredWeChatMessage(groupByField), true);

    const selfMsg = createMockIncomingMessage({
      userId: "wxid_bot_self",
    });
    assert.equal(isIgnoredWeChatMessage(selfMsg, "wxid_bot_self"), true);

    const privateMsg = createMockIncomingMessage({
      userId: "wxid_friend",
      text: "私聊消息",
    });
    assert.equal(isIgnoredWeChatMessage(privateMsg, "wxid_bot_self"), false);
  });

  it("normalizes text, emoji, voice ASR, image, file, video, and quotedMessage into Agent input", () => {
    // 1. Text + emoji
    const textMsg = createMockIncomingMessage({
      text: "你好 [微笑] 🌟",
      type: "text",
    });
    assert.equal(formatInboundMessage(textMsg), "你好 [微笑] 🌟");

    // 2. Voice message with WeChat ASR text
    const voiceMsg = createMockIncomingMessage({
      text: "帮我总结今天的会议纪要",
      type: "voice",
      voices: [
        {
          text: "帮我总结今天的会议纪要",
          durationMs: 3200,
        },
      ],
    });
    assert.equal(formatInboundMessage(voiceMsg), "帮我总结今天的会议纪要");

    // 3. Image message with URL and dimensions
    const imageMsg = createMockIncomingMessage({
      text: "https://cdn.weixin.qq.com/img123.jpg",
      type: "image",
      images: [
        {
          url: "https://cdn.weixin.qq.com/img123.jpg",
          width: 800,
          height: 600,
        },
      ],
    });
    const formattedImage = formatInboundMessage(imageMsg);
    assert.ok(formattedImage);
    assert.match(
      formattedImage,
      /\[收到图片: https:\/\/cdn\.weixin\.qq\.com\/img123\.jpg \(800x600\)\]/,
    );

    // 4. File + Quoted message
    const fileWithQuoteMsg = createMockIncomingMessage({
      text: "季度报告.pdf",
      type: "file",
      files: [
        {
          fileName: "季度报告.pdf",
          size: 4096,
          media: {
            encrypt_query_param: "enc",
            aes_key: "aes",
            full_url: "https://cdn.weixin.qq.com/file456.pdf",
          },
        },
      ],
      quotedMessage: {
        title: "请发一下最新报告",
        text: "发PDF版本即可",
        type: "text",
      },
    });
    const formattedFile = formatInboundMessage(fileWithQuoteMsg);
    assert.ok(formattedFile);
    assert.match(formattedFile, /\[引用消息: 请发一下最新报告 \| 发PDF版本即可\]/);
    assert.match(
      formattedFile,
      /\[收到文件: 季度报告\.pdf, 大小: 4096 字节, 路径: https:\/\/cdn\.weixin\.qq\.com\/file456\.pdf\]/,
    );

    // 5. Video message
    const videoMsg = createMockIncomingMessage({
      text: "[video]",
      type: "video",
      videos: [
        {
          durationMs: 12000,
          media: {
            encrypt_query_param: "enc",
            aes_key: "aes",
            full_url: "https://cdn.weixin.qq.com/video789.mp4",
          },
        },
      ],
    });
    const formattedVideo = formatInboundMessage(videoMsg);
    assert.ok(formattedVideo);
    assert.match(
      formattedVideo,
      /\[收到视频, 时长: 12000ms, 路径: https:\/\/cdn\.weixin\.qq\.com\/video789\.mp4\]/,
    );
  });
});

describe("End-to-end WeChat message orchestration & fault tolerance (3.2)", () => {
  it("triggers sendTyping before calling Agent, sends reply, and ignores group chat messages", async () => {
    const callOrder: string[] = [];
    const sentReplies: Array<{ userId: string; segment: string }> = [];

    // Group message should be ignored completely
    await handleIncomingWeChatMessage(
      createMockIncomingMessage({
        userId: "group_123@chatroom",
        text: "大家好",
      }),
      {
        sendTyping: async () => {
          callOrder.push("sendTyping");
        },
        askAgent: async () => {
          callOrder.push("askAgent");
          return "不应触发";
        },
        sendReply: async (userId, segment) => {
          callOrder.push("sendReply");
          sentReplies.push({ userId, segment });
        },
      },
    );
    assert.deepEqual(callOrder, [] as string[]);

    // Private voice + quote message should trigger sendTyping -> askAgent -> sendReply
    await handleIncomingWeChatMessage(
      createMockIncomingMessage({
        userId: "wxid_alice",
        type: "voice",
        text: "用一句话介绍你自己",
        voices: [{ text: "用一句话介绍你自己" }],
      }),
      {
        sendTyping: async (userId: string) => {
          callOrder.push(`sendTyping:${userId}`);
        },
        askAgent: async (prompt: string) => {
          callOrder.push(`askAgent:${prompt}`);
          return "我是你的个人资料助理。";
        },
        sendReply: async (userId: string, segment: string) => {
          callOrder.push(`sendReply:${userId}`);
          sentReplies.push({ userId, segment });
        },
      },
    );

    assert.deepEqual(callOrder, [
      "sendTyping:wxid_alice",
      "askAgent:用一句话介绍你自己",
      "sendReply:wxid_alice",
    ]);
    assert.deepEqual(sentReplies, [
      { userId: "wxid_alice", segment: "我是你的个人资料助理。" },
    ]);
  });

  it("calls Personal Assistant Agent independently without multi-turn history across consecutive messages", async () => {
    await withTempDir(async (dir) => {
      const server = await startMockOpenAIServer((_req, index) => ({
        content: `收到第 ${index + 1} 条消息`,
      }));

      try {
        const agent = createPersonalAssistantAgent(
          {
            baseUrl: server.baseUrl,
            apiKey: "sk-synth-wechat-stateless",
            modelName: "mock-model",
          },
          { workspaceDir: path.join(dir, "workspace") },
        );

        const replies: string[] = [];
        for (const text of ["我的名字叫小明", "我刚才说我叫什么名字？"]) {
          await handleIncomingWeChatMessage(
            createMockIncomingMessage({
              userId: "wxid_bob",
              text,
            }),
            {
              sendTyping: async () => {},
              askAgent: (prompt, secrets) =>
                askPersonalAssistant(agent, prompt, secrets),
              sendReply: async (_userId, segment) => {
                replies.push(segment);
              },
            },
          );
        }

        assert.deepEqual(replies, ["收到第 1 条消息", "收到第 2 条消息"]);
        assert.equal(server.requests.length, 2);

        const secondBody = server.requests[1]?.body as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        assert.ok(Array.isArray(secondBody.messages));
        const serializedSecond = JSON.stringify(secondBody.messages);
        assert.ok(!serializedSecond.includes("我的名字叫小明"));
        assert.ok(serializedSecond.includes("我刚才说我叫什么名字？"));
      } finally {
        await server.close();
      }
    });
  });

  it("catches model errors, typing errors, and send errors without crashing and redacts secrets", async () => {
    const apiKey = "sk-synth-err-secret-777";
    const ctxToken = "ctx-token-secret-888";
    const sentReplies: string[] = [];
    const errorLogs: string[] = [];

    // 1. Model error + sendTyping failure -> still sends fallback Chinese message to user
    await handleIncomingWeChatMessage(
      createMockIncomingMessage({
        userId: "wxid_user",
        text: "触发模型报错",
        _contextToken: ctxToken,
      }),
      {
        getSecrets: () => [apiKey],
        sendTyping: async () => {
          throw new Error(`typing error with ${ctxToken}`);
        },
        askAgent: async () => {
          throw new Error(`401 invalid key ${apiKey}`);
        },
        sendReply: async (_userId, segment) => {
          sentReplies.push(segment);
        },
        logError: (msg) => {
          errorLogs.push(msg);
        },
      },
    );

    assert.deepEqual(sentReplies, [WECHAT_FALLBACK_REPLY]);
    assert.ok(errorLogs.length >= 2);
    assert.ok(!errorLogs.join("\n").includes(apiKey));
    assert.ok(!errorLogs.join("\n").includes(ctxToken));

    // 2. Send error -> caught and logged without throwing, next message still works
    await handleIncomingWeChatMessage(
      createMockIncomingMessage({
        userId: "wxid_user",
        text: "触发发送报错",
        _contextToken: ctxToken,
      }),
      {
        getSecrets: () => [apiKey],
        sendTyping: async () => {},
        askAgent: async () => `正常生成但包含密钥 ${apiKey}`,
        sendReply: async () => {
          throw new Error(`network disconnect token=${ctxToken}`);
        },
        logError: (msg) => {
          errorLogs.push(msg);
        },
      },
    );

    assert.ok(!errorLogs.join("\n").includes(apiKey));
    assert.ok(!errorLogs.join("\n").includes(ctxToken));
  });
});

describe("runWeChatDaemon & CLI entry point (4.1)", () => {
  it("prints QR login guide via bot.login({ callbacks }) and starts listening when config is valid", async () => {
    await withTempDir(async (dir) => {
      const outChunks: string[] = [];
      const errChunks: string[] = [];
      let started = false;
      let registeredHandler: ((msg: IncomingMessage) => Promise<void>) | undefined;
      const sentReplies: string[] = [];
      const savedCreds = {
        token: "bot-token-xyz",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "1c4b659470aa@im.bot",
        userId: "owner_user@im.wechat",
        savedAt: new Date().toISOString(),
      };

      const exitCode = await runWeChatDaemon({
        env: {
          MODEL_BASE_URL: "https://example.test/v1",
          MODEL_API_KEY: "sk-synth-daemon-key",
          MODEL_NAME: "mock-model",
        },
        envFilePath: path.join(dir, ".env"),
        storageDir: path.join(dir, ".wechat"),
        workspaceDir: path.join(dir, "workspace"),
        stdout: {
          write(chunk: string) {
            outChunks.push(chunk);
            return true;
          },
        },
        stderr: {
          write(chunk: string) {
            errChunks.push(chunk);
            return true;
          },
        },
        createBot: () => ({
          async login(opts) {
            opts?.callbacks?.onQrUrl?.("https://weixin.qq.com/x/qr-test-123");
            opts?.callbacks?.onScanned?.();
            return savedCreds;
          },
          async start() {
            started = true;
          },
          stop() {},
          onMessage(handler) {
            registeredHandler = async (m) => {
              await handler(m);
            };
          },
          on() {},
          async sendTyping() {},
          async send(_u, content) {
            if (typeof content === "string") {
              sentReplies.push(content);
            }
          },
          async reply(_m, content) {
            if (typeof content === "string") {
              sentReplies.push(content);
            }
          },
          getCredentials() {
            return savedCreds;
          },
        }),
      });

      assert.equal(exitCode, 0);
      assert.equal(started, true);
      assert.ok(registeredHandler);
      assert.equal(errChunks.join(""), "");
      assert.match(
        outChunks.join(""),
        /请使用手机微信扫描以下二维码链接完成登录：\nhttps:\/\/weixin\.qq\.com\/x\/qr-test-123/,
      );
      assert.match(outChunks.join(""), /微信个人资料助理已启动/);

      // Message from creds.userId (the human owner who scanned the QR code) must NOT be ignored
      await registeredHandler(
        createMockIncomingMessage({
          userId: "owner_user@im.wechat",
          text: "hi",
        }),
      );
      assert.equal(sentReplies.length, 1);
    });
  });

  it("exits with code 1 and prints Chinese missing-env error when MODEL_* is missing in subprocess", async () => {
    await withTempDir(async (dir) => {
      const wechatEntry = path.resolve(process.cwd(), "dist/wechat.js");
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [wechatEntry], {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            MODEL_BASE_URL: "https://example.test/v1",
            MODEL_API_KEY: "",
            MODEL_NAME: "mock-model",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += String(d);
        });
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stdout, stderr });
        });
      });

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr.trim(),
        /^缺少必要的环境变量：MODEL_API_KEY，请配置后重试$/,
      );
    });
  });
});
