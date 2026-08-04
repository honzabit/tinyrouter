import { describe, expect, test } from "bun:test";
import { GatewayError } from "../src/errors.ts";
import { createFilterChain, type FilterConfig, filtersForProvider } from "../src/filters.ts";
import type { ChatCompletionRequest } from "../src/types.ts";

function request(content: unknown): ChatCompletionRequest {
  return { model: "smart", messages: [{ role: "user", content }] };
}

describe("filters", () => {
  test("returns untouched messages when nothing matches", () => {
    const chain = createFilterChain([
      { type: "block", patterns: ["anthropic_api_key", "aws_access_key", "private_key"] },
      { type: "redact", patterns: ["email", "credit_card", "e164_phone", "github_token"] },
    ]);
    const input = request("nothing sensitive here");
    const result = chain(input);
    // Scanning must not rebuild the request when no rule fired.
    expect(result.input).toBe(input);
    expect(result.input.messages[0]).toBe(input.messages[0]);
    expect(result.redactions).toBe(0);
  });

  test("rebuilds only the messages a rule actually changed", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const input: ChatCompletionRequest = {
      model: "smart",
      messages: [
        { role: "user", content: "untouched" },
        { role: "user", content: "mail a@b.co" },
      ],
    };
    const { input: output, redactions } = chain(input);
    expect(redactions).toBe(1);
    expect(output.messages[0]).toBe(input.messages[0]);
    expect(output.messages[1]).not.toBe(input.messages[1]);
    expect(output.messages[1]?.content).toBe("mail [redacted:email]");
  });

  test("no filters is the identity", () => {
    const chain = createFilterChain([]);
    const input = request("hello jane@example.com");
    const result = chain(input);
    expect(result.input).toBe(input);
    expect(result.redactions).toBe(0);
  });

  test("redacts built-in patterns in string content", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const { input, redactions } = chain(request("mail jane.doe@example.com today"));
    expect(input.messages[0]?.content).toBe("mail [redacted:email] today");
    expect(redactions).toBe(1);
  });

  test("redacts inside text parts and tool-call arguments", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const { input, redactions } = chain({
      model: "smart",
      messages: [
        { role: "user", content: [{ type: "text", text: "reach a@b.co" }] },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "send", arguments: '{"to":"a@b.co"}' } },
          ],
        },
      ],
    });
    expect(input.messages[0]?.content).toEqual([{ type: "text", text: "reach [redacted:email]" }]);
    expect(input.messages[1]?.tool_calls?.[0]?.function.arguments).toBe('{"to":"[redacted:email]"}');
    expect(redactions).toBe(2);
  });

  test("keeps tool-call arguments valid JSON when redacting", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["credit_card", "email"] }]);
    const { input, redactions } = chain({
      model: "smart",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "pay",
                arguments: '{"card":4111111111111111,"to":"a@b.co","amount":5,"ok":true}',
              },
            },
          ],
        },
      ],
    });
    const args = input.messages[0]?.tool_calls?.[0]?.function.arguments ?? "";
    const parsed = JSON.parse(args) as Record<string, unknown>;
    expect(parsed.card).toBe("[redacted:credit_card]");
    expect(parsed.to).toBe("[redacted:email]");
    expect(parsed.amount).toBe(5);
    expect(parsed.ok).toBe(true);
    expect(redactions).toBe(2);
  });

  test("leaves unmatched tool-call arguments byte-identical", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const original = '{\n  "city": "Athens",\n  "n": 1\n}';
    const input: ChatCompletionRequest = {
      model: "smart",
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: original } }],
        },
      ],
    };
    const { input: output, redactions } = chain(input);
    expect(redactions).toBe(0);
    expect(output.messages[0]?.tool_calls?.[0]?.function.arguments).toBe(original);
    expect(output.messages[0]).toBe(input.messages[0]);
  });

  test("still redacts tool-call arguments that are not valid JSON", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const { input, redactions } = chain({
      model: "smart",
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "not json a@b.co" } }],
        },
      ],
    });
    expect(input.messages[0]?.tool_calls?.[0]?.function.arguments).toBe("not json [redacted:email]");
    expect(redactions).toBe(1);
  });

  test("scans legacy function_call arguments", () => {
    const chain = createFilterChain([{ type: "block", patterns: ["anthropic_api_key"] }]);
    expect(() =>
      chain({
        model: "smart",
        messages: [
          {
            role: "assistant",
            function_call: { name: "f", arguments: '{"key":"sk-ant-abc123def456ghi"}' },
          },
        ],
      } as never),
    ).toThrow(GatewayError);
  });

  test("redacts legacy function_call arguments", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    const { input, redactions } = chain({
      model: "smart",
      messages: [{ role: "assistant", function_call: { name: "f", arguments: '{"to":"a@b.co"}' } }],
    } as never);
    const call = (input.messages[0] as { function_call?: { arguments?: string } }).function_call;
    expect(call?.arguments).toBe('{"to":"[redacted:email]"}');
    expect(redactions).toBe(1);
  });

  test("custom patterns use their configured name and replacement", () => {
    const chain = createFilterChain([
      { type: "redact", patterns: [], pattern: "EMP-\\d{6}", name: "employee_id", replacement: "<scrubbed>" },
    ]);
    const { input, redactions } = chain(request("ids EMP-123456 and EMP-654321"));
    expect(input.messages[0]?.content).toBe("ids <scrubbed> and <scrubbed>");
    expect(redactions).toBe(2);
  });

  test("block rejects the request without echoing the match", () => {
    const chain = createFilterChain([{ type: "block", patterns: ["anthropic_api_key"] }]);
    const secret = "sk-ant-abc123def456ghi";
    try {
      chain(request(`use ${secret} please`));
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBeInstanceOf(GatewayError);
      const error = caught as GatewayError;
      expect(error.status).toBe(400);
      expect(error.code).toBe("blocked_by_filter");
      expect(error.message).toContain("anthropic_api_key");
      expect(error.message).not.toContain(secret);
    }
  });

  test("filters run in configured order", () => {
    const chain = createFilterChain([
      { type: "redact", patterns: [], pattern: "sk-ant-[A-Za-z0-9-]+", name: "key" },
      { type: "block", patterns: ["anthropic_api_key"] },
    ]);
    const { input, redactions } = chain(request("key: sk-ant-abc123def456ghi"));
    expect(input.messages[0]?.content).toBe("key: [redacted:key]");
    expect(redactions).toBe(1);
  });

  test("leaves fields outside messages untouched", () => {
    const chain = createFilterChain([{ type: "redact", patterns: [], pattern: "smart", name: "brand" }]);
    const { input } = chain({
      model: "smart-model",
      messages: [{ role: "user", content: "smart" }],
      tools: [{ type: "function", function: { name: "smart_tool", parameters: {} } }],
    });
    expect(input.model).toBe("smart-model");
    expect(input.tools?.[0]?.function.name).toBe("smart_tool");
    expect(input.messages[0]?.content).toBe("[redacted:brand]");
  });

  test("scans only content and tool-call arguments, never structural fields", () => {
    const chain = createFilterChain([{ type: "redact", patterns: [], pattern: "user|call_1", name: "x" }]);
    const { input, redactions } = chain({
      model: "smart",
      messages: [
        {
          role: "user",
          name: "user",
          content: [
            { type: "text", text: "about user" },
            { type: "image_url", image_url: { url: "https://user.test/call_1.png" } },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "user_tool", arguments: '{"id":"call_1"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "user" },
      ],
    });
    expect(input.messages[0]?.role).toBe("user");
    expect(input.messages[0]?.name).toBe("user");
    expect(input.messages[0]?.content).toEqual([
      { type: "text", text: "about [redacted:x]" },
      { type: "image_url", image_url: { url: "https://user.test/call_1.png" } },
    ]);
    expect(input.messages[1]?.tool_calls?.[0]?.id).toBe("call_1");
    expect(input.messages[1]?.tool_calls?.[0]?.function.name).toBe("user_tool");
    expect(input.messages[1]?.tool_calls?.[0]?.function.arguments).toBe('{"id":"[redacted:x]"}');
    expect(input.messages[2]?.tool_call_id).toBe("call_1");
    expect(input.messages[2]?.content).toBe("[redacted:x]");
    expect(redactions).toBe(3);
  });

  test("never blocks on structural fields", () => {
    const chain = createFilterChain([{ type: "block", patterns: [], pattern: "^user$", name: "x" }]);
    const { redactions } = chain(request("hello"));
    expect(redactions).toBe(0);
  });

  test("filtersForProvider keeps unscoped filters and matching scopes only", () => {
    const unscoped: FilterConfig = { type: "block", patterns: ["email"] };
    const scoped: FilterConfig = { type: "redact", patterns: ["email"], providers: ["anthropic"] };
    expect(filtersForProvider([unscoped, scoped], "anthropic")).toEqual([unscoped, scoped]);
    expect(filtersForProvider([unscoped, scoped], "local")).toEqual([unscoped]);
  });

  test("block filters are not stateful across requests", () => {
    const chain = createFilterChain([{ type: "block", patterns: ["email"] }]);
    expect(() => chain(request("a@b.co"))).toThrow(GatewayError);
    expect(() => chain(request("a@b.co"))).toThrow(GatewayError);
  });

  test("scans large non-matching content in linear time", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email", "credit_card"] }]);
    // Adversarial: long runs of characters that are viable pattern prefixes but
    // never complete a match. A backtracking pattern turns this quadratic.
    for (const payload of ["a".repeat(2_000_000), "a+".repeat(1_000_000), "a.b_c%d".repeat(300_000)]) {
      const startedAt = performance.now();
      expect(chain(request(payload)).redactions).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    }
  });

  test("scans large matching content in linear time", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email", "credit_card"] }]);
    const startedAt = performance.now();
    chain(request("4111 1111 1111 1111 ".repeat(100_000)));
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("redacts a whole private key, not just its header", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["private_key"] }]);
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----";
    const { input } = chain(request(`key:\n${pem}\ndone`));
    expect(input.messages[0]?.content).toBe("key:\n[redacted:private_key]\ndone");
  });

  test("redacts a truncated private key through the end of the input", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["private_key"] }]);
    const { input } = chain(request("-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret"));
    expect(input.messages[0]?.content).toBe("[redacted:private_key]");
  });

  test("rejects custom patterns that match the empty string", () => {
    expect(() => createFilterChain([{ type: "redact", patterns: [], pattern: "foo|", name: "x" }])).toThrow(
      /empty/i,
    );
  });

  test("matches internationalized emails without partial redaction", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["email"] }]);
    for (const address of ["josé@example.com", "user@bücher.de", "müller.h@example.com"]) {
      const { input, redactions } = chain(request(`to ${address} ok`));
      expect(`${address} -> ${String(input.messages[0]?.content)}`).toBe(
        `${address} -> to [redacted:email] ok`,
      );
      expect(redactions).toBe(1);
    }
  });

  test("matches card numbers across groupings and unicode separators", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["credit_card"] }]);
    for (const card of [
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "4111111111111111",
      "3782 822463 10005",
      "3782822463 10005",
      "4111 1111 1111 1111",
      "4222222222222",
    ]) {
      expect(`${card} -> ${chain(request(`card ${card}.`)).redactions}`).toBe(`${card} -> 1`);
    }
  });

  test("does not treat ordinary numbers as card numbers", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["credit_card"] }]);
    for (const text of ["order 12345 shipped", "year 2026", "1234 5678"]) {
      expect(`${text} -> ${chain(request(text)).redactions}`).toBe(`${text} -> 0`);
    }
  });

  test("matches fine-grained GitHub tokens", () => {
    const chain = createFilterChain([{ type: "redact", patterns: ["github_token"] }]);
    expect(chain(request(`t github_pat_11ABCDE0${"a".repeat(60)} end`)).redactions).toBe(1);
  });

  test("built-in patterns match their canonical shapes", () => {
    const samples = {
      email: "user@example.com",
      e164_phone: "+14155552671",
      credit_card: "4111 1111 1111 1111",
      anthropic_api_key: "sk-ant-api03-abcdefghij",
      openai_api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz",
      aws_access_key: "AKIAIOSFODNN7EXAMPLE",
      github_token: `ghp_${"a".repeat(36)}`,
      private_key: "-----BEGIN RSA PRIVATE KEY-----",
    } as const;
    for (const [name, sample] of Object.entries(samples)) {
      const chain = createFilterChain([{ type: "redact", patterns: [name as keyof typeof samples] }]);
      const { redactions } = chain(request(`payload ${sample} end`));
      expect(`${name}:${redactions > 0}`).toBe(`${name}:true`);
    }
  });
});
