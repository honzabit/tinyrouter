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

const MAX_SERIES_PER_COUNTER = 1_000;

function labelKey(labels: CounterLabels): string {
  return `${labels.provider}\u0000${labels.model}\u0000${labels.status}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class Metrics {
  readonly startedAt = Date.now();
  #requests = new Map<string, number>();
  #attempts = new Map<string, number>();
  #tokens = new Map<string, number>();
  #inFlight = 0;
  #overflow = 0;

  #add(counter: Map<string, number>, labels: CounterLabels, amount: number): void {
    let key = labelKey(labels);
    if (!counter.has(key) && counter.size >= MAX_SERIES_PER_COUNTER) {
      key = labelKey({ provider: "__other__", model: "__other__", status: "overflow" });
      this.#overflow += 1;
    }
    counter.set(key, (counter.get(key) ?? 0) + amount);
  }

  #increment(counter: Map<string, number>, labels: CounterLabels): void {
    this.#add(counter, labels, 1);
  }

  requestStarted(): void {
    this.#inFlight += 1;
  }

  requestFinished(labels: CounterLabels): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#increment(this.#requests, labels);
  }

  attempt(labels: CounterLabels): void {
    this.#increment(this.#attempts, labels);
  }

  tokens(labels: TokenLabels, count: number): void {
    if (count <= 0) return;
    this.#add(this.#tokens, { provider: labels.provider, model: labels.model, status: labels.kind }, count);
  }

  render(): string {
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

    return `${lines.join("\n")}\n`;
  }
}
