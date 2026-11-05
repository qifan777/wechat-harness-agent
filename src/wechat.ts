import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WeChatBot,
  type Credentials,
  type DownloadedMedia,
  type IncomingMessage,
  type Logger,
  type QrLoginCallbacks,
  type SendContent,
} from "@wechatbot/wechatbot";
import {
  askPersonalAssistant,
  createPersonalAssistantAgent,
  loadImageAttachmentsFromPaths,
  type ImageAttachment,
} from "./agent.js";
import {
  collectCandidateSecrets,
  formatCliError,
  loadModelConfig,
  redactSecrets,
} from "./config.js";
import {
  NEW_CONVERSATION_REPLY,
  getOrCreateActiveThreadId,
  isNewConversationCommand,
  rotateActiveThreadId,
  type MemoryContext,
} from "./memory.js";
import { connectChatlogMcpTools } from "./mcp.js";

export const DEFAULT_MAX_REPLY_CHARS = 1500;
export const DEFAULT_SEND_INTERVAL_MS = 1500;
export const DEFAULT_PREPARE_FAILED_RETRY_MS = 5000;
export const DEFAULT_MAX_SEND_RETRIES = 2;
export const DEFAULT_TYPING_HEARTBEAT_MS = 4000;

export const WECHAT_FALLBACK_REPLY = "抱歉，助理暂时无法生成回复，请稍后重试。";
export const WECHAT_MODEL_ERROR_LOG =
  "微信消息处理失败：模型调用异常，已向用户返回兜底提示";
export const WECHAT_SEND_ERROR_LOG =
  "微信消息发送失败：已记录错误并继续保持常驻监听";

const SENTENCE_END_CHARS = ["。", "！", "？", "；", ".", "!", "?", ";"];
const CLAUSE_END_CHARS = ["，", "、", ","];

export function splitReplyText(
  text: string,
  maxChars: number = DEFAULT_MAX_REPLY_CHARS,
): string[] {
  const safeMaxChars = Math.max(1, Math.floor(maxChars));
  const normalized = text.trim();
  if (normalized.length === 0) {
    return [];
  }
  if (normalized.length <= safeMaxChars) {
    return [normalized];
  }

  const segments: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    if (remaining.length <= safeMaxChars) {
      segments.push(remaining);
      break;
    }

    const window = remaining.slice(0, safeMaxChars);
    let splitIndex = -1;
    let consumeLength = 0;

    // 1. Prefer paragraph boundary (\n\n)
    const paragraphIdx = window.lastIndexOf("\n\n");
    if (paragraphIdx > 0) {
      splitIndex = paragraphIdx;
      consumeLength = 2;
    }

    // 2. Next prefer single line break (\n)
    if (splitIndex <= 0) {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx > 0) {
        splitIndex = lineIdx;
        consumeLength = 1;
      }
    }

    // 3. Next prefer sentence-ending punctuation
    if (splitIndex <= 0) {
      let bestSentenceIdx = -1;
      for (const punct of SENTENCE_END_CHARS) {
        const idx = window.lastIndexOf(punct);
        if (idx > bestSentenceIdx) {
          bestSentenceIdx = idx;
        }
      }
      if (bestSentenceIdx > 0) {
        splitIndex = bestSentenceIdx + 1;
        consumeLength = 0;
      }
    }

    // 4. Next prefer clause-separating punctuation
    if (splitIndex <= 0) {
      let bestClauseIdx = -1;
      for (const punct of CLAUSE_END_CHARS) {
        const idx = window.lastIndexOf(punct);
        if (idx > bestClauseIdx) {
          bestClauseIdx = idx;
        }
      }
      if (bestClauseIdx > 0) {
        splitIndex = bestClauseIdx + 1;
        consumeLength = 0;
      }
    }

    // 5. Fallback to hard split at safeMaxChars
    if (splitIndex <= 0) {
      splitIndex = safeMaxChars;
      consumeLength = 0;
    }

    const piece = remaining.slice(0, splitIndex).trim();
    if (piece.length > 0) {
      segments.push(piece);
    }
    remaining = remaining.slice(splitIndex + consumeLength).trimStart();
  }

  return segments;
}

