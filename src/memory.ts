import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { noopLogger } from "@mastra/core/logger";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

export const DEFAULT_MEMORY_DIR_NAME = ".memory";
export const DEFAULT_MEMORY_DB_FILENAME = "memory.db";
export const DEFAULT_SESSIONS_FILENAME = "sessions.json";
export const DEFAULT_STORAGE_ID = "personal-assistant-storage";
export const DEFAULT_LAST_MESSAGES = 20;
export const CLI_RESOURCE_ID = "local-cli-user";

export const NEW_CONVERSATION_REPLY =
  "已开启新对话，之前的长期偏好依然保留。";

export const WORKING_MEMORY_TEMPLATE = `# 用户长期偏好与个人资料
- **称呼与身份**:
- **回复风格偏好**:
- **待办与资料整理习惯**:
- **常驻背景与长期事项**:
`;

const NEW_CONVERSATION_COMMANDS = new Set([
  "新对话",
  "开启新对话",
  "/new",
  "--new",
]);

export interface MemoryContext {
  resource: string;
  thread: string;
}

export interface CreatePersonalMemoryOptions {
  memoryDir?: string | undefined;
  dbFileName?: string | undefined;
  storageId?: string | undefined;
  lastMessages?: number | undefined;
  workingMemoryTemplate?: string | undefined;
}

export interface PersonalMemoryBundle {
  memory: Memory;
  storage: LibSQLStore;
  memoryDir: string;
  dbPath: string;
}

export function resolveMemoryDir(
  memoryDir?: string,
  cwd: string = process.cwd(),
): string {
  return memoryDir
    ? path.resolve(memoryDir)
    : path.resolve(cwd, DEFAULT_MEMORY_DIR_NAME);
}

export function createPersonalMemory(
  options: CreatePersonalMemoryOptions = {},
): PersonalMemoryBundle {
  const memoryDir = resolveMemoryDir(options.memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });

  const dbFileName = options.dbFileName ?? DEFAULT_MEMORY_DB_FILENAME;
  const dbPath = path.join(memoryDir, dbFileName);
  const storageId = options.storageId ?? DEFAULT_STORAGE_ID;

  const storage = new LibSQLStore({
    id: storageId,
    url: `file:${dbPath}`,
  });
  storage.__setLogger(noopLogger);

  const memory = new Memory({
    storage,
    options: {
      lastMessages: options.lastMessages ?? DEFAULT_LAST_MESSAGES,
      semanticRecall: false,
      generateTitle: false,
      workingMemory: {
        enabled: true,
        scope: "resource",
        template: options.workingMemoryTemplate ?? WORKING_MEMORY_TEMPLATE,
      },
    },
  });
  memory.__setLogger(noopLogger);

  return {
    memory,
    storage,
    memoryDir,
    dbPath,
  };
}

export function isNewConversationCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return NEW_CONVERSATION_COMMANDS.has(normalized);
}

function getSessionsFilePath(memoryDir: string): string {
  return path.join(memoryDir, DEFAULT_SESSIONS_FILENAME);
}

export function readActiveSessions(memoryDir?: string): Record<string, string> {
  const resolvedDir = resolveMemoryDir(memoryDir);
  const filePath = getSessionsFilePath(resolvedDir);
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.trim().length > 0) {
        result[key] = value.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeActiveSessions(
  sessions: Record<string, string>,
  memoryDir?: string,
): void {
  const resolvedDir = resolveMemoryDir(memoryDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const filePath = getSessionsFilePath(resolvedDir);
  fs.writeFileSync(filePath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function generateThreadId(resourceId: string): string {
  const safeResource =
    resourceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "user";
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  return `thread-${safeResource}-${Date.now()}-${randomSuffix}`;
}

export function getOrCreateActiveThreadId(
  resourceId: string,
  memoryDir?: string,
): string {
  const normalizedResource = resourceId.trim();
  if (normalizedResource.length === 0) {
    throw new Error("resourceId must not be empty");
  }
  const sessions = readActiveSessions(memoryDir);
  const existing = sessions[normalizedResource];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return existing.trim();
  }
  const created = generateThreadId(normalizedResource);
  sessions[normalizedResource] = created;
  writeActiveSessions(sessions, memoryDir);
  return created;
}

export function rotateActiveThreadId(
  resourceId: string,
  memoryDir?: string,
): string {
  const normalizedResource = resourceId.trim();
  if (normalizedResource.length === 0) {
    throw new Error("resourceId must not be empty");
  }
  const sessions = readActiveSessions(memoryDir);
  const previous = sessions[normalizedResource];
  let nextThreadId = generateThreadId(normalizedResource);
  if (previous && nextThreadId === previous) {
    nextThreadId = `${nextThreadId}-next`;
  }
  sessions[normalizedResource] = nextThreadId;
  writeActiveSessions(sessions, memoryDir);
  return nextThreadId;
}
