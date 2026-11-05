import fs from "node:fs";
import path from "node:path";
import type { ToolsInput } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { MCPClient } from "@mastra/mcp";
import { readDotEnvFile } from "./config.js";

export const CHATLOG_MCP_SCRIPT_ENV = "CHATLOG_MCP_SCRIPT";
export const CHATLOG_PYTHON_BIN_ENV = "CHATLOG_PYTHON_BIN";
export const DEFAULT_CHATLOG_PYTHON_BIN = "python3";

export interface ChatlogMcpConfig {
  scriptPath: string;
  pythonBin: string;
}

export interface LoadChatlogMcpConfigOptions {
  env?: NodeJS.ProcessEnv | undefined;
  envFilePath?: string | undefined;
}

export interface ChatlogMcpConnection {
  client: MCPClient | null;
  tools: ToolsInput;
  disconnect: () => Promise<void>;
}

function readOptionalEnvValue(
  key: string,
  env: NodeJS.ProcessEnv,
  fileEnv: NodeJS.Dict<string>,
): string {
  const hasProcessValue =
    Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined;
  const rawValue = hasProcessValue ? env[key] : fileEnv[key];
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

export function loadChatlogMcpConfig(
  options: LoadChatlogMcpConfigOptions = {},
): ChatlogMcpConfig | null {
  const env = options.env ?? process.env;
  const envFilePath =
    options.envFilePath ?? path.resolve(process.cwd(), ".env");

  let fileEnv: NodeJS.Dict<string> = {};
  try {
    fileEnv = readDotEnvFile(envFilePath);
  } catch {
    fileEnv = {};
  }

  const rawScript = readOptionalEnvValue(CHATLOG_MCP_SCRIPT_ENV, env, fileEnv);
  if (rawScript.length === 0) {
    return null;
  }

  const scriptPath = path.resolve(rawScript);
  if (!fs.existsSync(scriptPath)) {
    return null;
  }

  const rawPythonBin = readOptionalEnvValue(
    CHATLOG_PYTHON_BIN_ENV,
    env,
    fileEnv,
  );
  const pythonBin =
    rawPythonBin.length > 0 ? rawPythonBin : DEFAULT_CHATLOG_PYTHON_BIN;

  return {
    scriptPath,
    pythonBin,
  };
}

export function createChatlogMcpClient(config: ChatlogMcpConfig): MCPClient {
  const client = new MCPClient({
    id: `chatlog-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    registerProcessHooks: false,
    servers: {
      chatlog: {
        command: config.pythonBin,
        args: [config.scriptPath],
      },
    },
  });
  client.__setLogger(noopLogger);
  return client;
}

export async function connectChatlogMcpTools(
  options: LoadChatlogMcpConfigOptions = {},
): Promise<ChatlogMcpConnection> {
  const config = loadChatlogMcpConfig(options);
  if (!config) {
    return {
      client: null,
      tools: {},
      disconnect: async () => {},
    };
  }

  const client = createChatlogMcpClient(config);
  try {
    const tools = await client.listTools();
    return {
      client,
      tools,
      disconnect: async () => {
        try {
          await client.disconnect();
        } catch {
          // Ignore disconnect errors during cleanup
        }
      },
    };
  } catch {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors on failed connection
    }
    return {
      client: null,
      tools: {},
      disconnect: async () => {},
    };
  }
}
