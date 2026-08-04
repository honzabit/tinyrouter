#!/usr/bin/env bun
// End-to-end smoke test. Spawns a real gateway configured with every provider
// whose credentials are present in the environment, then sends live traffic
// through the OpenAI-compatible surface: a completion, a streamed completion,
// and (for hosted providers) a forced tool call.
//
//   OPENAI_API_KEY=sk-... bun run smoke
//   SMOKE_LOCAL_BASE_URL=http://localhost:11434/v1 SMOKE_LOCAL_MODEL=qwen2.5:0.5b bun run smoke
//
// Providers without credentials are skipped. Exits 2 when nothing is enabled,
// 1 when any enabled check fails, 0 when every enabled check passes.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${NAME} spans in
// the generated YAML are TinyRouter's own environment placeholders, which keeps
// credentials out of the config file this script writes to disk.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SmokeTarget {
  name: string;
  target: string;
  providerYaml: string;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  maxTokens: number;
  checkTools: boolean;
  checkStreamUsage: boolean;
}

interface Failure {
  target: string;
  check: string;
  message: string;
}

interface Outcome {
  total: number;
  passed: number;
  failures: Failure[];
  skipped: Failure[];
}

const GATEWAY_KEY = "smoke-secret";
const PORT = Number(process.env.SMOKE_PORT ?? 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT_MS = 180_000;

function buildTargets(): SmokeTarget[] {
  const targets: SmokeTarget[] = [];
  if (process.env.OPENAI_API_KEY) {
    const model = process.env.SMOKE_OPENAI_MODEL ?? "gpt-5-mini";
    targets.push({
      name: "openai",
      target: `openai/${model}`,
      providerYaml: [
        "  openai:",
        "    type: openai",
        "    api_key: ${OPENAI_API_KEY}",
        "    timeout_ms: 120000",
      ].join("\n"),
      maxTokensField: "max_completion_tokens",
      maxTokens: 512,
      checkTools: true,
      checkStreamUsage: false,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.SMOKE_ANTHROPIC_MODEL ?? "claude-haiku-4-5";
    targets.push({
      name: "anthropic",
      target: `anthropic/${model}`,
      providerYaml: [
        "  anthropic:",
        "    type: anthropic",
        "    api_key: ${ANTHROPIC_API_KEY}",
        "    timeout_ms: 120000",
      ].join("\n"),
      maxTokensField: "max_completion_tokens",
      maxTokens: 256,
      checkTools: true,
      checkStreamUsage: true,
    });
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.SMOKE_GEMINI_MODEL ?? "gemini-flash-latest";
    targets.push({
      name: "gemini",
      target: `gemini/${model}`,
      providerYaml: [
        "  gemini:",
        "    type: gemini",
        "    api_key: ${GEMINI_API_KEY}",
        "    timeout_ms: 120000",
      ].join("\n"),
      maxTokensField: "max_completion_tokens",
      maxTokens: 256,
      checkTools: true,
      checkStreamUsage: true,
    });
  }
  if (process.env.SMOKE_LOCAL_BASE_URL) {
    const model = process.env.SMOKE_LOCAL_MODEL;
    if (model === undefined || model === "") {
      console.error("SMOKE_LOCAL_MODEL is required when SMOKE_LOCAL_BASE_URL is set.");
      process.exit(2);
    }
    targets.push({
      name: "local",
      target: `local/${model}`,
      providerYaml: [
        "  local:",
        "    type: openai-compatible",
        "    base_url: ${SMOKE_LOCAL_BASE_URL}",
        "    timeout_ms: 180000",
      ].join("\n"),
      maxTokensField: "max_tokens",
      maxTokens: 64,
      checkTools: false,
      checkStreamUsage: false,
    });
  }
  return targets;
}

function chat(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The gateway is still starting; retry.
    }
    await Bun.sleep(500);
  }
  throw new Error(`Gateway did not become ready at ${BASE} within 30s.`);
}

// A provider quota means the check could not run, not that the gateway is
// broken, so it is reported as skipped rather than failing a release.
class RateLimited extends Error {}

async function failedResponse(response: Response, check: string): Promise<Error> {
  const detail = `${check} returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`;
  return response.status === 429 ? new RateLimited(detail) : new Error(detail);
}

async function checkCompletion(target: SmokeTarget): Promise<void> {
  const response = await chat({
    model: target.target,
    messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
    [target.maxTokensField]: target.maxTokens,
  });
  if (response.status !== 200) throw await failedResponse(response, "completion");
  const provider = response.headers.get("x-tinyrouter-provider");
  if (provider !== target.name)
    throw new Error(`expected x-tinyrouter-provider '${target.name}', got '${provider}'`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { total_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`completion content is empty: ${JSON.stringify(body).slice(0, 400)}`);
  }
  if ((body.usage?.total_tokens ?? 0) <= 0)
    throw new Error("completion usage.total_tokens is missing or zero");
}

async function checkStreaming(target: SmokeTarget): Promise<void> {
  const response = await chat({
    model: target.target,
    messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
    [target.maxTokensField]: target.maxTokens,
    stream: true,
    ...(target.checkStreamUsage ? { stream_options: { include_usage: true } } : {}),
  });
  if (response.status !== 200) throw await failedResponse(response, "streaming");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream"))
    throw new Error(`unexpected stream content-type '${contentType}'`);

  const text = await response.text();
  if (!text.trimEnd().endsWith("data: [DONE]")) throw new Error("stream did not terminate with data: [DONE]");

  let streamedContent = "";
  let sawUsageChunk = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    const chunk = JSON.parse(line.slice(5)) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    streamedContent += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.choices?.length === 0 && (chunk.usage?.total_tokens ?? 0) > 0) sawUsageChunk = true;
  }
  if (streamedContent.trim() === "") throw new Error("stream produced no content deltas");
  if (target.checkStreamUsage && !sawUsageChunk) throw new Error("stream did not emit the final usage chunk");
}

