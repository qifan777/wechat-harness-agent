import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ConfigError,
  MODEL_CALL_ERROR_MESSAGE,
  USAGE_ERROR_MESSAGE,
  UsageError,
  formatCliError,
  loadModelConfig,
  redactSecrets,
} from "./config.js";

function withTempDir(fn: (dir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-agent-cfg-"));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("loadModelConfig (2.1)", () => {
  it("loads from process env when .env file does not exist", () => {
    withTempDir((dir) => {
      const config = loadModelConfig({
        envFilePath: path.join(dir, ".env"),
        env: {
          MODEL_BASE_URL: "https://example.test/v1",
          MODEL_API_KEY: "synth-key-12345",
          MODEL_NAME: "test-model",
        },
      });
      assert.deepEqual(config, {
        baseUrl: "https://example.test/v1",
        apiKey: "synth-key-12345",
        modelName: "test-model",
      });
    });
  });

  it("loads from .env file and gives process env precedence including empty values", () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, ".env");
      fs.writeFileSync(
        envFile,
        [
          "MODEL_BASE_URL=https://from-file.test/v1",
          "MODEL_API_KEY=synth-file-key-999",
          "MODEL_NAME=file-model",
        ].join("\n"),
        "utf8",
      );

      // Process env overrides file value
      const overridden = loadModelConfig({
        envFilePath: envFile,
        env: {
          MODEL_BASE_URL: "https://from-env.test/v1",
        },
      });
      assert.deepEqual(overridden, {
        baseUrl: "https://from-env.test/v1",
        apiKey: "synth-file-key-999",
        modelName: "file-model",
      });

      // Explicit empty string in process env must NOT fall back to file value
      assert.throws(
        () =>
          loadModelConfig({
            envFilePath: envFile,
            env: {
              MODEL_API_KEY: "",
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(
            err.message,
            "缺少必要的环境变量：MODEL_API_KEY，请配置后重试",
          );
          assert.ok(!err.message.includes("synth-file-key-999"));
          return true;
        },
      );

      // Explicit whitespace in process env must also be treated as missing
      assert.throws(
        () =>
          loadModelConfig({
            envFilePath: envFile,
            env: {
              MODEL_NAME: "   \t  ",
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(
            err.message,
            "缺少必要的环境变量：MODEL_NAME，请配置后重试",
          );
          return true;
        },
      );
    });
  });

  it("reports single and multiple missing, empty, or whitespace-only variables in fixed order without leaking values", () => {
    withTempDir((dir) => {
      const nonExistentEnv = path.join(dir, ".env");
      const syntheticSecret = "synth-secret-do-not-leak-001";

      // All three missing
      assert.throws(
        () =>
          loadModelConfig({
            envFilePath: nonExistentEnv,
            env: {},
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(
            err.message,
            "缺少必要的环境变量：MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME，请配置后重试",
          );
          return true;
        },
      );

      // Two missing (one empty, one whitespace), one present with secret
      assert.throws(
        () =>
          loadModelConfig({
            envFilePath: nonExistentEnv,
            env: {
              MODEL_BASE_URL: "",
              MODEL_API_KEY: syntheticSecret,
              MODEL_NAME: "   ",
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(
            err.message,
            "缺少必要的环境变量：MODEL_BASE_URL, MODEL_NAME，请配置后重试",
          );
          assert.ok(!err.message.includes(syntheticSecret));
          return true;
        },
      );
    });
  });

  it("throws a fixed Chinese ConfigError when .env is unreadable", () => {
    withTempDir((dir) => {
      const envDir = path.join(dir, ".env");
      fs.mkdirSync(envDir);

      assert.throws(
        () =>
          loadModelConfig({
            envFilePath: envDir,
            env: {
              MODEL_BASE_URL: "https://example.test",
              MODEL_API_KEY: "synth-key",
              MODEL_NAME: "gpt-test",
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /读取配置文件 \.env 失败/);
          assert.ok(!err.message.includes("EISDIR"));
          return true;
        },
      );
    });
  });
});

describe("redactSecrets & formatCliError (2.2)", () => {
  it("redacts single and repeated occurrences of the current synthetic key in text", () => {
    const secret = "sk-synth-secret-xyz-987654";
    const text = `回答内容包含密钥 ${secret}，再次出现 ${secret}！`;
    const redacted = redactSecrets(text, [secret]);

    assert.ok(!redacted.includes(secret));
    assert.match(redacted, /回答内容包含密钥 \[已遮蔽密钥\]，再次出现 \[已遮蔽密钥\]！/);
  });

  it("maps unknown errors and SDK errors with synthetic keys to a fixed Chinese message without stack or key", () => {
    const secret = "sk-synth-error-leak-112233";
    const rawError = new Error(
      `401 Unauthorized: Invalid API key ${secret} (${secret}) at https://example.test`,
      {
        cause: new Error(`Bearer ${secret}`),
      },
    );

    const output = formatCliError(rawError, [secret]);
    assert.equal(output, MODEL_CALL_ERROR_MESSAGE);
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("401"));
    assert.ok(!output.includes("Unauthorized"));
    assert.ok(!output.includes("at "));
  });

  it("preserves controlled ConfigError and UsageError messages while still redacting any secret", () => {
    const secret = "sk-synth-inline-secret";
    const usageOutput = formatCliError(new UsageError(), [secret]);
    assert.equal(usageOutput, USAGE_ERROR_MESSAGE);

    const configOutput = formatCliError(
      new ConfigError(`缺少必要的环境变量：MODEL_NAME，请配置后重试（${secret}）`),
      [secret],
    );
    assert.ok(!configOutput.includes(secret));
    assert.match(configOutput, /缺少必要的环境变量：MODEL_NAME/);
  });

  it("provides .env.example with prefilled base url and model name and empty api key (2.3)", () => {
    const examplePath = path.resolve(process.cwd(), ".env.example");
    const parsed = loadModelConfig;
    assert.ok(typeof parsed === "function");
    const raw = fs.readFileSync(examplePath, "utf8");
    assert.match(raw, /^MODEL_BASE_URL=https:\/\/ai\.jarcheng\.top\/$/m);
    assert.match(raw, /^MODEL_API_KEY=$/m);
    assert.match(raw, /^MODEL_NAME=gpt-6\.1-sol$/m);
  });
});
