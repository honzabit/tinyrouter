#!/usr/bin/env bun
import { ConfigError, loadConfig, redactConfig } from "./config.ts";
import { jsonLogger } from "./logger.ts";
import { createGateway } from "./server.ts";

const VERSION = "0.1.0";
const SHUTDOWN_GRACE_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface CliOptions {
  configPath: string;
  check: boolean;
  printConfig: boolean;
}

function usage(): string {
  return `TinyRouter ${VERSION}

Usage:
  tinyrouter [--config PATH]
  tinyrouter --check [--config PATH]
  tinyrouter --print-config [--config PATH]

Options:
  --config PATH    Configuration file (default: tinyrouter.yaml)
  --check          Validate configuration and exit
  --print-config   Print resolved configuration with secrets redacted
  --version        Print version and exit
  --help           Show this help
`;
}

function parseCli(args: string[]): CliOptions {
  let configPath = process.env.TINYROUTER_CONFIG ?? "tinyrouter.yaml";
  let check = false;
  let printConfig = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      const value = args[index + 1];
      if (value === undefined) throw new ConfigError("--config requires a path.");
      configPath = value;
      index += 1;
    } else if (argument === "--check") check = true;
    else if (argument === "--print-config") printConfig = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (argument === "--version" || argument === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else {
      throw new ConfigError(`Unknown argument '${argument ?? ""}'.`);
    }
  }
  return { configPath, check, printConfig };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCli(args);
  const config = await loadConfig(options.configPath);
  if (options.printConfig) {
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }
  if (options.check) {
    console.log(`Configuration '${options.configPath}' is valid.`);
    return;
  }

  if (config.server.api_key === undefined && !LOOPBACK_HOSTS.has(config.server.host)) {
    jsonLogger.log({
      level: "warn",
      event: "server_unauthenticated",
      host: config.server.host,
      message:
        "server.api_key is not set and the host is not loopback; /v1 endpoints are open to anyone who can reach this address.",
    });
  }

  const gateway = createGateway(config);
  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    idleTimeout: config.server.idle_timeout_seconds,
    fetch: gateway.fetch,
  });

  jsonLogger.log({
    level: "info",
    event: "server_started",
    address: server.url.toString(),
    providers: Object.keys(config.providers),
    routes: Object.keys(config.routes),
  });

  const shutdown = (signal: string) => {
    jsonLogger.log({ level: "info", event: "server_stopping", signal });
    // Drain in-flight requests (including streams); force-close after the grace period.
    const force = setTimeout(() => {
      jsonLogger.log({ level: "warn", event: "server_force_stopped", grace_ms: SHUTDOWN_GRACE_MS });
      void server.stop(true).then(() => process.exit(0));
    }, SHUTDOWN_GRACE_MS);
    void server.stop(false).then(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tinyrouter: ${message}`);
    process.exit(1);
  });
}
