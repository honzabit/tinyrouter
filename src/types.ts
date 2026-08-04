import { z } from "zod";

export type JsonObject = Record<string, unknown>;

const toolCallSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.looseObject({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const toolSchema = z.looseObject({
  type: z.literal("function"),
  function: z.looseObject({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const messageSchema = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.unknown().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

export const chatRequestSchema = z.looseObject({
  model: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\p{Cc}]+$/u, "must not contain control characters"),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().nullish() }).nullish(),
  tools: z.array(toolSchema).optional(),
});

export type OpenAIToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatRequestSchema>;

export interface ResolvedTarget {
  providerId: string;
  model: string;
  label: string;
}

export interface AttemptRecord {
  target: string;
  attempt: number;
  status?: number;
  durationMs: number;
  outcome: "success" | "retry" | "fallback" | "error";
  errorType?: string;
}

export interface RoutedResponse {
  response: Response;
  target: ResolvedTarget;
  attempts: AttemptRecord[];
}
