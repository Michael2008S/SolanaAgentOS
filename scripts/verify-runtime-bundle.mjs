import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input') throw new Error('Use --input /absolute/path/to/bundle.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Bundle verification requires Node.js 24+.');
const root = resolve(args[1]);
const directory = await lstat(root);
if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Bundle must be a regular directory.');
const digest = value => createHash('sha256').update(value).digest('hex');
async function readRegular(path, limit) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Bundle file type or size is invalid.');
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error('Bundle changed while reading.');
  return bytes;
}
const manifestBytes = await readRegular(resolve(root, 'manifest.json'), 3000000);
const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
if (manifest?.format !== 'agentos-runtime-bundle' || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 10001 || !Array.isArray(manifest.collections)) throw new Error('Invalid manifest.');
const expected = new Set(); let total = 0;
for (const item of manifest.files) {
  if (!item || typeof item.path !== 'string' || !(item.path === 'agentos.sqlite' || /^memory-archives\/[1-9A-HJ-NP-Za-km-z]{32,44}-[a-f0-9-]{36}\.json$/.test(item.path)) || expected.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid or duplicated file entry.');
  expected.add(item.path);
  const bytes = await readRegular(resolve(root, item.path), item.path === 'agentos.sqlite' ? 50000000 : 400000);
  total += bytes.length;
  if (total > 200000000 || bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error(`File hash or size mismatch: ${item.path}`);
  if (item.path !== 'agentos.sqlite') {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (body?.format !== 'agentos-memory-archive' || body.version !== 1 || body.network !== 'devnet-preview' || body.verification !== 'storage-hashes-only' || typeof body.entry?.content !== 'string' || digest(Buffer.from(body.entry.content)) !== body.entry.contentHash) throw new Error('Archived content hash or format is invalid.');
  }
}
if (!expected.has('agentos.sqlite')) throw new Error('Database is missing from manifest.');
const archiveStat = await lstat(resolve(root, 'memory-archives'));
if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) throw new Error('Archive directory is invalid.');
const top = await readdir(root), archives = await readdir(resolve(root, 'memory-archives'));
if (top.some(name => !['manifest.json', 'agentos.sqlite', 'memory-archives'].includes(name)) || archives.some(name => !expected.has(`memory-archives/${name}`)) || expected.size !== archives.length + 1) throw new Error('Bundle contains unlisted or missing files.');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(resolve(root, 'agentos.sqlite'), { readOnly: true });
try {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x41474f53 || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Wrong database application or version.');
  const integrity = db.prepare('PRAGMA quick_check').all();
  if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' || db.prepare('SELECT id FROM runtime_owner').get()) throw new Error('Database integrity or offline ownership is invalid.');
  const counts = db.prepare('SELECT collection,COUNT(*) AS count FROM runtime_records GROUP BY collection ORDER BY collection').all();
  if (JSON.stringify(counts) !== JSON.stringify(manifest.collections)) throw new Error('Database collection counts differ from manifest.');
  for (const row of db.prepare('SELECT body_json,body_sha256 FROM runtime_records').iterate()) {
    if (typeof row.body_json !== 'string' || digest(Buffer.from(row.body_json)) !== row.body_sha256) throw new Error('Database record storage hash is invalid.');
  }
} finally { db.close(); }
console.log(JSON.stringify({ format: 'agentos-runtime-bundle-verification', version: 1, input: root, files: expected.size, bytes: total, manifestSha256: digest(manifestBytes), storageIntegrity: 'verified', limitations: ['Hashes are not signatures or chain proofs.', 'Application record schemas and live Execution bindings are checked again during Runtime restore/use.', 'No data restored or overwritten.'] }, null, 2));
