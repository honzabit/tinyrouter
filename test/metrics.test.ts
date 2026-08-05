import { describe, expect, test } from "bun:test";
import { Metrics } from "../src/metrics.ts";

describe("metrics", () => {
  test("renders counters and escapes label values", () => {
    const metrics = new Metrics();
    metrics.requestStarted();
    metrics.requestFinished({ provider: "p", model: 'm"odel\n', status: "200" });
    const output = metrics.render();
    expect(output).toContain('tinyrouter_requests_total{provider="p",model="m\\"odel\\n",status="200"} 1');
    expect(output).toContain("tinyrouter_in_flight_requests 0");
  });

  test("reports which providers the breaker has demoted", () => {
    const metrics = new Metrics();
    // Read at scrape time rather than stored, so a circuit whose cooldown has
    // elapsed is not still reported as cooling.
    const output = metrics.render([
      { id: "anthropic", open: true },
      { id: "openai", open: false },
    ]);
    expect(output).toContain("# TYPE tinyrouter_circuit_open gauge");
    expect(output).toContain('tinyrouter_circuit_open{provider="anthropic"} 1');
    // Healthy providers still get a series: a missing one is indistinguishable
    // from a scrape that failed.
    expect(output).toContain('tinyrouter_circuit_open{provider="openai"} 0');
  });

  test("collapses new series into an overflow bucket at the cardinality cap", () => {
    const metrics = new Metrics();
    for (let index = 0; index <= 1000; index += 1) {
      metrics.attempt({ provider: "p", model: `model-${index}`, status: "200" });
    }
    const output = metrics.render();
    expect(output).toContain("tinyrouter_metrics_overflow_total 1");
    expect(output).toContain('model="__other__"');
    expect(output).not.toContain('model="model-1000"');
  });
});
