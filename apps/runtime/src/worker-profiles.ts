import * as z from 'zod/v4';
import { address, getPublicKeyFromAddress, verifySignature } from '@solana/kit';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { isValidSolanaAddress } from './memory.js';
const key = z.string().refine(isValidSolanaAddress);
const labels = z.array(z.string().min(1).max(60)).max(12);
const atomic = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n);
export const workerProfileSchema = z.object({ payload: z.object({ domain: z.literal('agentos-worker-profile-v1'),
  network: z.enum(['devnet', 'localnet']), programId: key, genesis: key, agent: key, owner: key,
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  profile: z.object({ description: z.string().max(2000), tags: labels, languages: labels, models: labels,
    availability: z.enum(['available', 'busy', 'offline']), minimumSol: atomic, minimumUsdc: atomic }).strict(),
}).strict(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type WorkerProfileChain = {programId:string;genesis:string;network:string};
const chainId=(chain:WorkerProfileChain)=>createHash('sha256').update(canonicalJson({programId:chain.programId,genesis:chain.genesis,network:chain.network})).digest('hex');
export type WorkerProfile = z.infer<typeof workerProfileSchema>;
export async function verifyWorkerProfile(input: unknown, agent: { address: string; owner: string }, chain: { programId: string; genesis: string; network: string }, now = Math.floor(Date.now() / 1000)) {
  const value = workerProfileSchema.parse(input), p = value.payload;
  if (p.agent !== agent.address || p.owner !== agent.owner || p.programId !== chain.programId || p.genesis !== chain.genesis || p.network !== chain.network ||
    Buffer.from(value.signature,'base64').toString('base64')!==value.signature || p.issuedAt > now || p.expiresAt <= now || p.expiresAt - p.issuedAt > 30 * 86400 || p.expiresAt <= p.issuedAt ||
    !await verifySignature(await getPublicKeyFromAddress(address(p.owner)), Buffer.from(value.signature, 'base64') as any, Buffer.from(canonicalJson(p))))
    throw new Error('Worker profile signature, Owner, network or validity period is invalid.');
  return value;
}
export class WorkerProfileEquivocationError extends Error {constructor(){super('Owner signed conflicting Worker profiles at the same issue time; profile quarantined until a newer signed version.');}}
export async function verifyWorkerProfileConflict(input:unknown,agent:{address:string;owner:string},chain:WorkerProfileChain,now=Math.floor(Date.now()/1000)){
 const pair=z.tuple([workerProfileSchema,workerProfileSchema]).parse(input),[a,b]=pair;
 if(a.payload.agent!==b.payload.agent||a.payload.owner!==b.payload.owner||a.payload.issuedAt!==b.payload.issuedAt||a.payload.issuedAt>now||a.payload.issuedAt+30*86400<=now||canonicalJson(a.payload)===canonicalJson(b.payload))throw new Error('Worker profile conflict proof is invalid or expired.');
 // Verify both claims at issue time. Evidence can outlive an individual claim's
 // expiry, but not the maximum 30-day profile validity horizon.
 await verifyWorkerProfile(a,agent,chain,a.payload.issuedAt);await verifyWorkerProfile(b,agent,chain,b.payload.issuedAt);return pair;
}
/** Public owner-signed profiles; atomic newer-version writes, no secret data. */
export class WorkerProfileStore {
  private readonly db: DatabaseSync;
  private readonly scope:string;
  constructor(file: string,chain:WorkerProfileChain) {
    this.scope=chainId(chain);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); try { closeSync(openSync(file, 'wx', 0o600)); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 400000000) throw new Error('Invalid Worker profile database.'); chmodSync(file, 0o600);
    this.db = new DatabaseSync(file, { timeout: 1000 });
    try {
      const app=this.db.prepare('PRAGMA application_id').get()?.application_id,version=this.db.prepare('PRAGMA user_version').get()?.user_version;
      const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if(app===0&&version===0&&!tables.length)this.db.exec('BEGIN IMMEDIATE;CREATE TABLE profiles(chain TEXT NOT NULL,agent TEXT NOT NULL,issued_at INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(chain,agent)) STRICT;PRAGMA application_id=1095190360;PRAGMA user_version=2;COMMIT;');
      else if(app!==1095190360||![1,2,3].includes(Number(version)))throw new Error('Profile database belongs to another application.');
      if(version===1){
        this.db.exec('BEGIN IMMEDIATE');try{
          this.db.exec('ALTER TABLE profiles RENAME TO profiles_v1;CREATE TABLE profiles(chain TEXT NOT NULL,agent TEXT NOT NULL,issued_at INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(chain,agent)) STRICT;');
          if(Number(this.db.prepare('SELECT COUNT(*) AS count FROM profiles_v1').get()?.count)>20000)throw new Error('Legacy profile store exceeds migration limit.');
          for(const row of this.db.prepare('SELECT agent,issued_at,body,hash FROM profiles_v1').all()){
            const profile=this.decode(row,String(row.agent));
            if(row.issued_at!==profile.payload.issuedAt)throw new Error('Stored profile version differs.');
            this.db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?)').run(chainId(profile.payload),profile.payload.agent,profile.payload.issuedAt,String(row.body),String(row.hash));
          }
          this.db.exec('DROP TABLE profiles_v1;PRAGMA user_version=2;COMMIT;');
        }catch(error){this.db.exec('ROLLBACK');throw error;}
      }
      if(Number(this.db.prepare('PRAGMA user_version').get()?.user_version)===2)this.db.exec('BEGIN IMMEDIATE;CREATE TABLE profile_conflicts(chain TEXT NOT NULL,agent TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(chain,agent),FOREIGN KEY(chain,agent) REFERENCES profiles(chain,agent)) STRICT;PRAGMA user_version=3;COMMIT;');
      this.db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA trusted_schema=OFF;');
    }catch(error){this.db.close();throw error;}
  }
  private decode(row:Record<string,unknown>,agent:string):WorkerProfile {
    if(typeof row.body!=='string'||Buffer.byteLength(row.body)>16000||createHash('sha256').update(row.body).digest('hex')!==row.hash)throw new Error('Worker profile is corrupt.');
    const value=workerProfileSchema.parse(JSON.parse(row.body));if(value.payload.agent!==agent)throw new Error('Worker profile identity differs.');return value;
  }
  loadRecords():{profile:WorkerProfile;conflict:WorkerProfile|null}[]{
    const rows=this.db.prepare('SELECT p.agent,p.body,p.hash,c.body AS conflict_body,c.hash AS conflict_hash FROM profiles p LEFT JOIN profile_conflicts c ON c.chain=p.chain AND c.agent=p.agent WHERE p.chain=? ORDER BY p.agent LIMIT 20001').all(this.scope);
    if(rows.length>20000)throw new Error('Worker profile store exceeds its limit.');
    return rows.map(row=>this.record(row));
  }
  private record(row:Record<string,unknown>){
    const profile=this.decode(row,String(row.agent));if(chainId(profile.payload)!==this.scope)throw new Error('Worker profile chain differs.');
    const conflict=row.conflict_body===null?null:this.decode({body:row.conflict_body,hash:row.conflict_hash},String(row.agent));
    if(conflict&&(chainId(conflict.payload)!==this.scope||conflict.payload.owner!==profile.payload.owner||conflict.payload.issuedAt!==profile.payload.issuedAt||canonicalJson(conflict.payload)===canonicalJson(profile.payload)))throw new Error('Worker profile conflict proof is corrupt.');
    return {profile,conflict};
  }
  private loadRecord(agent:string){
    const row=this.db.prepare('SELECT p.agent,p.body,p.hash,c.body AS conflict_body,c.hash AS conflict_hash FROM profiles p LEFT JOIN profile_conflicts c ON c.chain=p.chain AND c.agent=p.agent WHERE p.chain=? AND p.agent=?').get(this.scope,agent);
    return row?this.record(row):null;
  }
  load(agent:string):WorkerProfile|null{const record=this.loadRecord(agent);if(record?.conflict)throw new WorkerProfileEquivocationError();return record?.profile??null;}
  loadAll():WorkerProfile[]{return this.loadRecords().flatMap(row=>row.conflict?[]:[row.profile]);}
  saveVerified(input:WorkerProfile):boolean {
    const value=workerProfileSchema.parse(input);if(chainId(value.payload)!==this.scope)throw new Error('Worker profile belongs to another chain scope.');
    const body=canonicalJson(value);if(Buffer.byteLength(body)>16000)throw new Error('Profile exceeds 16 KB.');
    this.db.exec('BEGIN IMMEDIATE');let committed=false;try{
      const record=this.loadRecord(value.payload.agent),old=record?.profile;
      if(old&&value.payload.issuedAt===old.payload.issuedAt){
        if(!record!.conflict&&canonicalJson(old.payload)===canonicalJson(value.payload)){this.db.exec('COMMIT');return false;}
        if(old.payload.owner!==value.payload.owner)throw new Error('Conflicting versions have different Owners.');
        if(!record!.conflict)this.db.prepare('INSERT INTO profile_conflicts(chain,agent,body,hash) VALUES(?,?,?,?)').run(this.scope,value.payload.agent,body,createHash('sha256').update(body).digest('hex'));
        this.db.exec('COMMIT');committed=true;throw new WorkerProfileEquivocationError();
      }
      if(old&&value.payload.issuedAt<old.payload.issuedAt)throw new Error('A signed profile update must be newer than the existing version.');
      if(!old&&Number(this.db.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count)>=20000)throw new Error('Worker profile store is full.');
      this.db.prepare('DELETE FROM profile_conflicts WHERE chain=? AND agent=?').run(this.scope,value.payload.agent);
      this.db.prepare('INSERT INTO profiles(chain,agent,issued_at,body,hash) VALUES(?,?,?,?,?) ON CONFLICT(chain,agent) DO UPDATE SET issued_at=excluded.issued_at,body=excluded.body,hash=excluded.hash').run(this.scope,value.payload.agent,value.payload.issuedAt,body,createHash('sha256').update(body).digest('hex'));
      this.db.exec('COMMIT');return true;
    }catch(error){if(!committed)this.db.exec('ROLLBACK');throw error;}
  }
  /** Commit an already verified proof pair without exposing its first claim
   * between two separate transactions to another local reader process. */
  saveVerifiedConflict(input:[WorkerProfile,WorkerProfile]):boolean {
    const [a,b]=z.tuple([workerProfileSchema,workerProfileSchema]).parse(input);
    if(chainId(a.payload)!==this.scope||chainId(b.payload)!==this.scope||a.payload.agent!==b.payload.agent||a.payload.owner!==b.payload.owner||a.payload.issuedAt!==b.payload.issuedAt||canonicalJson(a.payload)===canonicalJson(b.payload))throw new Error('Worker profile conflict identity differs.');
    const bodies=[canonicalJson(a),canonicalJson(b)];if(bodies.some(body=>Buffer.byteLength(body)>16000))throw new Error('Profile exceeds 16 KB.');
    this.db.exec('BEGIN IMMEDIATE');try{
      const old=this.loadRecord(a.payload.agent);
      if(old&&old.profile.payload.issuedAt>a.payload.issuedAt){this.db.exec('COMMIT');return false;}
      if(old&&old.profile.payload.issuedAt===a.payload.issuedAt){
        if(old.profile.payload.owner!==a.payload.owner)throw new Error('Conflicting versions have different Owners.');
        if(old.conflict){this.db.exec('COMMIT');return false;}
        const witness=canonicalJson(old.profile.payload)===canonicalJson(a.payload)?b:a,body=canonicalJson(witness);
        this.db.prepare('INSERT INTO profile_conflicts(chain,agent,body,hash) VALUES(?,?,?,?)').run(this.scope,a.payload.agent,body,createHash('sha256').update(body).digest('hex'));
      }else{
        if(!old&&Number(this.db.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count)>=20000)throw new Error('Worker profile store is full.');
        this.db.prepare('DELETE FROM profile_conflicts WHERE chain=? AND agent=?').run(this.scope,a.payload.agent);
        this.db.prepare('INSERT INTO profiles(chain,agent,issued_at,body,hash) VALUES(?,?,?,?,?) ON CONFLICT(chain,agent) DO UPDATE SET issued_at=excluded.issued_at,body=excluded.body,hash=excluded.hash').run(this.scope,a.payload.agent,a.payload.issuedAt,bodies[0],createHash('sha256').update(bodies[0]).digest('hex'));
        this.db.prepare('INSERT INTO profile_conflicts(chain,agent,body,hash) VALUES(?,?,?,?)').run(this.scope,a.payload.agent,bodies[1],createHash('sha256').update(bodies[1]).digest('hex'));
      }
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close() { this.db.close(); }
}
