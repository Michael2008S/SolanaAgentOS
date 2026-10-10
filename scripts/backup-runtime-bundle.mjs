import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { loadEnvFile(resolve(root, 'apps/runtime/.env')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--database', '--output', '--archives'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) throw new Error('Use unique --database, --output and --archives options with values.');
  options.set(args[i], args[i + 1]);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Runtime bundle requires Node.js 24+.');
const database = resolve(options.get('--database') || process.env.AGENTOS_DATABASE_PATH?.trim() || resolve(root, 'apps/runtime/.data/agentos.sqlite'));
const archives = resolve(options.get('--archives') || resolve(root, 'apps/runtime/.data/memory-archives'));
const output = resolve(options.get('--output') || resolve(root, `apps/runtime/.data/backups/bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const { DatabaseSync } = await import('node:sqlite');
const stat = await lstat(database);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000000) throw new Error('Invalid source database.');
const db = new DatabaseSync(database, { readOnly: true });
try {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x41474f53 || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Source is not an AgentOS database.');
  // One quiescent snapshot is needed across SQLite and external archive files.
  if (db.prepare('SELECT id FROM runtime_owner').get()) throw new Error('Stop Runtime cleanly before a combined backup. Use backup:runtime for an online database-only copy.');
} finally { db.close(); }
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 }); // Refuse existing output, including failed bundles.
const writeExclusive = async (path, bytes) => { const file = await open(path, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
// The existing tool creates and checks a consistent SQLite copy and clears copy ownership.
const result = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/backup-runtime-db.mjs'), '--database', database, '--output', resolve(output, 'agentos.sqlite')], { maxBuffer: 1000000 });
const databaseReport = JSON.parse(result.stdout);
files.push({ path: 'agentos.sqlite', bytes: databaseReport.bytes, sha256: databaseReport.sha256 });
let names = [];
try {
  const stat = await lstat(archives);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Archives must be a regular directory.');
  names = await readdir(archives);
} catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (names.length > 10000) throw new Error('Archive directory exceeds 10,000 files.');
await mkdir(resolve(output, 'memory-archives'), { mode: 0o700 });
let total = databaseReport.bytes;
for (const name of names.sort()) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}-[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Unexpected file in archive directory. Preserve it separately before bundling.');
  const path = resolve(archives, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 400000 || (total += stat.size) > 200000000) throw new Error('Archive type or bundle capacity is invalid.');
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error('Archive changed during backup.');
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (body?.format !== 'agentos-memory-archive' || body.version !== 1 || body.network !== 'devnet-preview' || body.verification !== 'storage-hashes-only' || typeof body.entry?.content !== 'string' || digest(Buffer.from(body.entry.content)) !== body.entry.contentHash) throw new Error('Archive format or content hash is invalid.');
  await writeExclusive(resolve(output, 'memory-archives', name), bytes);
  files.push({ path: `memory-archives/${name}`, bytes: bytes.length, sha256: digest(bytes) });
}
const archiveDir = await open(resolve(output, 'memory-archives'), 'r'); try { await archiveDir.sync(); } finally { await archiveDir.close(); }
const manifest = { format: 'agentos-runtime-bundle', version: 1, createdAt: new Date().toISOString(), files, collections: databaseReport.collections,
  limitations: ['Runtime must remain stopped during capture.', 'Local storage only; no chain verification.', 'Excludes JSON mode, Provider caches, browser journals and Session keys.'] };
await writeExclusive(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const dir = await open(output, 'r'); try { await dir.sync(); } finally { await dir.close(); }
console.log(JSON.stringify({ output, files: files.length, archiveCount: names.length, manifestSha256: digest(Buffer.from(JSON.stringify(manifest, null, 2))) }, null, 2));