export interface SendSegmentedReplyOptions {
  maxChars?: number | undefined;
  intervalMs?: number | undefined;
  retryDelayMs?: number | undefined;
  maxRetries?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  secrets?: readonly (string | undefined)[] | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrepareFailedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : String(error);
  return /prepare failed/i.test(message);
}

export async function sendSegmentedReply(
  sendSegment: (segment: string) => Promise<void>,
  text: string,
  options: SendSegmentedReplyOptions = {},
): Promise<string[]> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_REPLY_CHARS;
  const intervalMs = options.intervalMs ?? DEFAULT_SEND_INTERVAL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_PREPARE_FAILED_RETRY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_SEND_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const secrets = options.secrets ?? [];

  const safeText = redactSecrets(text, secrets);
  const segments = splitReplyText(safeText, maxChars);

  for (let i = 0; i < segments.length; i++) {
    const segment = redactSecrets(segments[i]!, secrets);
    if (i > 0 && intervalMs > 0) {
      await sleep(intervalMs);
    }

    let attempt = 0;
    while (true) {
      try {
        await sendSegment(segment);
        break;
      } catch (error: unknown) {
        if (isPrepareFailedError(error) && attempt < maxRetries) {
          attempt += 1;
          if (retryDelayMs > 0) {
            await sleep(retryDelayMs);
          }
          continue;
        }
        throw error;
      }
    }
  }

  return segments;
}

export function isIgnoredWeChatMessage(
  msg: Partial<IncomingMessage> | null | undefined,
  botUserId?: string,
): boolean {
  if (!msg || typeof msg.userId !== "string" || msg.userId.trim().length === 0) {
    return true;
  }

  const userId = msg.userId.trim();
  if (userId.endsWith("@chatroom")) {
    return true;
  }

  if (botUserId && userId === botUserId.trim()) {
    return true;
  }

  const raw = msg.raw;
  if (raw) {
    if (typeof raw.group_id === "string" && raw.group_id.trim().length > 0) {
      return true;
    }
    if (
      typeof raw.from_user_id === "string" &&
      raw.from_user_id.trim().endsWith("@chatroom")
    ) {
      return true;
    }
    if (
      typeof raw.to_user_id === "string" &&
      raw.to_user_id.trim().endsWith("@chatroom")
    ) {
      return true;
    }
    if (raw.message_type !== undefined && raw.message_type !== 1) {
      return true;
    }
  }

  return false;
}

export interface FormatInboundMessageOptions {
  mediaPaths?: readonly string[] | undefined;
}

