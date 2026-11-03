import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedChatRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockChatReply {
  status?: number;
  content?: string;
  rawBody?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export async function startMockOpenAIServer(
  handler: (req: RecordedChatRequest, index: number) => MockChatReply,
): Promise<{
  baseUrl: string;
  requests: RecordedChatRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedChatRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawText = Buffer.concat(chunks).toString("utf8");
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsedBody = { rawText };
      }

      const recorded: RecordedChatRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      };
      const index = requests.length;
      requests.push(recorded);

      const reply = handler(recorded, index);
      const status = reply.status ?? 200;

      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          reply.rawBody ??
            JSON.stringify({
              error: {
                message: reply.content ?? "mock error",
                type: "invalid_request_error",
              },
            }),
        );
        return;
      }

      const model =
        typeof parsedBody.model === "string" ? parsedBody.model : "mock-model";
      const isStream = parsedBody.stream === true;

      if (isStream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        if (reply.toolCall) {
          const chunk1 = {
            id: `chatcmpl-mock-${index}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: reply.toolCall.id,
                      type: "function",
                      function: {
                        name: reply.toolCall.name,
                        arguments: JSON.stringify(reply.toolCall.arguments),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          const chunk2 = {
            id: `chatcmpl-mock-${index}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "tool_calls",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
          res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }

        const chunk1 = {
          id: `chatcmpl-mock-${index}`,
          object: "chat.completion.chunk",
          created: 1700000000,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: reply.content ?? "",
              },
              finish_reason: null,
            },
          ],
        };
        const chunk2 = {
          id: `chatcmpl-mock-${index}`,
          object: "chat.completion.chunk",
          created: 1700000000,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      if (reply.toolCall) {
        res.end(
          JSON.stringify({
            id: `chatcmpl-mock-${index}`,
            object: "chat.completion",
            created: 1700000000,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: reply.toolCall.id,
                      type: "function",
                      function: {
                        name: reply.toolCall.name,
                        arguments: JSON.stringify(reply.toolCall.arguments),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          id: `chatcmpl-mock-${index}`,
          object: "chat.completion",
          created: 1700000000,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: reply.content ?? "",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
