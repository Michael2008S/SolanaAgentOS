import { runtimeDataPath } from './data-path.js';
import { runtimeNetwork, assertRuntimeNetwork } from './chain-network.js';
import { randomUUID, createHash } from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimeDatabase, runtimeStorageBackend } from './runtime-database.js';
import { readFileTextLimited } from './file-limits.js';
import { readResponseTextLimited } from './http-limits.js';

export type VerifiedMemory = {
  programId?: string;
  agent: string;
  execution: string;
  title: string;
  tags: string[];
  content: string;
  contentHash: string;
  storedAt: string;
  source?: 'skill' | 'escrow';
};

const memories: VerifiedMemory[] = [];
const memoryFile = runtimeDataPath('memory.json');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const maxEntries = 200;
const maxContentBytes = 65_536;
let restored = false;
let restoring: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<void> = Promise.resolve();
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function isValidSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { return decodeBase58(value).length === 32; } catch { return false; }
}

function decodeBase58(value: string): Uint8Array {
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58 value.');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...new Array<number>(leadingZeroes).fill(0), ...bytes]);
}

function encodeBase58(value: Uint8Array): string {
  let number = value.reduce((current, byte) => (current << 8n) | BigInt(byte), 0n);
  let result = '';
  while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + result;
}

function validEntry(value: unknown): value is VerifiedMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<VerifiedMemory>;
  return (item.programId === undefined || isValidSolanaAddress(item.programId)) && (item.source === undefined || item.source === 'skill' || item.source === 'escrow') && isValidSolanaAddress(item.agent) && isValidSolanaAddress(item.execution)
    && typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 120
    && Array.isArray(item.tags) && item.tags.length <= 10 && item.tags.every((tag) => typeof tag === 'string' && tag.length <= 48)
    && typeof item.content === 'string' && Buffer.byteLength(item.content, 'utf8') <= maxContentBytes
    && typeof item.contentHash === 'string' && /^[a-f0-9]{64}$/.test(item.contentHash) && sha256(item.content) === item.contentHash
    && typeof item.storedAt === 'string' && Number.isFinite(Date.parse(item.storedAt));
}

function normalized(entry: VerifiedMemory): VerifiedMemory {
  return { ...(entry.programId ? { programId: entry.programId } : {}), agent: entry.agent, execution: entry.execution, title: entry.title, tags: [...entry.tags], content: entry.content, contentHash: entry.contentHash, storedAt: entry.storedAt, ...(entry.source ? { source: entry.source } : {}) };
}
function validateEntries(values: unknown, requireProgram = false): VerifiedMemory[] {
  if (!Array.isArray(values) || values.length > maxEntries || !values.every(validEntry)) throw new Error('Memory storage contains invalid records or exceeds 200 entries. Existing data preserved.');
  const ids = new Set<string>();
  return values.map(entry => {
    if (requireProgram && !isValidSolanaAddress(entry.programId)) throw new Error('Database Memory requires a Program binding.');
    const key = `${entry.programId ?? 'legacy'}:${entry.execution}`;
    if (ids.has(key)) throw new Error('Memory storage contains duplicate Execution records.'); ids.add(key);
    return normalized(entry);
  });
}
export async function restoreVerifiedMemory(): Promise<void> {
  if (restored) return;
  restoring ??= (async () => {
    if (!persistentMemoryEnabled()) { restored = true; return; }
    const sqlite = runtimeStorageBackend() === 'sqlite';
    const legacy = async () => {
      let values: VerifiedMemory[];
      try { values = validateEntries(JSON.parse(await readFileTextLimited(memoryFile, 16_000_000, 'Memory storage exceeds 16 MB.'))); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
      if (!sqlite) return values;
      const programId = process.env.AGENTOS_PROGRAM_ID?.trim();
      if (values.some(entry => !entry.programId) && !isValidSolanaAddress(programId)) throw new Error('Configure AGENTOS_PROGRAM_ID before migrating legacy unbound Memory.');
      // Legacy namespace assignment is not chain verification. Every access still verifies RPC commitments.
      return validateEntries(values.map(entry => ({ ...entry, programId: entry.programId ?? programId })), true);
    };
    const values = validateEntries(sqlite ? await (await runtimeDatabase()).restore('verified-memory', legacy) : await legacy(), sqlite);
    values.sort((left, right) => Date.parse(right.storedAt) - Date.parse(left.storedAt));
    memories.splice(0, memories.length, ...values); restored = true;
  })().catch(error => { restoring = undefined; throw new Error(`Cannot restore Memory; existing storage preserved: ${error instanceof Error ? error.message : 'invalid storage'}`); });
  await restoring;
}
async function persist(): Promise<void> {
  if (!persistentMemoryEnabled()) return;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    validateEntries(memories, runtimeStorageBackend() === 'sqlite');
    if (Buffer.byteLength(JSON.stringify(memories)) > 16_000_000) throw new Error('Memory storage exceeds 16 MB; back it up before continuing.');
    if (runtimeStorageBackend() === 'sqlite') { (await runtimeDatabase()).replace('verified-memory', memories); return; }
    await mkdir(dirname(memoryFile), { recursive: true });
    const temporary = `${memoryFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(memories), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, memoryFile);
  });
  await writeQueue;
}
const currentProgram = () => process.env.AGENTOS_PROGRAM_ID?.trim();
const inCurrentProgram = (entry: VerifiedMemory) => entry.programId === undefined || entry.programId === currentProgram();

type RpcResponse<T> = { result?: T; error?: { message?: string } };
const verifiedRpcUrls = new Map<string, number>();
function rpcEndpoint(): URL {
  const endpoint = new URL(process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('SOLANA_RPC_URL must be an HTTP(S) URL without credentials or a URL fragment.');
  return endpoint;
}

async function rpc<T>(endpoint: URL, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} failed (${response.status}).`);
  const raw = await readResponseTextLimited(response, 2_000_000, `Solana RPC ${method} response exceeded the 2 MB limit.`);
  const payload = JSON.parse(raw) as RpcResponse<T>;
  if (payload.error) throw new Error(`Solana RPC ${method} failed: ${payload.error.message || 'RPC error'}`);
  if (payload.result === undefined) throw new Error(`Solana RPC ${method} returned no result.`);
  return payload.result;
}

