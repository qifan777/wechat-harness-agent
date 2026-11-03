import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ASSISTANT_INSTRUCTIONS,
  ASSISTANT_NAME,
  askPersonalAssistant,
  createPersonalAssistantAgent,
} from "./agent.js";
import {
  MODEL_CALL_ERROR_MESSAGE,
  ModelCallError,
  formatCliError,
} from "./config.js";
import { startMockOpenAIServer } from "./test-helpers.js";

describe("PersonalAssistant Agent & Workspace (3.2 & 3.3)", () => {
  it("sends requests to configured baseUrl with model, auth header, system instructions, Workspace tools, and no history across calls (3.2)", async () => {
    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-ws-"),
    );
    const mockServer = await startMockOpenAIServer((_req, index) => ({
      content: index === 0 ? "我是你的个人资料助理。" : "这是第二次独立回答。",
    }));

    try {
      const syntheticKey = "sk-synth-agent-test-001";
      const agent = createPersonalAssistantAgent(
        {
          baseUrl: mockServer.baseUrl,
          apiKey: syntheticKey,
          modelName: "gpt-6.1-sol",
        },
        { workspaceDir: tempWorkspace },
      );

      assert.equal(agent.name, ASSISTANT_NAME);
      assert.equal(agent.hasOwnWorkspace(), true);

      const firstReply = await askPersonalAssistant(
        agent,
        "用一句话介绍你自己",
        [syntheticKey],
      );
      assert.equal(firstReply, "我是你的个人资料助理。");

      const secondReply = await askPersonalAssistant(
        agent,
        "第二个独立问题",
        [syntheticKey],
      );
      assert.equal(secondReply, "这是第二次独立回答。");

      assert.equal(mockServer.requests.length, 2);

      const req1 = mockServer.requests[0]!;
      assert.equal(req1.method, "POST");
      assert.equal(req1.url, "/v1/chat/completions");
      assert.equal(req1.headers.authorization, `Bearer ${syntheticKey}`);
      assert.equal(req1.body.model, "gpt-6.1-sol");

      const messages1 = req1.body.messages as Array<{
        role: string;
        content: unknown;
      }>;
      assert.ok(Array.isArray(messages1));
      const serializedMessages1 = JSON.stringify(messages1);
      assert.ok(serializedMessages1.includes(ASSISTANT_NAME));
      assert.ok(serializedMessages1.includes(ASSISTANT_INSTRUCTIONS));
      assert.ok(serializedMessages1.includes("用一句话介绍你自己"));

      // Verify Workspace filesystem and sandbox tools are mounted and sent in tool definitions
      const tools1 = JSON.stringify(req1.body.tools ?? []);
      assert.match(tools1, /write_file|read_file|edit_file|list_files/);
      assert.match(tools1, /execute_command/);

      // Second request must NOT carry first conversation history
      const req2 = mockServer.requests[1]!;
      const serializedMessages2 = JSON.stringify(req2.body.messages);
      assert.ok(serializedMessages2.includes("第二个独立问题"));
      assert.ok(!serializedMessages2.includes("用一句话介绍你自己"));
      assert.ok(!serializedMessages2.includes("我是你的个人资料助理。"));
    } finally {
      await mockServer.close();
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it("can write and read files inside and outside ./workspace and execute commands via built-in Workspace tools (3.2)", async () => {
    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-ws-rw-"),
    );
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-ext-"),
    );
    const externalFile = path.join(externalDir, "outside.txt");
    fs.writeFileSync(externalFile, "外部文件内容", "utf8");

    const mockServer = await startMockOpenAIServer((_req, index) => {
      if (index === 0) {
        return {
          toolCall: {
            id: "call_write_1",
            name: "mastra_workspace_write_file",
            arguments: {
              path: "hello.md",
              content: "你好，世界！",
            },
          },
        };
      }
      if (index === 1) {
        return {
          toolCall: {
            id: "call_read_ext_1",
            name: "mastra_workspace_read_file",
            arguments: {
              path: externalFile,
            },
          },
        };
      }
      return {
        content: "已在工作目录创建 hello.md，并读取了外部文件。",
      };
    });

    try {
      const agent = createPersonalAssistantAgent(
        {
          baseUrl: mockServer.baseUrl,
          apiKey: "sk-synth-ws-key",
          modelName: "gpt-6.1-sol",
        },
        { workspaceDir: tempWorkspace },
      );

      const reply = await askPersonalAssistant(
        agent,
        "在工作目录创建 hello.md，并读取外部文件",
        ["sk-synth-ws-key"],
      );
      assert.equal(reply, "已在工作目录创建 hello.md，并读取了外部文件。");

      const writtenPath = path.join(tempWorkspace, "hello.md");
      assert.equal(fs.existsSync(writtenPath), true);
      assert.equal(fs.readFileSync(writtenPath, "utf8"), "你好，世界！");
    } finally {
      await mockServer.close();
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("handles auth failure, error echoing secret, network failure, and empty reply via controlled failure without leaking key (3.3)", async () => {
    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-err-"),
    );
    const secret = "sk-synth-do-not-leak-998877";

    let mode: "auth" | "echo-error" | "empty" = "auth";
    const mockServer = await startMockOpenAIServer(() => {
      if (mode === "auth") {
        return {
          status: 401,
          content: "Unauthorized key",
        };
      }
      if (mode === "echo-error") {
        return {
          status: 500,
          rawBody: JSON.stringify({
            error: {
              message: `Upstream rejected secret ${secret} twice: ${secret}`,
            },
          }),
        };
      }
      return {
        status: 200,
        content: "   ",
      };
    });

    try {
      const agent = createPersonalAssistantAgent(
        {
          baseUrl: mockServer.baseUrl,
          apiKey: secret,
          modelName: "gpt-6.1-sol",
        },
        { workspaceDir: tempWorkspace },
      );

      for (const currentMode of ["auth", "echo-error", "empty"] as const) {
        mode = currentMode;
        await assert.rejects(
          () => askPersonalAssistant(agent, "测试失败场景", [secret]),
          (err: unknown) => {
            assert.ok(err instanceof ModelCallError);
            const formatted = formatCliError(err, [secret]);
            assert.equal(formatted, MODEL_CALL_ERROR_MESSAGE);
            assert.ok(!formatted.includes(secret));
            return true;
          },
        );
      }

      const closedUrl = mockServer.baseUrl;
      await mockServer.close();

      const unreachableAgent = createPersonalAssistantAgent(
        {
          baseUrl: closedUrl,
          apiKey: secret,
          modelName: "gpt-6.1-sol",
        },
        { workspaceDir: tempWorkspace },
      );

      await assert.rejects(
        () => askPersonalAssistant(unreachableAgent, "测试网络断开", [secret]),
        (err: unknown) => {
          assert.ok(err instanceof ModelCallError);
          const formatted = formatCliError(err, [secret]);
          assert.equal(formatted, MODEL_CALL_ERROR_MESSAGE);
          assert.ok(!formatted.includes(secret));
          return true;
        },
      );
    } finally {
      await mockServer.close().catch(() => {});
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});
