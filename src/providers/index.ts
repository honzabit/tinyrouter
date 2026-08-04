import type { ProviderConfig, TinyRouterConfig } from "../config.ts";
import type { ProviderAdapter } from "./provider.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAICompatibleAdapter } from "./openai-compatible.ts";

function createAdapter(id: string, config: ProviderConfig): ProviderAdapter {
  switch (config.type) {
    case "openai":
    case "openai-compatible":
      return new OpenAICompatibleAdapter(id, config);
    case "anthropic":
      return new AnthropicAdapter(id, config);
    case "gemini":
      return new GeminiAdapter(id, config);
  }
}

export function createAdapters(config: TinyRouterConfig): Map<string, ProviderAdapter> {
  return new Map(
    Object.entries(config.providers).map(([id, provider]) => [id, createAdapter(id, provider)]),
  );
}