async function assertDevnet(endpoint: URL): Promise<void> {
  const key = endpoint.toString();
  if ((verifiedRpcUrls.get(key) ?? 0) > Date.now()) return;
  assertRuntimeNetwork(endpoint, await rpc<string>(endpoint, 'getGenesisHash'));
  verifiedRpcUrls.set(key, Date.now() + 5 * 60_000);
}

async function verifyExecutionOutput(agent: string, execution: string, content: string): Promise<{ hash: string; source: 'skill' | 'escrow'; programId: string }> {
  const programId = process.env.AGENTOS_PROGRAM_ID?.trim();
  if (!isValidSolanaAddress(programId)) throw new Error('Set AGENTOS_PROGRAM_ID in apps/runtime/.env to verify memory commitments.');
  if (Buffer.byteLength(content, 'utf8') > maxContentBytes) throw new Error('Memory content exceeds the 64 KiB limit.');
  const endpoint = rpcEndpoint();
  await assertDevnet(endpoint);
  const accountInfo = await rpc<{ value: { owner?: unknown; data?: unknown } | null }>(endpoint, 'getAccountInfo', [execution, { encoding: 'base64', commitment: 'confirmed' }]);
  const account = accountInfo.value;
  if (!account || account.owner !== programId || !Array.isArray(account.data) || typeof account.data[0] !== 'string' || account.data[1] !== 'base64') throw new Error('The Execution account was not found in the configured AgentOS Devnet program.');
  const data = Buffer.from(account.data[0], 'base64');
  const discriminator = createHash('sha256').update('account:Execution').digest().subarray(0, 8);
  if (data.length !== 132 || !discriminator.every((byte, index) => data[index] === byte)) throw new Error('The Execution account data is invalid or has no recorded result.');
  if (encodeBase58(data.subarray(8, 40)) !== agent || ![1, 2, 3].includes(data[49]) || data[98] !== 1 || data[48] > 1) throw new Error('Memory requires a completed Skill or released Escrow Execution belonging to this Agent.');
  const [canonical] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [
    new TextEncoder().encode('execution'), getAddressEncoder().encode(address(agent)), data.subarray(40, 48),
  ] });
  if (execution !== canonical) throw new Error('Memory proof is not the canonical Execution PDA.');
  const statusOffset = 131;
  if (data.length <= statusOffset || data[statusOffset] !== 0) throw new Error('The Execution is not complete; refunded and negotiated outcomes cannot be saved as accepted results.');
  const outputHash = data.subarray(99, 131).toString('hex');
  const actualHash = sha256(content);
  if (outputHash !== actualHash) throw new Error('The supplied memory content does not match the on-chain Execution output hash.');
  return { programId, hash: outputHash, source: data[49] === 2 ? 'escrow' : 'skill' };
}

