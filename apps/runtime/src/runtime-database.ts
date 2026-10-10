import { runtimeDataPath } from './data-path.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { address, getAddressEncoder } from '@solana/kit';

type Collection = 'worker-jobs' | 'escrow-handoffs' | 'verified-memory' | 'runtime-history';
const collections: Collection[] = ['worker-jobs', 'escrow-handoffs', 'verified-memory', 'runtime-history'];
const defaultPath = runtimeDataPath('agentos.sqlite');
const applicationId = 0x41474f53;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function runtimeStorageBackend(): 'json' | 'sqlite' {
  const value = process.env.AGENTOS_STORAGE_BACKEND?.trim() || 'json';
  if (value !== 'json' && value !== 'sqlite') throw new Error('AGENTOS_STORAGE_BACKEND must be json or sqlite.');
  return value;
}
let opening: Promise<RuntimeDatabase> | undefined;
export function runtimeDatabase(): Promise<RuntimeDatabase> {
  if (runtimeStorageBackend() !== 'sqlite') throw new Error('SQLite storage is not enabled.');
  opening ??= RuntimeDatabase.open();
  return opening;
}

/** Local single-process database. Does not contain signers or claim chain truth. */
export class RuntimeDatabase {
  private readonly revisions = new Map<Collection, number>();
  private closed = false;
  private constructor(private readonly db: DatabaseSync, private readonly ownerToken: string) {}
  static async open() {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('SQLite storage requires Node.js 24 or newer. JSON storage remains available.');
    const { DatabaseSync } = await import('node:sqlite');
    const file = resolve(process.env.AGENTOS_DATABASE_PATH?.trim() || defaultPath);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { const fd = openSync(file, 'wx', 0o600); closeSync(fd); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50_000_000) throw new Error('SQLite path must be a regular database file below 50 MB.');
    chmodSync(file, 0o600);
    const db = new DatabaseSync(file, { timeout: 1000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    const token = randomUUID();
    try {
      const app = Number(db.prepare('PRAGMA application_id').get()?.application_id);
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && app === 0 && tables.length === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE runtime_collections (name TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0)) STRICT;
          CREATE TABLE runtime_records (
            collection TEXT NOT NULL REFERENCES runtime_collections(name), program_id TEXT NOT NULL, record_id TEXT NOT NULL,
            body_json TEXT NOT NULL, body_sha256 TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(collection, program_id, record_id)
          ) STRICT;
          CREATE TABLE runtime_owner (id INTEGER PRIMARY KEY CHECK(id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL) STRICT;
          PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT;`);
      } else if (app !== applicationId || version !== 1) throw new Error('SQLite database application or schema version does not match AgentOS. Existing data preserved.');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE;');
      const old = db.prepare('SELECT token, pid, host FROM runtime_owner WHERE id=1').get();
      if (old) {
        if (old.host !== hostname() || typeof old.pid !== 'number' || !Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('Database owner belongs to another host or is invalid. Stop its Runtime before restoring a local copy.');
        let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('This database is already owned by a live Runtime process. Use one Runtime per database.');
      }
      db.prepare('INSERT INTO runtime_owner(id,token,pid,host) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,host=excluded.host').run(token, process.pid, hostname());
      db.exec('COMMIT');
      const storage = new RuntimeDatabase(db, token);
      process.once('exit', () => storage.close());
      return storage;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* No active transaction. */ }
      db.close(); throw error;
    }
  }
  private transaction<T>(run: () => T): T {
    if (this.closed) throw new Error('Runtime database is closed.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT token FROM runtime_owner WHERE id=1').get()?.token !== this.ownerToken) throw new Error('Runtime database ownership changed.');
      const result = run(); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private limit(collection: Collection) { return collection === 'verified-memory' ? 16_000_000 : collection === 'runtime-history' ? 8_000_000 : 2_000_000; }
  private rows(collection: Collection, values: unknown[]) {
    if (!Array.isArray(values) || values.length > 200 || Buffer.byteLength(JSON.stringify(values)) > this.limit(collection)) throw new Error(`Database collection exceeds its 200-record or ${this.limit(collection)}-byte limit.`);
    const ids = new Set<string>();
    return values.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid database record.');
      const item = value as { programId?: unknown; escrow?: unknown; execution?: unknown; id?: unknown };
      const recordId = collection === 'runtime-history' ? item.id : collection === 'verified-memory' ? item.execution : item.escrow;
      if (typeof item.programId !== 'string' || typeof recordId !== 'string') throw new Error('Database record needs a Program and collection-specific address key.');
      getAddressEncoder().encode(address(item.programId));
      if (collection === 'runtime-history') { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recordId)) throw new Error('Invalid history record ID.'); }
      else getAddressEncoder().encode(address(recordId));
      const key = `${item.programId}:${recordId}`;
      if (ids.has(key)) throw new Error('Duplicate database record.'); ids.add(key);
      const body = JSON.stringify(value);
      return { program: item.programId, id: recordId, body, hash: digest(body) };
    });
  }
  /** First migration is atomic, including empty collections. Caller validates legacy schema. */
  async restore(collection: Collection, legacy: () => Promise<unknown[]>): Promise<unknown[]> {
    if (!collections.includes(collection)) throw new Error('Unknown storage collection.');
    const exists = this.db.prepare('SELECT revision FROM runtime_collections WHERE name=?').get(collection);
    if (!exists) {
      const imported = this.rows(collection, await legacy());
      this.transaction(() => {
        if (this.db.prepare('SELECT revision FROM runtime_collections WHERE name=?').get(collection)) throw new Error('Collection migration raced another initialization.');
        this.db.prepare('INSERT INTO runtime_collections(name,revision) VALUES(?,0)').run(collection);
        const insert = this.db.prepare('INSERT INTO runtime_records(collection,program_id,record_id,body_json,body_sha256,updated_at) VALUES(?,?,?,?,?,?)');
        for (const item of imported) insert.run(collection, item.program, item.id, item.body, item.hash, new Date().toISOString());
      });
    }
    const revision = this.db.prepare('SELECT revision FROM runtime_collections WHERE name=?').get(collection)?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid database collection revision.');
    const rows = this.db.prepare('SELECT program_id,record_id,body_json,body_sha256 FROM runtime_records WHERE collection=? ORDER BY program_id,record_id LIMIT 201').all(collection);
    let size = 0;
    const values = rows.map(row => {
      if (typeof row.body_json !== 'string' || (size += Buffer.byteLength(row.body_json)) > this.limit(collection) || digest(row.body_json) !== row.body_sha256) throw new Error('Stored database record hash or size is invalid.');
      const item = JSON.parse(row.body_json);
      if (item?.programId !== row.program_id || (collection === 'runtime-history' ? item?.id : collection === 'verified-memory' ? item?.execution : item?.escrow) !== row.record_id) throw new Error('Stored database key differs from its body.');
      return item;
    });
    this.rows(collection, values); this.revisions.set(collection, revision); return values;
  }
  replace(collection: Collection, values: unknown[]) {
    const rows = this.rows(collection, values), expected = this.revisions.get(collection);
    if (expected === undefined) throw new Error('Restore the database collection before writing.');
    this.transaction(() => {
      const update = this.db.prepare('UPDATE runtime_collections SET revision=revision+1 WHERE name=? AND revision=?').run(collection, expected);
      if (update.changes !== 1) throw new Error('Database collection changed since restore. Restart Runtime before continuing.');
      this.db.prepare('DELETE FROM runtime_records WHERE collection=?').run(collection);
      const insert = this.db.prepare('INSERT INTO runtime_records(collection,program_id,record_id,body_json,body_sha256,updated_at) VALUES(?,?,?,?,?,?)');
      for (const item of rows) insert.run(collection, item.program, item.id, item.body, item.hash, new Date().toISOString());
    });
    this.revisions.set(collection, expected + 1);
  }
  close() {
    if (this.closed) return;
    try { this.db.prepare('DELETE FROM runtime_owner WHERE id=1 AND token=?').run(this.ownerToken); }
    finally { this.closed = true; this.db.close(); }
  }
}
