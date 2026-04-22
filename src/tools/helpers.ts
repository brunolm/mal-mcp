import { MalApiError } from "../mal-client.js";

export type TextContent = { type: "text"; text: string };
export type ToolResult = {
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function textResult(value: unknown): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

export function errorResult(err: unknown): ToolResult {
  let text: string;
  if (err instanceof MalApiError) {
    text = `${err.message}\n${JSON.stringify(err.body, null, 2)}`;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { content: [{ type: "text", text }], isError: true };
}

export async function run<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}
