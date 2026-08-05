interface CounterLabels {
  provider: string;
  model: string;
  status: string;
}

interface TokenLabels {
  provider: string;
  model: string;
  kind: "prompt" | "completion";
}

// How a response body ended. The status line is already sent by then, so this
// is the only place a stalled or broken body is visible: the attempt counter
// recorded the 200 that preceded it.
interface BodyLabels {
  provider: string;
  model: string;
  outcome: "completed" | "stalled" | "failed" | "cancelled";
}

const MAX_SERIES_PER_COUNTER = 1_000;

function labelKey(provider: string, model: string, third: string): string {
  return `${provider}\u0000${model}\u0000${third}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class Metrics {
  readonly startedAt = Date.now();
  #requests = new Map<string, number>();
  #attempts = new Map<string, number>();
  #tokens = new Map<string, number>();
  #bodies = new Map<string, number>();
  #inFlight = 0;
  #overflow = 0;

  // On overflow the high-cardinality labels collapse, but `overflowThird`
  // lets a counter keep a label whose domain is small - token kinds stay
  // separable so summing by kind still accounts for collapsed series.
  #add(
    counter: Map<string, number>,
    provider: string,
    model: string,
    third: string,
    amount: number,
    overflowThird: string,
  ): void {
    let key = labelKey(provider, model, third);
    if (!counter.has(key) && counter.size >= MAX_SERIES_PER_COUNTER) {
      key = labelKey("__other__", "__other__", overflowThird);
      this.#overflow += 1;
    }
    counter.set(key, (counter.get(key) ?? 0) + amount);
  }

  requestStarted(): void {
    this.#inFlight += 1;
  }

  requestFinished(labels: CounterLabels): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#add(this.#requests, labels.provider, labels.model, labels.status, 1, "overflow");
  }

  attempt(labels: CounterLabels): void {
    this.#add(this.#attempts, labels.provider, labels.model, labels.status, 1, "overflow");
  }

  tokens(labels: TokenLabels, count: number): void {
    if (!Number.isInteger(count) || count <= 0) return;
    this.#add(this.#tokens, labels.provider, labels.model, labels.kind, count, labels.kind);
  }

  responseBody(labels: BodyLabels): void {
    this.#add(this.#bodies, labels.provider, labels.model, labels.outcome, 1, labels.outcome);
  }

  // Circuit state is passed in rather than held, because it is a function of
  // elapsed time: it has to be read from the breaker at scrape time.
  render(circuits: Array<{ id: string; open: boolean }> = []): string {
    const lines = [
      "# HELP tinyrouter_uptime_seconds Process uptime in seconds.",
      "# TYPE tinyrouter_uptime_seconds gauge",
      `tinyrouter_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      "# HELP tinyrouter_in_flight_requests Requests currently being processed.",
      "# TYPE tinyrouter_in_flight_requests gauge",
      `tinyrouter_in_flight_requests ${this.#inFlight}`,
      "# HELP tinyrouter_metrics_overflow_total Samples collapsed to prevent unbounded label cardinality.",
      "# TYPE tinyrouter_metrics_overflow_total counter",
      `tinyrouter_metrics_overflow_total ${this.#overflow}`,
      "# HELP tinyrouter_requests_total Completed gateway requests.",
      "# TYPE tinyrouter_requests_total counter",
    ];

    for (const [key, value] of [...this.#requests].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider = "", model = "", status = ""] = key.split("\u0000");
      lines.push(
        `tinyrouter_requests_total{provider="${escapeLabel(provider)}",model="${escapeLabel(model)}",status="${escapeLabel(status)}"} ${value}`,
      );
    }

    lines.push(
      "# HELP tinyrouter_provider_attempts_total Attempts sent to upstream providers.",
      "# TYPE tinyrouter_provider_attempts_total counter",
    );
    for (const [key, value] of [...this.#attempts].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider = "", model = "", status = ""] = key.split("\u0000");
      lines.push(
        `tinyrouter_provider_attempts_total{provider="${escapeLabel(provider)}",model="${escapeLabel(model)}",status="${escapeLabel(status)}"} ${value}`,
      );
    }

    lines.push(
      "# HELP tinyrouter_tokens_total Tokens reported by providers, by kind.",
      "# TYPE tinyrouter_tokens_total counter",
    );
    for (const [key, value] of [...this.#tokens].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider = "", model = "", kind = ""] = key.split("\u0000");
      lines.push(
        `tinyrouter_tokens_total{provider="${escapeLabel(provider)}",model="${escapeLabel(model)}",kind="${escapeLabel(kind)}"} ${value}`,
      );
    }

    lines.push(
      "# HELP tinyrouter_response_bodies_total How response bodies ended, after their status was already sent.",
      "# TYPE tinyrouter_response_bodies_total counter",
    );
    for (const [key, value] of [...this.#bodies].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider = "", model = "", outcome = ""] = key.split("\u0000");
      lines.push(
        `tinyrouter_response_bodies_total{provider="${escapeLabel(provider)}",model="${escapeLabel(model)}",outcome="${escapeLabel(outcome)}"} ${value}`,
      );
    }

    if (circuits.length > 0) {
      lines.push(
        "# HELP tinyrouter_circuit_open Providers currently demoted to a last resort by the circuit breaker.",
        "# TYPE tinyrouter_circuit_open gauge",
      );
      for (const circuit of [...circuits].sort((a, b) => a.id.localeCompare(b.id))) {
        // Healthy providers still get a series: absent is indistinguishable
        // from a scrape that never happened.
        lines.push(`tinyrouter_circuit_open{provider="${escapeLabel(circuit.id)}"} ${circuit.open ? 1 : 0}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }
}
