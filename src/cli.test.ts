import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { startMockOpenAIServer } from "./test-helpers.js";
import { runCli } from "./cli.js";
import {
  MODEL_CALL_ERROR_MESSAGE,
  USAGE_ERROR_MESSAGE,
} from "./config.js";

const execFileAsync = promisify(execFile);

interface CliSubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCliSubprocess(
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<CliSubprocessResult> {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    ...options.env,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: options.cwd,
        env: childEnv,
      },
    );
    return {
      code: 0,
      stdout,
      stderr,
    };
  } catch (error: unknown) {
    const execErr = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof execErr.code === "number" ? execErr.code : 1,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
    };
  }
}

describe("CLI ask entrypoint (4.1 & 4.2)", () => {
  it("validates arguments in subprocess and does not request model on missing, whitespace, or multiple arguments (4.1)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-agent-cli-"));
    const mockServer = await startMockOpenAIServer(() => ({
      content: "不应被调用",
    }));

    try {
      const validEnv = {
        MODEL_BASE_URL: mockServer.baseUrl,
        MODEL_API_KEY: "sk-synth-cli-arg-test",
        MODEL_NAME: "gpt-6.1-sol",
      };

      for (const invalidArgs of [[], ["   "], ["问题一", "问题二"]]) {
        const res = await runCliSubprocess(invalidArgs, {
          cwd: tempDir,
          env: validEnv,
        });
        assert.equal(res.code, 1);
        assert.equal(res.stdout, "");
        assert.equal(res.stderr.trim(), USAGE_ERROR_MESSAGE);
      }

      assert.equal(mockServer.requests.length, 0);
    } finally {
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes single Q&A in subprocess, prints only answer to stdout, and exits with 0 (4.1)", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-cli-ok-"),
    );
    const mockServer = await startMockOpenAIServer(() => ({
      content: "我是你的个人资料助理，可以帮你回答问题与整理工作目录资料。",
    }));

    try {
      const res = await runCliSubprocess(["用一句话介绍你自己"], {
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: "sk-synth-cli-ok-001",
          MODEL_NAME: "gpt-6.1-sol",
        },
      });

      assert.equal(res.code, 0);
      assert.equal(
        res.stdout,
        "我是你的个人资料助理，可以帮你回答问题与整理工作目录资料。\n",
      );
      assert.equal(res.stderr, "");
      assert.equal(mockServer.requests.length, 1);
    } finally {
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles missing config, initialization exceptions, server errors echoing key, and answer echoing key without leaking secrets or stack traces (4.2)", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-cli-sec-"),
    );
    const secret = "sk-synth-top-secret-778899";

    let serverMode: "error-echo" | "answer-echo" = "error-echo";
    const mockServer = await startMockOpenAIServer(() => {
      if (serverMode === "error-echo") {
        return {
          status: 500,
          rawBody: JSON.stringify({
            error: {
              message: `Fatal upstream failure with key ${secret}`,
            },
          }),
        };
      }
      return {
        status: 200,
        content: `这是回答，意外夹带了密钥 ${secret}，以及重复 ${secret}。`,
      };
    });

    try {
      // 1. Missing config in subprocess: must not request model, no stack, no secret
      const missingRes = await runCliSubprocess(["你好"], {
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: secret,
          MODEL_NAME: "",
        },
      });
      assert.equal(missingRes.code, 1);
      assert.equal(missingRes.stdout, "");
      assert.equal(
        missingRes.stderr.trim(),
        "缺少必要的环境变量：MODEL_NAME，请配置后重试",
      );
      assert.ok(!missingRes.stderr.includes(secret));
      assert.ok(!missingRes.stderr.includes("at "));
      assert.equal(mockServer.requests.length, 0);

      // 2. Agent initialization exception + third-party console logging
      let capturedOut = "";
      let capturedErr = "";
      const initExitCode = await runCli({
        argv: ["你好"],
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: secret,
          MODEL_NAME: "gpt-6.1-sol",
        },
        stdout: (t) => {
          capturedOut += t;
        },
        stderr: (t) => {
          capturedErr += t;
        },
        createAgent: () => {
          console.error(`leaky third party log ${secret}`);
          throw new Error(`Init failed with ${secret}`);
        },
      });
      assert.equal(initExitCode, 1);
      assert.equal(capturedOut, "");
      assert.equal(capturedErr.trim(), MODEL_CALL_ERROR_MESSAGE);
      assert.ok(!capturedErr.includes(secret));
      assert.ok(!capturedErr.includes("at "));
      assert.equal(mockServer.requests.length, 0);

      // 3. Server error echoing synthetic key in subprocess
      serverMode = "error-echo";
      const errRes = await runCliSubprocess(["触发错误回显"], {
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: secret,
          MODEL_NAME: "gpt-6.1-sol",
        },
      });
      assert.equal(errRes.code, 1);
      assert.equal(errRes.stdout, "");
      assert.equal(errRes.stderr.trim(), MODEL_CALL_ERROR_MESSAGE);
      assert.ok(!errRes.stderr.includes(secret));
      assert.ok(!errRes.stderr.includes("at "));

      // 4. Successful answer echoing synthetic key in subprocess
      serverMode = "answer-echo";
      const echoRes = await runCliSubprocess(["触发回答回显"], {
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: secret,
          MODEL_NAME: "gpt-6.1-sol",
        },
      });
      assert.equal(echoRes.code, 0);
      assert.equal(echoRes.stderr, "");
      assert.ok(!echoRes.stdout.includes(secret));
      assert.match(echoRes.stdout, /\[已遮蔽密钥\]/);
    } finally {
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("aligns README commands and Chinese error examples with actual CLI behavior (4.3)", () => {
    const readmePath = path.resolve(process.cwd(), "README.md");
    const readme = fs.readFileSync(readmePath, "utf8");

    assert.ok(readme.includes("npm ci"));
    assert.ok(readme.includes("cp .env.example .env"));
    assert.ok(readme.includes('npm run ask -- "用一句话介绍你自己"'));
    assert.ok(readme.includes("npm run typecheck"));
    assert.ok(readme.includes("npm run build"));
    assert.ok(readme.includes("npm test"));
    assert.ok(readme.includes(USAGE_ERROR_MESSAGE));
    assert.ok(readme.includes("缺少必要的环境变量："));
    assert.ok(readme.includes(MODEL_CALL_ERROR_MESSAGE));
  });

  it("disconnects MCP client in finally block after single Q&A or error (Chapter 04)", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "minimal-agent-cli-mcp-"),
    );
    const mockServer = await startMockOpenAIServer(() => ({
      content: "MCP 问答已完成。",
    }));

    try {
      let disconnectCalls = 0;
      let out = "";
      const code = await runCli({
        argv: ["查询微信归档状态"],
        cwd: tempDir,
        env: {
          MODEL_BASE_URL: mockServer.baseUrl,
          MODEL_API_KEY: "sk-synth-cli-mcp",
          MODEL_NAME: "gpt-6.1-sol",
        },
        stdout: (t) => {
          out += t;
        },
        connectMcpTools: async () => ({
          client: null,
          tools: {},
          disconnect: async () => {
            disconnectCalls += 1;
          },
        }),
      });

      assert.equal(code, 0);
      assert.equal(out, "MCP 问答已完成。\n");
      assert.equal(disconnectCalls, 1);
    } finally {
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