export function formatInboundMessage(
  msg: IncomingMessage,
  options: FormatInboundMessageOptions = {},
): string | null {
  const parts: string[] = [];
  const mediaPaths = options.mediaPaths ?? [];
  let mediaPathCursor = 0;

  if (msg.quotedMessage) {
    const quotedFragments: string[] = [];
    if (msg.quotedMessage.title?.trim()) {
      quotedFragments.push(msg.quotedMessage.title.trim());
    }
    if (msg.quotedMessage.text?.trim()) {
      quotedFragments.push(msg.quotedMessage.text.trim());
    }
    if (quotedFragments.length > 0) {
      parts.push(`[引用消息: ${quotedFragments.join(" | ")}]`);
    } else if (msg.quotedMessage.type) {
      parts.push(`[引用消息: ${msg.quotedMessage.type}]`);
    }
  }

  // Handle voice messages: prefer WeChat built-in ASR transcription
  const hasVoices = Array.isArray(msg.voices) && msg.voices.length > 0;
  if (hasVoices || msg.type === "voice") {
    const voiceTexts = (msg.voices ?? [])
      .map((v) => v.text?.trim() ?? "")
      .filter((t) => t.length > 0);
    const rawMsgText = msg.text?.trim() ?? "";

    if (voiceTexts.length > 0) {
      parts.push(voiceTexts.join("\n"));
    } else if (rawMsgText.length > 0 && rawMsgText !== "[voice]") {
      parts.push(rawMsgText);
    } else {
      parts.push("[收到语音消息：微信未提供语音转写文本]");
    }
  } else {
    // Handle standard text / emoji content
    const rawText = msg.text?.trim() ?? "";
    const isPlaceholderOnly =
      rawText === "[image]" ||
      rawText === "[file]" ||
      rawText === "[video]" ||
      rawText === "[voice]";

    // When type is image and msg.text is just the image URL, avoid duplicating if msg.images also has it
    const firstImageUrl = msg.images?.[0]?.url?.trim();
    const isDuplicateImageUrl =
      msg.type === "image" &&
      Boolean(firstImageUrl && rawText === firstImageUrl);
    // When type is file and msg.text is just the file name, avoid duplicating if msg.files also has it
    const firstFileName = msg.files?.[0]?.fileName?.trim();
    const isDuplicateFileName =
      msg.type === "file" &&
      Boolean(firstFileName && rawText === firstFileName);

    if (
      rawText.length > 0 &&
      !isPlaceholderOnly &&
      !isDuplicateImageUrl &&
      !isDuplicateFileName
    ) {
      parts.push(rawText);
    }
  }

  // Handle images
  if (Array.isArray(msg.images) && msg.images.length > 0) {
    for (const img of msg.images) {
      const localPath = mediaPaths[mediaPathCursor++];
      const source =
        localPath ?? img.url?.trim() ?? img.media?.full_url?.trim() ?? "无可用链接";
      const dims =
        img.width && img.height ? ` (${img.width}x${img.height})` : "";
      parts.push(`[收到图片: ${source}${dims}]`);
    }
  } else if (msg.type === "image" && parts.length === 0) {
    const localPath = mediaPaths[mediaPathCursor++];
    parts.push(`[收到图片: ${localPath ?? "无可用链接"}]`);
  }

  // Handle files
  if (Array.isArray(msg.files) && msg.files.length > 0) {
    for (const file of msg.files) {
      const localPath = mediaPaths[mediaPathCursor++];
      const name = file.fileName?.trim() || "未命名文件";
      const sizeStr =
        typeof file.size === "number" ? `, 大小: ${file.size} 字节` : "";
      const locationStr =
        localPath ?? file.media?.full_url?.trim()
          ? `, 路径: ${localPath ?? file.media?.full_url?.trim()}`
          : "";
      parts.push(`[收到文件: ${name}${sizeStr}${locationStr}]`);
    }
  } else if (msg.type === "file" && parts.length === 0) {
    const localPath = mediaPaths[mediaPathCursor++];
    parts.push(`[收到文件: 未命名文件${localPath ? `, 路径: ${localPath}` : ""}]`);
  }

  // Handle videos
  if (Array.isArray(msg.videos) && msg.videos.length > 0) {
    for (const video of msg.videos) {
      const localPath = mediaPaths[mediaPathCursor++];
      const durationStr =
        typeof video.durationMs === "number"
          ? `, 时长: ${video.durationMs}ms`
          : "";
      const locationStr =
        localPath ?? video.media?.full_url?.trim()
          ? `, 路径: ${localPath ?? video.media?.full_url?.trim()}`
          : "";
      parts.push(`[收到视频${durationStr}${locationStr}]`);
    }
  } else if (msg.type === "video" && parts.length === 0) {
    const localPath = mediaPaths[mediaPathCursor++];
    parts.push(`[收到视频${localPath ? `: ${localPath}` : ""}]`);
  }

  const combined = parts.join("\n").trim();
  return combined.length > 0 ? combined : null;
}

const inMemorySessionThreads = new Map<string, string>();
const latestThreadImages = new Map<string, readonly ImageAttachment[]>();
const userMessageQueues = new Map<string, Promise<void>>();

