import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { createGateway } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import type { Fetch } from "../src/router.ts";

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
      async (requestInfo) => {
        const request = requestInfo as Request;
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
    const body = (await response.json()) as any;

    expect(upstreamBody?.model).toBe("claude-test");
    expect(upstreamBody?.max_tokens).toBe(100);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Athens"}');
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
      async (requestInfo) => {
        const request = requestInfo as Request;
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
    const body = (await response.json()) as any;
    expect((upstreamBody?.generationConfig as any).temperature).toBe(0.2);
    expect(body.choices[0].message.content).toBe("Sunny.");
    expect(body.usage.total_tokens).toBe(10);
  });

  test("translates Gemini SSE into OpenAI chunks", async () => {
    const gateway = gatewayFor(
      `  gemini:
    type: gemini
    api_key: gem-secret
    base_url: https://gemini.test/v1beta`,
      "gemini/gemini-test",
      async (requestInfo) => {
        expect((requestInfo as Request).url).toEndWith(":streamGenerateContent?alt=sse");
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
