import type { ProviderConfig } from "../config.ts";
import type { GatewayError } from "../errors.ts";
import type { ChatCompletionRequest, JsonObject } from "../types.ts";
import { ANTHROPIC_EFFORTS } from "./anthropic.ts";
import { GEMINI_THINKING_LEVELS } from "./gemini.ts";
import { unsupportedParameter } from "./provider.ts";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The tool choices both native adapters translate: the three keywords and one
// named function. Omitted or null is the default, auto.
function isTranslatedToolChoice(choice: unknown): boolean {
  if (choice === undefined || choice === null) return true;
  if (choice === "auto" || choice === "required" || choice === "none") return true;
  return (
    isObject(choice) &&
    choice.type === "function" &&
    isObject(choice.function) &&
    typeof choice.function.name === "string"
  );
}

function unsupported(type: ProviderConfig["type"], param: string): GatewayError {
  return unsupportedParameter(`The '${type}' adapter cannot preserve '${param}' for this request.`, param);
}

// This describes the translations TinyRouter implements, not a model catalog
// or a claim about everything a provider supports. Check before sending any
// bytes; the routing loop can skip an incompatible target without retrying it.
// Passthrough adapters leave both validation and enforcement to the upstream.
export function assertSupportedRequirements(
  input: ChatCompletionRequest,
  type: ProviderConfig["type"],
): void {
  if (type !== "anthropic" && type !== "gemini") return;

  const format = input.response_format;
  if (format !== undefined && format !== null) {
    if (!isObject(format)) throw unsupported(type, "response_format");
    if (format.type !== "text") {
      if (type === "anthropic" || (format.type !== "json_object" && format.type !== "json_schema")) {
        throw unsupported(type, "response_format");
      }
      if (format.type === "json_schema") {
        const jsonSchema = format.json_schema;
        if (!isObject(jsonSchema) || !isObject(jsonSchema.schema)) {
          throw unsupported(type, "response_format.json_schema.schema");
        }
        // Gemini's existing translation forwards the schema, but does not
        // implement OpenAI's explicit strict contract. Do not equate those.
        // Omitted/null/false retain the existing non-strict translation.
        if (jsonSchema.strict !== undefined && jsonSchema.strict !== null && jsonSchema.strict !== false) {
          throw unsupported(type, "response_format.json_schema.strict");
        }
      }
    }
  }

  for (const [index, tool] of (input.tools ?? []).entries()) {
    const strict = tool.function.strict;
    if (strict !== undefined && strict !== null && strict !== false) {
      throw unsupported(type, `tools[${index}].function.strict`);
    }
  }

  const parallel = input.parallel_tool_calls;
  if (parallel !== undefined && parallel !== null && typeof parallel !== "boolean") {
    throw unsupported(type, "parallel_tool_calls");
  }
  // With no tools, or with tool_choice:none, there are no calls to parallelize.
  // Anthropic already translates false into disable_parallel_tool_use; Gemini
  // currently has no equivalent translation in TinyRouter.
  if (
    type === "gemini" &&
    parallel === false &&
    (input.tools?.length ?? 0) > 0 &&
    input.tool_choice !== "none"
  ) {
    throw unsupported(type, "parallel_tool_calls");
  }

  // Any other tool choice, such as allowed_tools (which can require a call or
  // narrow which tools may be called) or a malformed one, translates to nothing
  // and leaves the model free to call any tool or none. With no tools there is
  // nothing to choose between, so nothing to weaken.
  if ((input.tools?.length ?? 0) > 0 && !isTranslatedToolChoice(input.tool_choice)) {
    throw unsupported(type, "tool_choice");
  }

  // Extra choices and token log probabilities change the response shape, and
  // neither translation returns them. Gemini's candidateCount is not used:
  // Gemini 3 and later reject it above 1, and the stream carries one candidate.
  const n = input.n;
  if (n !== undefined && n !== null && n !== 1) throw unsupported(type, "n");
  const logprobs = input.logprobs;
  if (logprobs !== undefined && logprobs !== null && logprobs !== false) {
    throw unsupported(type, "logprobs");
  }
  if (input.top_logprobs !== undefined && input.top_logprobs !== null) {
    throw unsupported(type, "top_logprobs");
  }

  // Only a level of the same name is translated; a nearby level would quietly
  // change how much the model reasons. seed is a best-effort hint and is not
  // checked: both native adapters drop it.
  const effort = input.reasoning_effort;
  if (effort !== undefined && effort !== null) {
    const levels = type === "anthropic" ? ANTHROPIC_EFFORTS : GEMINI_THINKING_LEVELS;
    if (typeof effort !== "string" || !levels.has(effort)) throw unsupported(type, "reasoning_effort");
  }
}
