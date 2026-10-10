import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

// Online SQLite snapshot only. Never executes jobs, calls models or opens signer files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { loadEnvFile(resolve(root, 'apps/runtime/.env')); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
  return args[index + 1];
};
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('SQLite backup requires Node.js 24 or newer.');
const { DatabaseSync, backup } = await import('node:sqlite');
const source = resolve(option('--database') ?? (process.env.AGENTOS_DATABASE_PATH?.trim() || resolve(root, 'apps/runtime/.data/agentos.sqlite')));
const destination = resolve(option('--output') ?? resolve(root, `apps/runtime/.data/backups/agentos-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
if (source === destination) throw new Error('Backup destination must differ from its source.');
const stat = await lstat(source);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50_000_000) throw new Error('Source must be a regular AgentOS database below 50 MB.');
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const temporary = `${destination}.${randomUUID()}.tmp`;
const reservation = await open(temporary, 'wx', 0o600); await reservation.close();
let original, copy;
try {
  original = new DatabaseSync(source, { readOnly: true, timeout: 1000 });
  if (original.prepare('PRAGMA application_id').get()?.application_id !== 0x41474f53 || original.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Source is not an AgentOS schema v1 database.');
  await backup(original, temporary);
  original.close(); original = undefined;
  copy = new DatabaseSync(temporary, { timeout: 1000 });
  const integrity = copy.prepare('PRAGMA quick_check').all();
  if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('Backup integrity check failed.');
  // A backup is an offline copy, not permission to run the source process twice.
  copy.exec('DELETE FROM runtime_owner; PRAGMA journal_mode=DELETE;');
  const counts = copy.prepare('SELECT collection,COUNT(*) AS count FROM runtime_records GROUP BY collection ORDER BY collection').all();
  copy.close(); copy = undefined;
  const bytes = await readFile(temporary);
  if (bytes.byteLength > 50_000_000) throw new Error('Backup exceeds the file size limit.');
  await link(temporary, destination); // Fails if a destination already exists.
  console.log(JSON.stringify({ format: 'agentos-runtime-backup', version: 1, output: destination, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), collections: counts, limitation: 'Restore with Runtime stopped. This snapshot is local storage, not chain or model execution proof.' }, null, 2));
} finally {
  copy?.close(); original?.close();
  await rm(temporary, { force: true });
  await rm(`${temporary}-wal`, { force: true }); await rm(`${temporary}-shm`, { force: true });
}
