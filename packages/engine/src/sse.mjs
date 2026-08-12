/** SSE utilities shared by engine adapters. */
export const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 3.8));

/** Line-oriented SSE reader. Yields parsed JSON objects and {__event} markers. */
export async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try { yield JSON.parse(data); } catch { /* keep-alive */ }
        } else if (line.startsWith('event:')) {
          yield { __event: line.slice(6).trim() };
        }
      }
    }
  } finally { try { await reader.cancel(); } catch {} }
}
