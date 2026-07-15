export async function readSseText(response: Response, onDelta: (text: string) => void) {
  if (!response.body) throw new Error("AI 响应没有可读取的数据流");
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
      const data = chunk
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      const parsed = JSON.parse(data) as { text?: string; code?: string; message?: string };
      if (parsed.text) onDelta(parsed.text);
      if (parsed.code) throw new Error(parsed.message ?? parsed.code);
    }
  }
}
