export async function readResponseBytesLimited(response: Response, maxBytes: number, limitMessage: string): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    try { await response.body?.cancel(); } catch { /* The response stream may already be closed. */ }
    throw new Error(limitMessage);
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        try { await reader.cancel(); } catch { /* The response stream may already be closed. */ }
        throw new Error(limitMessage);
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseTextLimited(response: Response, maxBytes: number, limitMessage: string): Promise<string> {
  const bytes = await readResponseBytesLimited(response, maxBytes, limitMessage);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
