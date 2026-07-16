import type { DocumentAgentResult } from "./documentAgent";

export async function readSseText(response: Response, onDelta: (text: string) => void): Promise<void> {
  await readSse(response, (event, data) => {
    if (event !== "message" && event !== "delta") return;
    const parsed = JSON.parse(data) as { text?: string; code?: string; message?: string };
    if (parsed.text) onDelta(parsed.text);
    if (parsed.code) throw new Error(parsed.message ?? parsed.code);
  });
}

export async function readAgentEditSse(
  response: Response,
  handlers: {
    onStatus?: (message: string) => void;
    onDelta?: (text: string) => void;
    onResult?: (result: DocumentAgentResult) => void;
  },
): Promise<void> {
  await readSse(response, (event, data) => {
    if (event === "status") {
      const parsed = JSON.parse(data) as { message?: string };
      if (parsed.message) handlers.onStatus?.(parsed.message);
      return;
    }
    if (event === "delta") {
      const parsed = JSON.parse(data) as { text?: string };
      if (parsed.text) handlers.onDelta?.(parsed.text);
      return;
    }
    if (event === "result") {
      handlers.onResult?.(JSON.parse(data) as DocumentAgentResult);
      return;
    }
    if (event === "error") {
      const parsed = JSON.parse(data) as { code: string; message?: string };
      throw new Error(parsed.message || parsed.code);
    }
  });
}

async function readSse(response: Response, onEvent: (event: string, data: string) => void): Promise<void> {
  if (!response.body) throw new Error("SSE 响应没有可读取的数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.trim() || chunk.startsWith(":")) continue;
      const event = chunk
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() ?? "message";
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) onEvent(event, data);
    }
  }
}