export async function rememberVerifiedExecution(input: {
  agent: string;
  execution: string;
  title: string;
  content: string;
  tags?: string[];
}): Promise<Omit<VerifiedMemory, 'content'>> {
  await restoreVerifiedMemory();
  if (!isValidSolanaAddress(input.agent) || !isValidSolanaAddress(input.execution)) throw new Error('Enter valid Agent and Execution Solana addresses.');
  const title = input.title.trim();
  if (!title || title.length > 120) throw new Error('Memory title must contain 1–120 characters.');
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 10);
  if (tags.some((tag) => tag.length > 48)) throw new Error('Memory tags must be 48 characters or shorter.');
  const { hash: contentHash, source, programId } = await verifyExecutionOutput(input.agent, input.execution, input.content);
  return serializeMutation(async () => {
    const previous = memories.find((entry) => inCurrentProgram(entry) && entry.execution === input.execution);
    if (previous) {
      if (previous.contentHash !== contentHash || previous.agent !== input.agent || (previous.source && previous.source !== source)) throw new Error('This Execution is already linked to different local memory.');
      return { programId, agent: previous.agent, execution: previous.execution, title: previous.title, tags: previous.tags, contentHash: previous.contentHash, storedAt: previous.storedAt, source };
    }
    if (memories.length >= maxEntries) throw new Error('Memory storage is full (200 entries). Back up and archive records before saving more; no prior evidence was removed.');
    const priorEntries = memories.slice();
    const entry: VerifiedMemory = { programId, agent: input.agent, execution: input.execution, title, tags, content: input.content, contentHash, source, storedAt: new Date().toISOString() };
    memories.unshift(entry);
    try { await persist(); }
    catch (error) {
      memories.splice(0, memories.length, ...priorEntries);
      throw new Error(`Could not persist local memory: ${error instanceof Error ? error.message : 'write failed'}`);
    }
    return { programId, agent: entry.agent, execution: entry.execution, title: entry.title, tags: entry.tags, contentHash: entry.contentHash, storedAt: entry.storedAt, source: entry.source };
  });
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 30);
}

