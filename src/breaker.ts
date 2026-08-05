export interface BreakerConfig {
  failures: number;
  cooldown_ms: number;
}

interface ProviderState {
  failures: number;
  openedAt?: number;
}

// Tracks consecutive retryable failures per provider so a target that is down
// can be skipped instead of costing every request a full timeout. State is
// in-memory and per process: nothing is persisted, and a restart starts clean.
//
// There is no separate half-open state. Once the cooldown elapses the circuit
// reports closed, so the next request probes the provider; because the failure
// count is still at the threshold, a single further failure reopens it for
// another full cooldown, and any success clears it.
export class CircuitBreaker {
  readonly enabled: boolean;
  #state = new Map<string, ProviderState>();

  constructor(
    private readonly config: BreakerConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = config.failures > 0;
  }

  isOpen(providerId: string): boolean {
    if (!this.enabled) return false;
    const openedAt = this.#state.get(providerId)?.openedAt;
    if (openedAt === undefined) return false;
    return this.now() - openedAt < this.config.cooldown_ms;
  }

  recordFailure(providerId: string): void {
    if (!this.enabled) return;
    const state = this.#state.get(providerId) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= this.config.failures) state.openedAt = this.now();
    this.#state.set(providerId, state);
  }

  recordSuccess(providerId: string): void {
    if (!this.enabled) return;
    this.#state.delete(providerId);
  }
}
