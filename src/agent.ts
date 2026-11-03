import fs from "node:fs";
import path from "node:path";
import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from "@mastra/core/workspace";
import {
  ModelCallError,
  type ModelConfig,
  redactSecrets,
} from "./config.js";

export const ASSISTANT_ID = "personal-assistant";
export const ASSISTANT_NAME = "个人资料助理";
export const ASSISTANT_INSTRUCTIONS = "你是个人资料助理，请用中文简洁回答。";

export interface CreateAgentOptions {
  workspaceDir?: string | undefined;
}

export function createPersonalWorkspace(
  workspaceDir: string = path.resolve(process.cwd(), "workspace"),
): Workspace {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const filesystem = new LocalFilesystem({
    basePath: workspaceDir,
    contained: false,
  });
  filesystem.__setLogger(noopLogger);
  const sandbox = new LocalSandbox({
    workingDirectory: workspaceDir,
  });
  sandbox.__setLogger(noopLogger);
  const workspace = new Workspace({
    filesystem,
    sandbox,
  });
  workspace.__setLogger(noopLogger);
  return workspace;
}

export function createPersonalAssistantAgent(
  config: ModelConfig,
  options: CreateAgentOptions = {},
): Agent {
  const workspace = createPersonalWorkspace(options.workspaceDir);
  const agent = new Agent({
    id: ASSISTANT_ID,
    name: ASSISTANT_NAME,
    instructions: ASSISTANT_INSTRUCTIONS,
    model: {
      id: `openai/${config.modelName}` as const,
      url: config.baseUrl,
      apiKey: config.apiKey,
    },
    workspace,
    maxRetries: 0,
    errorProcessorDefaults: false,
  });
  agent.__setLogger(noopLogger);
  return agent;
}

export async function askPersonalAssistant(
  agent: Agent,
  question: string,
  secrets: readonly (string | undefined)[] = [],
): Promise<string> {
  try {
    const output = await agent.generate(question);
    if (output.error) {
      throw new ModelCallError();
    }
    const text = typeof output.text === "string" ? output.text.trim() : "";
    if (text.length === 0) {
      throw new ModelCallError();
    }
    return redactSecrets(text, secrets);
  } catch (error: unknown) {
    if (error instanceof ModelCallError) {
      throw error;
    }
    throw new ModelCallError();
  }
}