async function checkToolCall(target: SmokeTarget): Promise<void> {
  const response = await chat({
    model: target.target,
    messages: [{ role: "user", content: "What is the weather in Paris right now?" }],
    [target.maxTokensField]: target.maxTokens,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a location.",
          parameters: {
            type: "object",
            properties: { location: { type: "string", description: "City name" } },
            required: ["location"],
          },
        },
      },
    ],
    tool_choice: "required",
  });
  if (response.status !== 200) throw await failedResponse(response, "tool call");
  const body = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
    }>;
  };
  const choice = body.choices?.[0];
  if (choice?.finish_reason !== "tool_calls") {
    throw new Error(`expected finish_reason 'tool_calls', got '${choice?.finish_reason}'`);
  }
  const call = choice.message?.tool_calls?.[0]?.function;
  if (call?.name !== "get_weather") throw new Error(`expected a get_weather call, got '${call?.name}'`);
  const parsed: unknown = JSON.parse(call.arguments ?? "");
  if (parsed === null || typeof parsed !== "object")
    throw new Error("tool call arguments are not a JSON object");
}

async function runTarget(target: SmokeTarget, outcome: Outcome): Promise<void> {
  const checks: Array<[string, (target: SmokeTarget) => Promise<void>]> = [
    ["completion", checkCompletion],
    ["streaming", checkStreaming],
    ...(target.checkTools ? [["tool call", checkToolCall] as [string, typeof checkToolCall]] : []),
  ];
  for (const [name, check] of checks) {
    outcome.total += 1;
    try {
      await check(target);
      outcome.passed += 1;
      console.log(`ok   ${target.target} ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RateLimited) {
        outcome.skipped.push({ target: target.target, check: name, message });
        console.warn(`skip ${target.target} ${name}: rate limited by the provider`);
        continue;
      }
      outcome.failures.push({ target: target.target, check: name, message });
      console.error(`FAIL ${target.target} ${name}: ${message}`);
    }
  }
}

const targets = buildTargets();
if (targets.length === 0) {
  console.error(
    "No smoke targets enabled. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY for hosted providers, " +
      "and/or SMOKE_LOCAL_BASE_URL + SMOKE_LOCAL_MODEL for a local OpenAI-compatible server.",
  );
  process.exit(2);
}

const configDir = await mkdtemp(join(tmpdir(), "tinyrouter-smoke-"));
const configPath = join(configDir, "smoke.yaml");
await writeFile(
  configPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    `  api_key: ${GATEWAY_KEY}`,
    "providers:",
    ...targets.map((target) => target.providerYaml),
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Smoke targets: ${targets.map((target) => target.target).join(", ")}`);
const gateway = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--config", configPath], {
  stdout: "inherit",
  stderr: "inherit",
});

const outcome: Outcome = { total: 0, passed: 0, failures: [], skipped: [] };
try {
  await waitForReady();
  for (const target of targets) {
    await runTarget(target, outcome);
  }
} finally {
  gateway.kill();
  await gateway.exited;
  await rm(configDir, { recursive: true, force: true });
}

if (outcome.failures.length > 0) {
  console.error(`\n${outcome.failures.length} smoke check(s) failed.`);
  process.exit(1);
}
if (outcome.passed === 0) {
  console.error(`\nEvery check was rate limited, so nothing was verified.`);
  process.exit(1);
}
if (outcome.skipped.length > 0) {
  console.warn(
    `\n${outcome.passed}/${outcome.total} smoke checks passed; ` +
      `${outcome.skipped.length} skipped because the provider rate limited them: ` +
      `${[...new Set(outcome.skipped.map((s) => s.target))].join(", ")}.`,
  );
  process.exit(0);
}
console.log(`\nAll smoke checks passed for ${targets.length} target(s).`);
