export type JsonObject = Record<string, unknown>;

export interface ChatCompletionRequest extends JsonObject {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface ChatMessage extends JsonObject {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

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
