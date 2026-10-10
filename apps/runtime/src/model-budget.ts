import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Optional durable quota shared by Runtime and provider processes. Failed
 * requests consume a slot because the service may already have received them. */
export async function reserveModelRequest(endpoint: string, model: string, maxOutputTokens: number): Promise<void> {
 const path = process.env.AGENTOS_MODEL_BUDGET_PATH?.trim();
 const limitText = process.env.AGENTOS_MODEL_REQUEST_LIMIT?.trim();
 if (!path && !limitText) return;
 if (!path || !limitText || !/^(?:[1-9]\d?|100)$/.test(limitText)) throw new Error('Configure both a model quota path and a limit between 1 and 100.');
 const limit = Number(limitText), lock = `${path}.lock`;
 await mkdir(dirname(path), { recursive: true, mode: 0o700 });
 try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Model quota is busy; no request was sent.'); }
 try {
  let journal: { version: number; limit: number; endpoint: string; requests: { model: string; maxOutputTokens: number; reservedAt: string }[] };
  try { journal = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the model quota; no request was sent.'); journal = { version: 1, limit, endpoint, requests: [] }; }
  if (journal.version !== 1 || journal.limit !== limit || journal.endpoint !== endpoint || !Array.isArray(journal.requests) || journal.requests.length > limit) throw new Error('Model quota configuration changed; no request was sent.');
  if (journal.requests.length >= limit) throw new Error('Authorized model request quota is exhausted; no request was sent.');
  journal.requests.push({ model, maxOutputTokens, reservedAt: new Date().toISOString() });
  const file = await open(`${lock}/next.json`, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(journal, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(`${lock}/next.json`, path);
 } finally { await rm(lock, { recursive: true, force: true }); }
}
