import { open } from 'node:fs/promises';

export async function readFileTextLimited(path: string, maxBytes: number, limitMessage: string): Promise<string> {
  const file = await open(path, 'r');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let totalBytes = 0;
  try {
    while (true) {
      const remainingBytes = maxBytes + 1 - totalBytes;
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, remainingBytes), null);
      if (bytesRead === 0) break;
      if (bytesRead > maxBytes - totalBytes) throw new Error(limitMessage);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
  } finally {
    await file.close();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
}
