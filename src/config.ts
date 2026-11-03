import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const REQUIRED_MODEL_ENV_KEYS = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_NAME",
] as const;

export const USAGE_ERROR_MESSAGE = '用法：npm run ask -- "问题"（请提供一个非空问题）';
export const MODEL_CALL_ERROR_MESSAGE =
  "模型调用失败，请检查基础地址、密钥、模型名及网络后重试";
export const REDACTED_PLACEHOLDER = "[已遮蔽密钥]";

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface LoadModelConfigOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class UsageError extends Error {
  constructor(message: string = USAGE_ERROR_MESSAGE) {
    super(message);
    this.name = "UsageError";
  }
}

export class ModelCallError extends Error {
  constructor(message: string = MODEL_CALL_ERROR_MESSAGE) {
    super(message);
    this.name = "ModelCallError";
  }
}

export function readDotEnvFile(envFilePath: string): NodeJS.Dict<string> {
  try {
    const content = fs.readFileSync(envFilePath, "utf8");
    return parseEnv(content);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw new ConfigError("读取配置文件 .env 失败，请检查文件权限或格式后重试");
  }
}

export function loadModelConfig(options: LoadModelConfigOptions = {}): ModelConfig {
  const env = options.env ?? process.env;
  const envFilePath = options.envFilePath ?? path.resolve(process.cwd(), ".env");
  const fileEnv = readDotEnvFile(envFilePath);

  const resolved: Record<(typeof REQUIRED_MODEL_ENV_KEYS)[number], string> = {
    MODEL_BASE_URL: "",
    MODEL_API_KEY: "",
    MODEL_NAME: "",
  };
  const missing: string[] = [];

  for (const key of REQUIRED_MODEL_ENV_KEYS) {
    const hasProcessValue =
      Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined;
    const rawValue = hasProcessValue ? env[key] : fileEnv[key];
    const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";

    if (trimmed.length === 0) {
      missing.push(key);
    } else {
      resolved[key] = trimmed;
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `缺少必要的环境变量：${missing.join(", ")}，请配置后重试`,
    );
  }

  return {
    baseUrl: resolved.MODEL_BASE_URL,
    apiKey: resolved.MODEL_API_KEY,
    modelName: resolved.MODEL_NAME,
  };
}

export function validateQuestionArgs(args: readonly string[]): string {
  if (args.length !== 1) {
    throw new UsageError();
  }
  const question = args[0]?.trim() ?? "";
  if (question.length === 0) {
    throw new UsageError();
  }
  return question;
}

export function collectCandidateSecrets(
  options: LoadModelConfigOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const envFilePath = options.envFilePath ?? path.resolve(process.cwd(), ".env");
  const secrets: string[] = [];

  if (typeof env.MODEL_API_KEY === "string" && env.MODEL_API_KEY.trim().length > 0) {
    secrets.push(env.MODEL_API_KEY, env.MODEL_API_KEY.trim());
  }

  try {
    const fileEnv = readDotEnvFile(envFilePath);
    if (
      typeof fileEnv.MODEL_API_KEY === "string" &&
      fileEnv.MODEL_API_KEY.trim().length > 0
    ) {
      secrets.push(fileEnv.MODEL_API_KEY, fileEnv.MODEL_API_KEY.trim());
    }
  } catch {
    // Ignore file read errors when collecting candidate secrets for redaction
  }

  return secrets;
}

export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    const candidates = [secret, secret.trim()].filter((item) => item.length > 0);
    for (const candidate of candidates) {
      output = output.replaceAll(candidate, REDACTED_PLACEHOLDER);
    }
  }
  return output;
}

export function formatCliError(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  if (error instanceof ConfigError || error instanceof UsageError) {
    return redactSecrets(error.message, secrets);
  }
  return redactSecrets(MODEL_CALL_ERROR_MESSAGE, secrets);
}
