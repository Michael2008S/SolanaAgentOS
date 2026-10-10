import { runtimeDataPath } from './data-path.js';
import { mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readResponseBytesLimited } from './http-limits.js';

export function loadRuntimeEnv(): void {
  for (const envFile of [fileURLToPath(new URL('../.env', import.meta.url)), '.env']) {
    try { loadEnvFile(envFile); break; } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

export function localAppOrigins(): string[] {
  const values = (process.env.AGENTOS_WEB_ORIGINS?.trim() || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim());
  if (!values.length || values.length > 8 || new Set(values).size !== values.length || values.some((value) => { try { const url = new URL(value); return !['http:', 'https:'].includes(url.protocol) || url.origin !== value || Boolean(url.username || url.password); } catch { return true; } })) throw new Error('AGENTOS_WEB_ORIGINS requires up to eight distinct exact HTTP(S) origins, without paths or credentials.');
  return values;
}

export function localProviderConfig(skillName: string, defaultPort: number, path: string): { programId: string; skill: string; port: number; resourceUrl: string } {
  const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const programId = process.env.AGENTOS_PROGRAM_ID?.trim() || '';
  const skill = process.env[`AGENTOS_${skillName}_SKILL`]?.trim() || '';
  const port = Number(process.env[`AGENTOS_${skillName}_PORT`] || String(defaultPort));
  if (!addressPattern.test(programId) || !addressPattern.test(skill)) throw new Error(`Set valid AGENTOS_PROGRAM_ID and AGENTOS_${skillName}_SKILL addresses in apps/runtime/.env.`);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`AGENTOS_${skillName}_PORT must be an integer from 1024 to 65535.`);
  return { programId, skill, port, resourceUrl: `http://127.0.0.1:${port}${path}` };
}

export function localClaimExecution(namespace: string): (execution: string, signature: string) => Promise<boolean> {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error('Invalid local Skill claim namespace.');
  const directory = runtimeDataPath(`${namespace}-claims`);
  return async (execution, signature) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(execution)) throw new Error('Invalid Execution address for local Skill claim.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(join(directory, `${execution}.json`), 'wx', 0o600); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
    try {
      await file.writeFile(JSON.stringify({ execution, signature, claimedAt: new Date().toISOString() }));
      await file.sync();
    } finally { await file.close(); }
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return true;
  };
}

export function serveLocalProvider(port: number, path: string, resourceUrl: string, handler: (request: Request) => Promise<Response>): void {
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url !== path) { outgoing.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of incoming) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > 16_384) { outgoing.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      const requestHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => requestHeaders.append(name, item));
        else if (value !== undefined) requestHeaders.set(name, value);
      }
      const request = new Request(resourceUrl, {
        method: incoming.method,
        headers: requestHeaders,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handler(request);
      const responseBody = await readResponseBytesLimited(response, 65_536, 'The Skill result exceeds the 64 KiB response limit.');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(responseBody));
    } catch (error) {
      outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 300) : 'Skill provider failed.' }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`AgentOS Skill provider is listening at ${resourceUrl}`);
    console.log('Register this exact endpoint URL in the Skill Registry before using paid requests.');
  });
}
