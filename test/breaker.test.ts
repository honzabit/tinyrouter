import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../src/breaker.ts";

function breakerAt(failures: number, cooldownMs: number) {
  let now = 1_000;
  const breaker = new CircuitBreaker({ failures, cooldown_ms: cooldownMs }, () => now);
  return { breaker, advance: (ms: number) => (now += ms) };
}

describe("circuit breaker", () => {
  test("stays closed when disabled, however many failures arrive", () => {
    const { breaker } = breakerAt(0, 30_000);
    for (let index = 0; index < 10; index += 1) breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("opens only after the configured number of consecutive failures", () => {
    const { breaker } = breakerAt(3, 30_000);
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(false);
    breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(true);
  });

  test("a success resets the count before the circuit opens", () => {
    const { breaker } = breakerAt(3, 30_000);
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    breaker.recordSuccess("p");
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("tracks providers independently", () => {
    const { breaker } = breakerAt(2, 30_000);
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  test("allows a probe once the cooldown elapses", () => {
    const { breaker, advance } = breakerAt(1, 100);
    breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(true);
    advance(99);
    expect(breaker.isOpen("p")).toBe(true);
    advance(1);
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("a failed probe reopens for another full cooldown", () => {
    const { breaker, advance } = breakerAt(1, 100);
    breaker.recordFailure("p");
    advance(100);
    expect(breaker.isOpen("p")).toBe(false);
    breaker.recordFailure("p");
    expect(breaker.isOpen("p")).toBe(true);
    advance(99);
    expect(breaker.isOpen("p")).toBe(true);
    advance(1);
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("a successful probe closes the circuit", () => {
    const { breaker, advance } = breakerAt(1, 100);
    breaker.recordFailure("p");
    advance(100);
    breaker.recordSuccess("p");
    breaker.recordFailure("p");
    // The count restarted, so one failure reopens only because failures is 1.
    expect(breaker.isOpen("p")).toBe(true);
    breaker.recordSuccess("p");
    expect(breaker.isOpen("p")).toBe(false);
  });
});
