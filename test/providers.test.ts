import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { silentLogger } from "../src/logger.ts";
import type { Fetch } from "../src/router.ts";
import { createGateway } from "../src/server.ts";

interface CompletionBody {
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ErrorBody {
  error: { message: string; type: string; code?: string };
}

function gatewayFor(providerYaml: string, target: string, fetchFn: Fetch) {
  const config = parseConfig(`
providers:
${providerYaml}
routes:
  test: [${target}]
`);
  return createGateway(config, { fetch: fetchFn, logger: silentLogger });
}

function completionRequest(body: Record<string, unknown>): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "Weather in Athens?" }],
      ...body,
    }),
  });
}

describe("Anthropic adapter", () => {
  test("translates requests, tool calls, responses, and usage", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(
      `  anthropic:
    type: anthropic
    api_key: ant-secret
    base_url: https://anthropic.test/v1`,
      "anthropic/claude-test",
      async (request) => {
        expect(request.url).toBe("https://anthropic.test/v1/messages");
        expect(request.headers.get("x-api-key")).toBe("ant-secret");
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          id: "msg_1",
          type: "message",
          model: "claude-test",
          content: [
            { type: "text", text: "I'll check." },
            { type: "tool_use", id: "tool_1", name: "weather", input: { city: "Athens" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 12, output_tokens: 7 },
        });
      },
    );

    const response = await gateway.fetch(
      completionRequest({
        max_tokens: 100,
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    const body = (await response.json()) as CompletionBody & ErrorBody;

    expect(upstreamBody?.model).toBe("claude-test");
    expect(upstreamBody?.max_tokens).toBe(100);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"city":"Athens"}');
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  });

  test("translates Anthropic SSE into OpenAI chunks", async () => {
    const gateway = gatewayFor(
      `  anthropic:
    type: anthropic
    api_key: ant-secret
    base_url: https://anthropic.test/v1`,
      "anthropic/claude-test",
      async () =>
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":2}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await gateway.fetch(completionRequest({ stream: true }));
    const stream = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream).toContain('"content":"Hello"');
    expect(stream).toContain('"finish_reason":"stop"');
    expect(stream).toEndWith("data: [DONE]\n\n");
  });
});

describe("Gemini adapter", () => {
  test("translates requests and non-streaming responses", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(
      `  gemini:
    type: gemini
    api_key: gem-secret
    base_url: https://gemini.test/v1beta`,
      "gemini/gemini-test",
      async (request) => {
        expect(request.url).toBe("https://gemini.test/v1beta/models/gemini-test:generateContent");
        expect(request.headers.get("x-goog-api-key")).toBe("gem-secret");
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          responseId: "response-1",
          modelVersion: "gemini-test",
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "Sunny." }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
        });
      },
    );

    const response = await gateway.fetch(completionRequest({ temperature: 0.2 }));
    const body = (await response.json()) as CompletionBody & ErrorBody;
    expect((upstreamBody?.generationConfig as { temperature?: number } | undefined)?.temperature).toBe(0.2);
    expect(body.choices[0]?.message.content).toBe("Sunny.");
    expect(body.usage.total_tokens).toBe(10);
  });

  test("translates Gemini SSE into OpenAI chunks", async () => {
    const gateway = gatewayFor(
      `  gemini:
    type: gemini
    api_key: gem-secret
    base_url: https://gemini.test/v1beta`,
      "gemini/gemini-test",
      async (request) => {
        expect(request.url).toEndWith(":streamGenerateContent?alt=sse");
        return new Response(
          'data: {"responseId":"response-1","modelVersion":"gemini-test","candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    const response = await gateway.fetch(completionRequest({ stream: true }));
    const stream = await response.text();
    expect(stream).toContain('"content":"Hi"');
    expect(stream).toContain('"finish_reason":"stop"');
    expect(stream).toEndWith("data: [DONE]\n\n");
  });
});

const ANTHROPIC_PROVIDER = `  anthropic:
    type: anthropic
    api_key: ant-secret
    base_url: https://anthropic.test/v1`;

const GEMINI_PROVIDER = `  gemini:
    type: gemini
    api_key: gem-secret
    base_url: https://gemini.test/v1beta`;

const WEATHER_TOOL = {
  type: "function",
  function: { name: "weather", parameters: { type: "object", properties: {} } },
};

function anthropicMessageResponse(): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    model: "claude-test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe("Anthropic translation details", () => {
  test("maps tool_choice 'none' instead of dropping it", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(ANTHROPIC_PROVIDER, "anthropic/claude-test", async (request) => {
      upstreamBody = (await request.json()) as Record<string, unknown>;
      return anthropicMessageResponse();
    });

    const response = await gateway.fetch(completionRequest({ tools: [WEATHER_TOOL], tool_choice: "none" }));
    expect(response.status).toBe(200);
    expect(upstreamBody?.tool_choice).toEqual({ type: "none" });
  });

  test("maps parallel_tool_calls false to disable_parallel_tool_use", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(ANTHROPIC_PROVIDER, "anthropic/claude-test", async (request) => {
      upstreamBody = (await request.json()) as Record<string, unknown>;
      return anthropicMessageResponse();
    });

    await gateway.fetch(completionRequest({ tools: [WEATHER_TOOL], parallel_tool_calls: false }));
    expect(upstreamBody?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  test("converts data: image URLs into base64 image blocks", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(ANTHROPIC_PROVIDER, "anthropic/claude-test", async (request) => {
      upstreamBody = (await request.json()) as Record<string, unknown>;
      return anthropicMessageResponse();
    });

    await gateway.fetch(
      completionRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            ],
          },
        ],
      }),
    );
    const messages = upstreamBody?.messages as Array<{ content: unknown[] }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ]);
  });

  test("rejects content parts it cannot translate", async () => {
    let upstreamCalls = 0;
    const gateway = gatewayFor(ANTHROPIC_PROVIDER, "anthropic/claude-test", async () => {
      upstreamCalls += 1;
      return anthropicMessageResponse();
    });

    const response = await gateway.fetch(
      completionRequest({
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
      }),
    );
    const body = (await response.json()) as CompletionBody & ErrorBody;
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("unsupported_content");
    expect(upstreamCalls).toBe(0);
  });

  test("emits usage in a dedicated final chunk when include_usage is set", async () => {
    const gateway = gatewayFor(
      ANTHROPIC_PROVIDER,
      "anthropic/claude-test",
      async () =>
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":2}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const response = await gateway.fetch(
      completionRequest({ stream: true, stream_options: { include_usage: true } }),
    );
    const stream = await response.text();
    const frames = stream.split("\n\n").filter((frame) => frame !== "");
    const usageFrame = frames.at(-2);
    expect(usageFrame).toContain('"choices":[]');
    expect(usageFrame).toContain('"total_tokens":3');
    expect(frames.at(-1)).toBe("data: [DONE]");
    const finishFrame = frames.find((frame) => frame.includes('"finish_reason":"stop"'));
    expect(finishFrame).not.toContain('"usage"');
  });
});

describe("Gemini translation details", () => {
  test("converts data: image URLs into inlineData parts", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const gateway = gatewayFor(GEMINI_PROVIDER, "gemini/gemini-test", async (request) => {
      upstreamBody = (await request.json()) as Record<string, unknown>;
      return Response.json({
        responseId: "response-1",
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      });
    });

    await gateway.fetch(
      completionRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            ],
          },
        ],
      }),
    );
    const contents = upstreamBody?.contents as Array<{ parts: unknown[] }>;
    expect(contents[0]?.parts).toEqual([
      { text: "What is this?" },
      { inlineData: { mimeType: "image/png", data: "QUJD" } },
    ]);
  });

  test("rejects remote image URLs instead of silently dropping them", async () => {
    const gateway = gatewayFor(GEMINI_PROVIDER, "gemini/gemini-test", async () =>
      Response.json({ candidates: [] }),
    );

    const response = await gateway.fetch(
      completionRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.test/cat.png" } }],
          },
        ],
      }),
    );
    const body = (await response.json()) as CompletionBody & ErrorBody;
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("unsupported_content");
  });
});