export async function searchVerifiedMemory(query: string, agent?: string, limit = 5): Promise<VerifiedMemory[]> {
  await restoreVerifiedMemory();
  const queryTokens = tokens(query);
  if (!query.trim() || query.length > 500 || queryTokens.length === 0) throw new Error('Enter a search query containing at least one word.');
  if (agent && !isValidSolanaAddress(agent)) throw new Error('The Agent filter must be a valid Solana address.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Memory result limit must be between 1 and 10.');
  const ranked = memories.filter((entry) => inCurrentProgram(entry) && (!agent || entry.agent === agent)).map((entry) => {
    const title = new Set(tokens(entry.title));
    const tagSet = new Set(entry.tags.flatMap(tokens));
    const content = new Set(tokens(entry.content));
    const score = queryTokens.reduce((total, token) => total + (tagSet.has(token) ? 4 : 0) + (title.has(token) ? 2 : 0) + (content.has(token) ? 1 : 0), 0);
    return { entry, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || right.entry.storedAt.localeCompare(left.entry.storedAt)).slice(0, limit);
  if (ranked.length === 0) return [];
  const verified = await Promise.all(ranked.map(async ({ entry }) => {
    const verified = await verifyExecutionOutput(entry.agent, entry.execution, entry.content);
    if (entry.source && entry.source !== verified.source) throw new Error('Stored Memory source does not match its Execution.');
    return verified.hash === entry.contentHash && sha256(entry.content) === entry.contentHash ? { ...entry, tags: [...entry.tags], programId: verified.programId, source: verified.source } : null;
  }));
  return verified.filter((entry) => entry !== null);
}

export async function recentVerifiedMemory(limit = 5, agent?: string): Promise<VerifiedMemory[]> {
  await restoreVerifiedMemory();
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Memory result limit must be between 1 and 10.');
  if (agent && !isValidSolanaAddress(agent)) throw new Error('The Agent filter must be a valid Solana address.');
  const selected = memories.filter((entry) => inCurrentProgram(entry) && (!agent || entry.agent === agent)).slice(0, limit);
  const verified = await Promise.all(selected.map(async (entry) => {
    const verified = await verifyExecutionOutput(entry.agent, entry.execution, entry.content);
    if (entry.source && entry.source !== verified.source) throw new Error('Stored Memory source does not match its Execution.');
    return verified.hash === entry.contentHash ? { ...entry, tags: [...entry.tags], programId: verified.programId, source: verified.source } : null;
  }));
  return verified.filter((entry) => entry !== null);
}

export function verifiedMemoryCount(agent?: string): number {
  return memories.filter((entry) => inCurrentProgram(entry) && (!agent || entry.agent === agent)).length;
}

export function persistentMemoryEnabled(): boolean {
  return runtimeStorageBackend() === 'sqlite' || process.env.AGENTOS_PERSIST_MEMORY === 'true';
}

export async function getVerifiedMemory(agent: string, execution: string): Promise<VerifiedMemory> {
  if (!isValidSolanaAddress(agent) || !isValidSolanaAddress(execution)) throw new Error('Provide valid Agent and Execution addresses.');
  await restoreVerifiedMemory();
  const entry = memories.find((item) => inCurrentProgram(item) && item.agent === agent && item.execution === execution);
  if (!entry) throw new Error('The selected result is not saved in this Agent’s local Memory. Save its verified Skill result first.');
  const verified = await verifyExecutionOutput(agent, execution, entry.content);
  if (verified.hash !== entry.contentHash || (entry.source && entry.source !== verified.source)) throw new Error('Stored Memory does not match its Execution proof.');
  return { ...entry, tags: [...entry.tags], programId: verified.programId, source: verified.source };
}

/** Exact local snapshot for archiving. Export hashes prove bytes, not live chain validity. */
export async function exportMemorySnapshot(agent: string) {
  if (!isValidSolanaAddress(agent)) throw new Error('A valid Agent address is required.');
  const programId = process.env.AGENTOS_PROGRAM_ID?.trim();
  if (!isValidSolanaAddress(programId)) throw new Error('Configure a valid Program before exporting Memory.');
  await restoreVerifiedMemory();
  return serializeMutation(async () => {
    const entries = validateEntries(memories.filter(entry => inCurrentProgram(entry) && entry.agent === agent)).map(entry => ({ ...entry, tags: [...entry.tags] }));
    const entriesJson = JSON.stringify(entries);
    return { format: 'agentos-memory-snapshot', version: 1, network: runtimeNetwork().identity, programId, agent,
      exportedAt: new Date().toISOString(), verification: 'storage-hashes-only',
      entriesSha256: sha256(entriesJson), count: entries.length, entries };
  });
}


export async function archiveMemoryRecord(agent: string, execution: string, expectedHash: string) {
  if (!isValidSolanaAddress(agent) || !isValidSolanaAddress(execution) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid Memory archive request.');
  const programId = currentProgram();
  if (!isValidSolanaAddress(programId)) throw new Error('Configure a valid Program before archiving.');
  await restoreVerifiedMemory();
  return serializeMutation(async () => {
    const index = memories.findIndex(entry => inCurrentProgram(entry) && entry.agent === agent && entry.execution === execution);
    if (index < 0) throw new Error('Memory record is absent; refresh before archiving.');
    const entry = memories[index];
    validateEntries([entry]);
    if (entry.contentHash !== expectedHash) throw new Error('Memory changed since review.');
    const snapshot = { format: 'agentos-memory-archive', version: 1, network: runtimeNetwork().identity, programId, agent,
      archivedAt: new Date().toISOString(), verification: 'storage-hashes-only', entry };
    const body = JSON.stringify(snapshot);
    const directory = runtimeDataPath('memory-archives/');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archiveFile = join(directory, `${execution}-${randomUUID()}.json`);
    const file = await open(archiveFile, 'wx', 0o600);
    try { await file.writeFile(body, 'utf8'); await file.sync(); } finally { await file.close(); }
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const previous = memories.slice();
    memories.splice(index, 1);
    try { await persist(); } catch (error) { memories.splice(0, memories.length, ...previous); throw new Error(`Archive copy retained at ${archiveFile}; active Memory update failed. ${error instanceof Error ? error.message : 'Storage failure.'}`); }
    return { archived: true, execution, contentHash: expectedHash, archiveFile, archiveSha256: sha256(body), remaining: verifiedMemoryCount(agent) };
  });
}
