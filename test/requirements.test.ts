import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { createGateway } from "../src/server.ts";
import type { JsonObject } from "../src/types.ts";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const tool = { type: "function", function: { name: "answer", parameters: schema } };
const strictTool = { ...tool, function: { ...tool.function, strict: true } };
const strictFormat = { type: "json_schema", json_schema: { name: "answer", schema, strict: true } };

interface UpstreamCall {
  host: string;
  body: JsonObject;
}

function success(host: string): Response {
  if (host === "anthropic.test") {
    return Response.json({
      id: "msg-ok",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
  }
  if (host === "gemini.test") {
    return Response.json({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });
  }
  return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
}

function setup(
  targets: string,
  respond: (call: UpstreamCall) => Response | Promise<Response> = (call) => success(call.host),
  retries = 0,
) {
  const config = parseConfig(`
routing:
  retries: ${retries}
  backoff_initial_ms: 0
  backoff_max_ms: 0
  circuit_breaker:
    failures: 1
    cooldown_ms: 30000
providers:
  first:
    type: openai
    api_key: first-secret
    base_url: https://first.test/v1
  anthropic:
    type: anthropic
    api_key: anthropic-secret
    base_url: https://anthropic.test/v1
  gemini:
    type: gemini
    api_key: gemini-secret
    base_url: https://gemini.test/v1beta
  compatible:
    type: openai-compatible
    base_url: https://compatible.test/v1
routes:
  smart: [${targets}]
`);
  const calls: UpstreamCall[] = [];
  const logs: JsonObject[] = [];
  const gateway = createGateway(config, {
    logger: { log: (record) => logs.push(record) },
    fetch: async (request) => {
      const call = {
        host: new URL(request.url).hostname,
        body: (await request.json()) as JsonObject,
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { gateway, calls, logs };
}

function request(extra: JsonObject = {}): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "requirements-test" },
    body: JSON.stringify({
      model: "smart",
      messages: [{ role: "user", content: "private-prompt-marker" }],
      ...extra,
    }),
  });
}

const unsupportedCases: Array<{ name: string; targets: string; extra: JsonObject; param: string }> = [
  {
    name: "Anthropic JSON object mode",
    targets: "anthropic/model",
    extra: { response_format: { type: "json_object" } },
    param: "response_format",
  },
  {
    name: "Anthropic JSON schema mode",
    targets: "anthropic/model",
    extra: { response_format: strictFormat },
    param: "response_format",
  },
  {
    name: "Gemini explicit strict JSON schema",
    targets: "gemini/model",
    extra: { response_format: strictFormat },
    param: "response_format.json_schema.strict",
  },
  {
    name: "strict tools across both native adapters",
    targets: "anthropic/model, gemini/model",
    extra: { tools: [tool, strictTool] },
    param: "tools[1].function.strict",
  },
  {
    name: "Gemini serial tool calls",
    targets: "gemini/model",
    extra: { tools: [tool], parallel_tool_calls: false },
    param: "parallel_tool_calls",
  },
  {
    name: "unknown response format",
    targets: "anthropic/model, gemini/model",
    extra: { response_format: { type: "private-format-marker" } },
    param: "response_format",
  },
  {
    name: "malformed response format",
    targets: "anthropic/model, gemini/model",
    extra: { response_format: [] },
    param: "response_format",
  },
  {
    name: "Gemini schema missing its schema",
    targets: "gemini/model",
    extra: { response_format: { type: "json_schema", json_schema: { name: "answer" } } },
    param: "response_format.json_schema.schema",
  },
  {
    name: "malformed parallel setting",
    targets: "anthropic/model, gemini/model",
    extra: { parallel_tool_calls: "false" },
    param: "parallel_tool_calls",
  },
];

describe("request requirements at the routing boundary", () => {
  test.each(unsupportedCases)("rejects $name without upstream work", async ({ targets, extra, param }) => {
    const { gateway, calls, logs } = setup(targets, undefined, 3);
    const response = await gateway.fetch(request(extra));
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("requirements-test");
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_parameter", type: "invalid_request_error", param },
    });
    expect(calls).toEqual([]);
    expect(gateway.router.circuitStates().providers.every((provider) => !provider.open)).toBe(true);
    expect(gateway.metrics.render()).not.toContain("tinyrouter_provider_attempts_total{");
    const failed = logs.find((record) => record.event === "request_failed");
    const attempts = failed?.attempts as JsonObject[];
    expect(attempts).toHaveLength(targets.split(",").length);
    expect(attempts.every((attempt) => attempt.outcome === "unsupported")).toBe(true);
    expect(attempts.at(-1)).toMatchObject({ errorCode: "unsupported_parameter", parameter: param });
    expect(JSON.stringify(logs)).not.toContain("private-prompt-marker");
    expect(JSON.stringify(logs)).not.toContain("private-format-marker");
  });

  test("strict constraints survive a real fallback without calling lossy adapters", async () => {
    const { gateway, calls, logs } = setup(
      "first/model, anthropic/model, gemini/model, compatible/model",
      (call) =>
        call.host === "first.test"
          ? Response.json({ error: { message: "busy" } }, { status: 503 })
          : success(call.host),
    );
    const extra = {
      response_format: strictFormat,
      tools: [strictTool],
      parallel_tool_calls: false,
      vendor_option: { keep: true },
    };
    const response = await gateway.fetch(request(extra));
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get("x-tinyrouter-provider")).toBe("compatible");
    expect(calls.map((call) => call.host)).toEqual(["first.test", "compatible.test"]);
    for (const call of calls) expect(call.body).toMatchObject(extra);
    expect(logs.find((record) => record.event === "request_completed")?.attempts).toEqual([
      expect.objectContaining({ outcome: "fallback", target: "first/model" }),
      expect.objectContaining({ outcome: "unsupported", parameter: "response_format" }),
      expect.objectContaining({ outcome: "unsupported", parameter: "response_format.json_schema.strict" }),
      expect.objectContaining({ outcome: "success", target: "compatible/model" }),
    ]);
    expect(gateway.router.circuitStates().providers.filter((provider) => provider.open)).toEqual([
      { id: "first", open: true },
    ]);
  });

  test.each(["json_object", "json_schema"])("preserves Gemini's non-strict %s translation", async (type) => {
    const { gateway, calls } = setup("anthropic/model, gemini/model");
    const response = await gateway.fetch(
      request({ response_format: { type, json_schema: { name: "answer", schema, strict: false } } }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(calls.map((call) => call.host)).toEqual(["gemini.test"]);
    expect(calls[0]?.body.generationConfig).toEqual({
      responseMimeType: "application/json",
      ...(type === "json_schema" ? { responseJsonSchema: schema } : {}),
    });
  });

  test("serial tools skip Gemini and retain Anthropic's existing translation", async () => {
    const { gateway, calls } = setup("gemini/model, anthropic/model");
    const response = await gateway.fetch(
      request({ tools: [tool], parallel_tool_calls: false, tool_choice: "required" }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(calls.map((call) => call.host)).toEqual(["anthropic.test"]);
    expect(calls[0]?.body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
    expect(calls[0]?.body.tools).toEqual([{ name: "answer", input_schema: schema }]);
  });

  test.each(["anthropic", "gemini"])("keeps ordinary requests working through %s", async (provider) => {
    for (const extra of [{}, { response_format: null }, { response_format: { type: "text" } }]) {
      const { gateway, calls } = setup(`${provider}/model`);
      const response = await gateway.fetch(request(extra));
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toHaveLength(1);
    }
  });

  test.each([undefined, null, false])("retains non-strict tools with strict=%s", async (strict) => {
    for (const provider of ["anthropic", "gemini"]) {
      const { gateway, calls } = setup(`${provider}/model`);
      const response = await gateway.fetch(
        request({ tools: [{ ...tool, function: { ...tool.function, strict } }] }),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toHaveLength(1);
    }
  });

  test("does not invent a serial-tool constraint when no calls can be made", async () => {
    for (const extra of [
      { parallel_tool_calls: false },
      { parallel_tool_calls: false, tools: [] },
      { parallel_tool_calls: false, tools: [tool], tool_choice: "none" },
      { parallel_tool_calls: true, tools: [tool] },
      { parallel_tool_calls: null, tools: [tool] },
    ]) {
      const { gateway, calls } = setup("gemini/model");
      const response = await gateway.fetch(request(extra));
      expect(response.status).toBe(200);
      await response.text();
      expect(calls).toHaveLength(1);
      if (extra.tool_choice === "none") {
        expect(calls[0]?.body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
      }
    }
  });

  test.each(["first", "compatible"])("keeps %s passthrough open to vendor extensions", async (provider) => {
    const { gateway, calls } = setup(`${provider}/model`);
    const extra = {
      response_format: { type: "vendor_format", config: { custom: true } },
      tools: [strictTool],
      parallel_tool_calls: false,
    };
    const response = await gateway.fetch(request(extra));
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]?.body).toMatchObject(extra);
  });

  test.each(["first/model, anthropic/model", "anthropic/model, first/model"])(
    "keeps a real upstream failure ahead of an incompatible target: %s",
    async (targets) => {
      const { gateway, calls } = setup(targets, () =>
        Response.json({ error: { message: "busy" } }, { status: 503 }),
      );
      const response = await gateway.fetch(request({ response_format: strictFormat }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { type: "service_unavailable", code: "503" } });
      expect(calls.map((call) => call.host)).toEqual(["first.test"]);
    },
  );

  test.each([400, 401])("does not turn upstream HTTP %s into a capability skip", async (status) => {
    const { gateway, calls } = setup("anthropic/model, first/model, compatible/model", () =>
      Response.json({ error: { message: "rejected" } }, { status }),
    );
    const response = await gateway.fetch(request({ response_format: strictFormat }));
    expect(response.status).toBe(status === 401 ? 502 : 400);
    expect(await response.json()).toMatchObject({ error: { code: String(status) } });
    expect(calls.map((call) => call.host)).toEqual(["first.test"]);
  });

  test("supports direct targets and reports the unsupported parameter", async () => {
    const { gateway, calls } = setup("compatible/model");
    const response = await gateway.fetch(request({ model: "anthropic/direct", tools: [strictTool] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { param: "tools[0].function.strict" } });
    expect(calls).toEqual([]);
  });

  test("does not call any target after the caller has already disconnected", async () => {
    const { gateway, calls } = setup("anthropic/model, compatible/model");
    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.router.route(
        { model: "smart", messages: [{ role: "user", content: "hello" }], response_format: strictFormat },
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 499, code: "client_closed_request" });
    expect(calls).toEqual([]);
  });

  test("does not replay constrained requests when the selected stream fails", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      },
    });
    const { gateway, calls } = setup(
      "anthropic/model, first/model, compatible/model",
      () => new Response(source, { headers: { "content-type": "text/event-stream" } }),
    );
    const response = await gateway.fetch(request({ stream: true, tools: [strictTool] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tinyrouter-provider")).toBe("first");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    upstream?.error(new Error("mock upstream stream failed"));
    await reader?.read().catch(() => undefined);
    await reader?.cancel().catch(() => undefined);
    expect(calls.map((call) => call.host)).toEqual(["first.test"]);
    expect(calls[0]?.body).toMatchObject({ stream: true, tools: [strictTool] });
  });
});
