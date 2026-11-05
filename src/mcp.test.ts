import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  askPersonalAssistant,
  createPersonalAssistantAgent,
} from "./agent.js";
import {
  connectChatlogMcpTools,
  loadChatlogMcpConfig,
} from "./mcp.js";
import { startMockOpenAIServer } from "./test-helpers.js";

const REAL_CHATLOG_MCP_SCRIPT =
  "/Users/macm/Documents/workspace/clone/chatlog-archive/scripts/wechat/60_mcp_server.py";

function writeMockChatlogMcpScript(dir: string): string {
  const scriptPath = path.join(dir, "mock_60_mcp_server.py");
  const code = `#!/usr/bin/env python3
import json
import sys

TOOLS = [
    {
        "name": "wechat_sync_now",
        "description": "立即执行一次微信聊天记录增量同步",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "wechat_status",
        "description": "查看本地微信归档库状态",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "wechat_list_chats",
        "description": "列出微信会话列表",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
    },
    {
        "name": "wechat_search_messages",
        "description": "全文检索微信历史消息",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "wechat_get_chat_messages",
        "description": "获取指定微信会话的消息列表",
        "inputSchema": {"type": "object", "properties": {"chat": {"type": "string"}}, "required": ["chat"]},
    },
    {
        "name": "wechat_get_recent_messages",
        "description": "获取全库最近产生的微信消息",
        "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}},
    },
]

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method", "")
    req_id = msg.get("id")
    if method == "initialize":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "chatlog-wechat-mcp", "version": "1.0.0"},
            },
        }
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\\n")
        sys.stdout.flush()
    elif method == "tools/list":
        resp = {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\\n")
        sys.stdout.flush()
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        payload = {"total_chats": 12, "total_messages": 3456, "tool": name}
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                "isError": False,
            },
        }
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\\n")
        sys.stdout.flush()
`;
  fs.writeFileSync(scriptPath, code, "utf8");
  return scriptPath;
}

describe("Chatlog MCP Integration (Chapter 04)", () => {
  it("locks @mastra/mcp to exact version 2.8.0 in package.json without ^, ~, or latest", () => {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    assert.equal(pkg.dependencies?.["@mastra/mcp"], "2.8.0");

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const [name, version] of Object.entries(allDeps)) {
      assert.ok(
        !version.startsWith("^") &&
          !version.startsWith("~") &&
          version !== "latest",
        `Dependency ${name} must use exact version, found: ${version}`,
      );
    }
  });

  it("gracefully degrades to empty tools when CHATLOG_MCP_SCRIPT is unset, blank, or missing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-mcp-empty-"));
    const emptyEnvFile = path.join(tempDir, ".env");
    fs.writeFileSync(emptyEnvFile, "MODEL_NAME=gpt-6.1-sol\n", "utf8");

    try {
      assert.equal(
        loadChatlogMcpConfig({ env: {}, envFilePath: emptyEnvFile }),
        null,
      );
      assert.equal(
        loadChatlogMcpConfig({
          env: { CHATLOG_MCP_SCRIPT: "   " },
          envFilePath: emptyEnvFile,
        }),
        null,
      );
      assert.equal(
        loadChatlogMcpConfig({
          env: { CHATLOG_MCP_SCRIPT: path.join(tempDir, "does-not-exist.py") },
          envFilePath: emptyEnvFile,
        }),
        null,
      );

      const conn = await connectChatlogMcpTools({
        env: {},
        envFilePath: emptyEnvFile,
      });
      assert.equal(conn.client, null);
      assert.deepEqual(conn.tools, {});
      await conn.disconnect();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("connects to stdio MCP server, discovers 6 chatlog_wechat_* tools, and executes tool call via Agent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-mcp-conn-"));
    const scriptToUse = fs.existsSync(REAL_CHATLOG_MCP_SCRIPT)
      ? REAL_CHATLOG_MCP_SCRIPT
      : writeMockChatlogMcpScript(tempDir);

    const conn = await connectChatlogMcpTools({
      env: {
        CHATLOG_MCP_SCRIPT: scriptToUse,
        CHATLOG_PYTHON_BIN: "python3",
      },
      envFilePath: path.join(tempDir, ".env"),
    });

    const mockServer = await startMockOpenAIServer((_req, index) => {
      if (index === 0) {
        return {
          toolCall: {
            id: "call_mcp_status_1",
            name: "chatlog_wechat_status",
            arguments: {},
          },
        };
      }
      return {
        content: "已通过 MCP 工具查询本地微信归档库状态。",
      };
    });

    try {
      assert.ok(conn.client !== null);
      const toolNames = Object.keys(conn.tools);
      assert.ok(toolNames.includes("chatlog_wechat_status"));
      assert.ok(toolNames.includes("chatlog_wechat_sync_now"));
      assert.ok(toolNames.includes("chatlog_wechat_list_chats"));
      assert.ok(toolNames.includes("chatlog_wechat_search_messages"));
      assert.ok(toolNames.includes("chatlog_wechat_get_chat_messages"));
      assert.ok(toolNames.includes("chatlog_wechat_get_recent_messages"));

      const agent = createPersonalAssistantAgent(
        {
          baseUrl: mockServer.baseUrl,
          apiKey: "sk-synth-mcp-key",
          modelName: "gpt-6.1-sol",
        },
        {
          workspaceDir: path.join(tempDir, "workspace"),
          memoryDir: path.join(tempDir, ".memory"),
          tools: conn.tools,
        },
      );

      const reply = await askPersonalAssistant(
        agent,
        "查看我的微信归档库状态",
        ["sk-synth-mcp-key"],
      );
      assert.equal(reply, "已通过 MCP 工具查询本地微信归档库状态。");
      assert.equal(mockServer.requests.length, 2);

      // Verify the first request included chatlog_wechat_status in tools
      const firstReqTools = JSON.stringify(mockServer.requests[0]!.body.tools ?? []);
      assert.match(firstReqTools, /chatlog_wechat_status/);

      // Verify the second request carried the MCP tool output back to the model
      const secondReqMessages = JSON.stringify(
        mockServer.requests[1]!.body.messages ?? [],
      );
      assert.match(secondReqMessages, /total_chats/);
      assert.match(secondReqMessages, /total_messages/);
    } finally {
      await conn.disconnect();
      await mockServer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
