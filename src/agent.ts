import fs from "node:fs";
import path from "node:path";
import { Agent, type ToolsInput } from "@mastra/core/agent";
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
import {
  createPersonalMemory,
  type MemoryContext,
} from "./memory.js";

export const ASSISTANT_ID = "personal-assistant";
export const ASSISTANT_NAME = "个人资料助理";
export const ASSISTANT_INSTRUCTIONS =
  "你是个人资料助理，请用中文简洁回答。当用户要求“记住……”或表达个人长期偏好、整理习惯（如按负责人分组）时，请主动调用 updateWorkingMemory 工具更新长期偏好，并在后续对话中自动遵循已记录的偏好。当用户消息中已直接附带图片时，请直接根据画面内容回答，无需调用文件读取或命令行工具去读取该图片文件。";

export interface ImageAttachment {
  dataUrl: string;
  mimeType: string;
}

export interface CreateAgentOptions {
  workspaceDir?: string | undefined;
  memoryDir?: string | undefined;
  enableMemory?: boolean | undefined;
  tools?: ToolsInput | undefined;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function loadImageAttachmentsFromPaths(
  mediaPaths: readonly string[],
): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  for (const filePath of mediaPaths) {
    if (!filePath || typeof filePath !== "string") {
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (!mimeType) {
      continue;
    }
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const buffer = fs.readFileSync(filePath);
      if (buffer.length === 0) {
        continue;
      }
      attachments.push({
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      });
    } catch {
      // Ignore unreadable image files and fall back to text prompt
    }
  }
  return attachments;
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
  const resolvedMemoryDir =
    options.memoryDir ??
    (options.workspaceDir
      ? path.join(options.workspaceDir, ".memory")
      : path.resolve(process.cwd(), ".memory"));

  const memory =
    options.enableMemory === false
      ? undefined
      : createPersonalMemory({ memoryDir: resolvedMemoryDir }).memory;

  const tools =
    options.tools !== undefined && Object.keys(options.tools).length > 0
      ? options.tools
      : undefined;

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
    ...(memory ? { memory } : {}),
    ...(tools ? { tools } : {}),
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
  memoryContext?: MemoryContext,
  imageAttachments: readonly ImageAttachment[] = [],
): Promise<string> {
  try {
    const input =
      imageAttachments.length > 0
        ? [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: question },
                ...imageAttachments.map((img) => ({
                  type: "image" as const,
                  image: img.dataUrl,
                  mimeType: img.mimeType,
                })),
              ],
            },
          ]
        : question;

    const output = memoryContext
      ? await agent.generate(input, {
          maxSteps: 15,
          memory: {
            resource: memoryContext.resource,
            thread: memoryContext.thread,
          },
        })
      : await agent.generate(input, {
          maxSteps: 15,
        });
    if (output.error) {
      throw new ModelCallError();
    }
    const steps = Array.isArray(output.steps) ? output.steps : [];
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
    if (
      lastStep &&
      Array.isArray(lastStep.toolCalls) &&
      lastStep.toolCalls.length > 0
    ) {
      throw new ModelCallError();
    }
    const lastStepText =
      lastStep && typeof lastStep.text === "string"
        ? lastStep.text.trim()
        : "";
    const text =
      lastStepText.length > 0
        ? lastStepText
        : typeof output.text === "string"
          ? output.text.trim()
          : "";
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
