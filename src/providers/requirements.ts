import type { ProviderConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import type { ChatCompletionRequest, JsonObject } from "../types.ts";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsupported(type: ProviderConfig["type"], param: string): GatewayError {
  return new GatewayError({
    message: `The '${type}' adapter cannot preserve '${param}' for this request.`,
    status: 400,
    type: "invalid_request_error",
    code: "unsupported_parameter",
    param,
  });
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
}