export function enqueueWeChatUserTask(
  userId: string,
  task: () => Promise<void>,
): Promise<void> {
  const key = userId.trim() || "default-user";
  const previous = userMessageQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (userMessageQueues.get(key) === next) {
        userMessageQueues.delete(key);
      }
    });
  userMessageQueues.set(key, next);
  return next;
}

function getWeChatActiveThreadId(
  userId: string,
  memoryDir?: string,
): string {
  if (memoryDir) {
    return getOrCreateActiveThreadId(userId, memoryDir);
  }
  const existing = inMemorySessionThreads.get(userId);
  if (existing) {
    return existing;
  }
  const created = `thread-${userId}-${Date.now()}`;
  inMemorySessionThreads.set(userId, created);
  return created;
}

function rotateWeChatActiveThreadId(
  userId: string,
  memoryDir?: string,
): string {
  if (memoryDir) {
    return rotateActiveThreadId(userId, memoryDir);
  }
  const next = `thread-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  inMemorySessionThreads.set(userId, next);
  return next;
}

export interface WeChatMessageHandlerDeps {
  sendTyping: (userId: string) => Promise<void>;
  stopTyping?: ((userId: string) => Promise<void>) | undefined;
  typingHeartbeatMs?: number | undefined;
  askAgent: (
    prompt: string,
    secrets: readonly (string | undefined)[],
    memoryContext: MemoryContext,
    imageAttachments: readonly ImageAttachment[],
  ) => Promise<string>;
  sendReply: (userId: string, segment: string) => Promise<void>;
  getSecrets?: ((msg: IncomingMessage) => readonly (string | undefined)[]) | undefined;
  botUserId?: string | undefined;
  memoryDir?: string | undefined;
  onNewConversation?: ((userId: string) => void | Promise<void>) | undefined;
  sendOptions?: SendSegmentedReplyOptions | undefined;
  logError?: ((message: string) => void) | undefined;
  resolveMediaPaths?:
    | ((msg: IncomingMessage) => Promise<readonly string[]>)
    | undefined;
}

export async function handleIncomingWeChatMessage(
  msg: IncomingMessage,
  deps: WeChatMessageHandlerDeps,
): Promise<void> {
  if (isIgnoredWeChatMessage(msg, deps.botUserId)) {
    return;
  }

  const baseSecrets = deps.getSecrets ? deps.getSecrets(msg) : [];
  const secrets = [
    ...baseSecrets,
    typeof msg._contextToken === "string" ? msg._contextToken : undefined,
  ];
  const logError =
    deps.logError ??
    ((errLine: string) => {
      process.stderr.write(`${redactSecrets(errLine, secrets)}\n`);
    });

  const rawText = typeof msg.text === "string" ? msg.text.trim() : "";
  if (
    (msg.type === "text" || msg.type === "voice") &&
    !msg.quotedMessage &&
    isNewConversationCommand(rawText)
  ) {
    if (deps.onNewConversation) {
      await deps.onNewConversation(msg.userId);
    } else {
      rotateWeChatActiveThreadId(msg.userId, deps.memoryDir);
    }
    try {
      await deps.sendReply(
        msg.userId,
        redactSecrets(NEW_CONVERSATION_REPLY, secrets),
      );
    } catch (sendError: unknown) {
      const detail =
        sendError instanceof Error ? sendError.message : String(sendError);
      logError(redactSecrets(`${WECHAT_SEND_ERROR_LOG}（${detail}）`, secrets));
    }
    return;
  }

  let mediaPaths: readonly string[] = [];
  if (deps.resolveMediaPaths) {
    try {
      mediaPaths = await deps.resolveMediaPaths(msg);
    } catch {
      mediaPaths = [];
    }
  }

  const prompt = formatInboundMessage(msg, { mediaPaths });
  if (!prompt) {
    return;
  }

  const threadId = getWeChatActiveThreadId(msg.userId, deps.memoryDir);
  const memoryContext: MemoryContext = {
    resource: msg.userId,
    thread: threadId,
  };

  const directImages = loadImageAttachmentsFromPaths(mediaPaths);
  if (directImages.length > 0) {
    latestThreadImages.set(threadId, directImages);
  }
  const effectiveImages =
    directImages.length > 0
      ? directImages
      : msg.quotedMessage?.type === "image"
        ? (latestThreadImages.get(threadId) ?? [])
        : [];

  const triggerTypingSafely = async (): Promise<void> => {
    try {
      await deps.sendTyping(msg.userId);
    } catch (typingError: unknown) {
      const detail =
        typingError instanceof Error ? typingError.message : String(typingError);
      logError(
        redactSecrets(`触发微信正在输入状态失败（已忽略）：${detail}`, secrets),
      );
    }
  };

  // 1. Trigger "typing" status before calling the model, and keep heartbeat alive
  // because WeChat mobile client hides "对方正在输入..." after ~5-6s without renewal.
  await triggerTypingSafely();

  const heartbeatMs = deps.typingHeartbeatMs ?? DEFAULT_TYPING_HEARTBEAT_MS;
  const typingTimer =
    heartbeatMs > 0
      ? setInterval(() => {
          void triggerTypingSafely();
        }, heartbeatMs)
      : undefined;
  typingTimer?.unref?.();

  try {
    // 2. Call the Personal Assistant Agent with user resource, active session thread, and multimodal image attachments
    let replyText = "";
    try {
      const generated = await deps.askAgent(
        prompt,
        secrets,
        memoryContext,
        effectiveImages,
      );
      const trimmed = generated.trim();
      if (trimmed.length === 0) {
        throw new Error("Empty model reply");
      }
      replyText = redactSecrets(trimmed, secrets);
    } catch (modelError: unknown) {
      const detail =
        modelError instanceof Error ? modelError.message : String(modelError);
      logError(redactSecrets(`${WECHAT_MODEL_ERROR_LOG}（${detail}）`, secrets));
      replyText = WECHAT_FALLBACK_REPLY;
    }

    // 3. Send reply segments with rate limiting and prepare-failed backoff
    try {
      await sendSegmentedReply(
        async (segment) => {
          await deps.sendReply(msg.userId, redactSecrets(segment, secrets));
        },
        replyText,
        {
          ...deps.sendOptions,
          secrets,
        },
      );
    } catch (sendError: unknown) {
      const detail =
        sendError instanceof Error ? sendError.message : String(sendError);
      logError(redactSecrets(`${WECHAT_SEND_ERROR_LOG}（${detail}）`, secrets));
    }
  } finally {
    if (typingTimer !== undefined) {
      clearInterval(typingTimer);
    }
    if (deps.stopTyping) {
      try {
        await deps.stopTyping(msg.userId);
      } catch {
        // Ignore stopTyping errors
      }
    }
  }
}

export function createRedactedWeChatLogger(
  getSecrets: () => readonly (string | undefined)[],
  writeOut: (text: string) => void = (t) => process.stdout.write(t),
  writeErr: (text: string) => void = (t) => process.stderr.write(t),
  contextPrefix: string = "WeChatBot",
): Logger {
  const formatLine = (
    level: string,
    msg: string,
    data?: Record<string, unknown>,
  ): string => {
    const secrets = getSecrets();
    let suffix = "";
    if (data && Object.keys(data).length > 0) {
      try {
        suffix = ` ${JSON.stringify(data)}`;
      } catch {
        suffix = ` ${String(data)}`;
      }
    }
    const combined = `${msg}${suffix}`;
    return `${redactSecrets(`[${contextPrefix}:${level}] ${combined}`, secrets)}\n`;
  };

  return {
    debug() {
      // Suppress verbose debug logs to keep terminal clean and avoid leaking raw wire frames
    },
    info(msg: string, data?: Record<string, unknown>) {
      writeOut(formatLine("INFO", msg, data));
    },
    warn(msg: string, data?: Record<string, unknown>) {
      writeErr(formatLine("WARN", msg, data));
    },
    error(msg: string, data?: Record<string, unknown>) {
      writeErr(formatLine("ERROR", msg, data));
    },
    child(subContext: string): Logger {
      return createRedactedWeChatLogger(
        getSecrets,
        writeOut,
        writeErr,
        `${contextPrefix}:${subContext}`,
      );
    },
  };
}

export interface WeChatBotClientLike {
  login(options?: {
    force?: boolean;
    callbacks?: QrLoginCallbacks;
  }): Promise<Credentials>;
  start(): Promise<void>;
  stop(): void;
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): unknown;
  on(
    event: "error",
    handler: (error: Error) => void | Promise<void>,
  ): unknown;
  sendTyping(userId: string): Promise<void>;
  stopTyping?(userId: string): Promise<void>;
  send(userId: string, content: SendContent): Promise<void>;
  reply?(message: IncomingMessage, content: SendContent): Promise<void>;
  getCredentials(): Credentials | undefined;
  download?(message: IncomingMessage): Promise<DownloadedMedia | null>;
}

export interface RunWeChatDaemonOptions {
  env?: NodeJS.ProcessEnv | undefined;
  envFilePath?: string | undefined;
  storageDir?: string | undefined;
  workspaceDir?: string | undefined;
  memoryDir?: string | undefined;
  stdout?: Pick<NodeJS.WriteStream, "write"> | undefined;
  stderr?: Pick<NodeJS.WriteStream, "write"> | undefined;
  createBot?:
    | ((options: {
        storageDir: string;
        logger: Logger;
      }) => WeChatBotClientLike)
    | undefined;
}

export async function runWeChatDaemon(
  options: RunWeChatDaemonOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const storageDir =
    options.storageDir ?? path.resolve(process.cwd(), ".wechat");
  const workspaceDir =
    options.workspaceDir ?? path.resolve(process.cwd(), "workspace");
  const memoryDir =
    options.memoryDir ??
    (options.storageDir
      ? path.join(path.dirname(path.resolve(options.storageDir)), ".memory")
      : path.resolve(process.cwd(), ".memory"));

  const getSecrets = (extra: readonly (string | undefined)[] = []): string[] =>
    collectCandidateSecrets({
      env: options.env,
      envFilePath: options.envFilePath,
      wechatStorageDir: storageDir,
      extraSecrets: extra,
    });

  let modelConfig;
  try {
    modelConfig = loadModelConfig({
      env: options.env,
      envFilePath: options.envFilePath,
      wechatStorageDir: storageDir,
    });
  } catch (error: unknown) {
    const message = formatCliError(error, getSecrets());
    stderr.write(`${message}\n`);
    return 1;
  }

  const mcpConnection = await connectChatlogMcpTools({
    env: options.env,
    envFilePath: options.envFilePath,
  });
  const mcpToolNames = Object.keys(mcpConnection.tools);
  if (mcpToolNames.length > 0) {
    stdout.write(
      `[MCP] 已挂载 ${mcpToolNames.length} 个外部工具: ${mcpToolNames.join(", ")}\n`,
    );
  }

  const agent = createPersonalAssistantAgent(modelConfig, {
    workspaceDir,
    memoryDir,
    tools: mcpConnection.tools,
  });

  fs.mkdirSync(storageDir, { recursive: true });

  const logger = createRedactedWeChatLogger(
    () => getSecrets([modelConfig.apiKey]),
    (text) => stdout.write(text),
    (text) => stderr.write(text),
  );

  const bot: WeChatBotClientLike = options.createBot
    ? options.createBot({ storageDir, logger })
    : new WeChatBot({
        storage: "file",
        storageDir,
        logger,
      });

  const getRuntimeSecrets = (msg?: IncomingMessage): string[] => {
    const creds = bot.getCredentials();
    return getSecrets([
      modelConfig.apiKey,
      creds?.token,
      msg?._contextToken,
    ]);
  };

  try {
    await bot.login({
      callbacks: {
        onQrUrl(url: string) {
          stdout.write(
            `请使用手机微信扫描以下二维码链接完成登录：\n${url}\n`,
          );
        },
        onScanned() {
          stdout.write("已扫描二维码，请在手机微信上点击确认登录...\n");
        },
        onExpired() {
          stdout.write("二维码已过期，正在刷新二维码...\n");
        },
      },
    });
  } catch (loginError: unknown) {
    await mcpConnection.disconnect();
    const detail =
      loginError instanceof Error ? loginError.message : String(loginError);
    stderr.write(
      `${redactSecrets(`微信扫码登录失败：${detail}`, getRuntimeSecrets())}\n`,
    );
    return 1;
  }

  bot.onMessage(async (msg: IncomingMessage) => {
    await enqueueWeChatUserTask(msg.userId, async () => {
      const creds = bot.getCredentials();
      const runtimeSecrets = getRuntimeSecrets(msg);
      stdout.write(
        `${redactSecrets(`[微信消息] 收到私聊消息 (${msg.type})：${msg.text || "[媒体消息]"}`, runtimeSecrets)}\n`,
      );
      await handleIncomingWeChatMessage(msg, {
        botUserId: creds?.accountId,
        memoryDir,
        getSecrets: (incoming) => getRuntimeSecrets(incoming),
        resolveMediaPaths: async (incoming) => {
          if (
            !bot.download ||
            (incoming.type !== "image" &&
              incoming.type !== "file" &&
              incoming.type !== "video")
          ) {
            return [];
          }
          const downloaded = await bot.download(incoming);
          if (!downloaded) {
            return [];
          }
          const mediaDir = path.join(workspaceDir, "wechat-media");
          fs.mkdirSync(mediaDir, { recursive: true });
          const ext =
            downloaded.type === "image"
              ? ".jpg"
              : downloaded.type === "video"
                ? ".mp4"
                : "";
          const safeName = (
            downloaded.fileName ?? `${downloaded.type}-${Date.now()}${ext}`
          ).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
          const targetPath = path.join(mediaDir, safeName);
          fs.writeFileSync(targetPath, downloaded.data);
          return [targetPath];
        },
        sendTyping: async (userId: string) => {
          await bot.sendTyping(userId);
        },
        stopTyping: async (userId: string) => {
          if (bot.stopTyping) {
            await bot.stopTyping(userId);
          }
        },
        askAgent: async (
          prompt: string,
          secrets: readonly (string | undefined)[],
          memoryContext: MemoryContext,
          imageAttachments: readonly ImageAttachment[],
        ) =>
          askPersonalAssistant(
            agent,
            prompt,
            secrets,
            memoryContext,
            imageAttachments,
          ),
        sendReply: async (userId: string, segment: string) => {
          await bot.send(userId, segment);
          stdout.write(
            `${redactSecrets(`[微信消息] 已回复 (${segment.length} 字)`, runtimeSecrets)}\n`,
          );
        },
        logError: (errMsg: string) => {
          stderr.write(`${redactSecrets(errMsg, runtimeSecrets)}\n`);
        },
      });
    });
  });

  bot.on("error", (err: Error) => {
    stderr.write(
      `${redactSecrets(`微信通道运行异常（已忽略并继续监听）：${err.message}`, getRuntimeSecrets())}\n`,
    );
  });

  stdout.write("微信个人资料助理已启动，正在监听私聊消息...\n");
  await bot.start();
  return 0;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === entryFilePath) {
  process.on("uncaughtException", (error: Error) => {
    const secrets = collectCandidateSecrets();
    process.stderr.write(
      `${redactSecrets(`未捕获异常（已拦截以保持常驻）：${error.message}`, secrets)}\n`,
    );
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const secrets = collectCandidateSecrets();
    const detail = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(
      `${redactSecrets(`未处理 Promise 拒绝（已拦截以保持常驻）：${detail}`, secrets)}\n`,
    );
  });

  const code = await runWeChatDaemon();
  if (code !== 0) {
    process.exitCode = code;
  }
}
