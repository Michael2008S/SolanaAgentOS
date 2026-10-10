import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import type { AutonomousTenant } from './autonomous-controller.js';
import { canonicalJson } from './canonical-json.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const text=(length:number)=>z.string().trim().min(1).max(length).refine(s=>!/[\x00-\x1f\x7f]/.test(s));
export const tenantCredentialChange=z.object({tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),state:z.enum(['active','revoked']),tokenSha256:hash.optional(),expiresAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),actor:text(80),reason:text(240)}).strict();
type Change=z.infer<typeof tenantCredentialChange>;
type Row={tenant:string;scope_hash:string;token_hash:string;state:'active'|'revoked';expires_at:number|null;revision:number};
/** Operator-controlled access credentials only. This cannot widen signing scope,
 * stop accepted background jobs, grant a Session or change an on-chain budget. */
export class TenantCredentialRegistry {
 private readonly db:DatabaseSync;
 constructor(path:string,private readonly now=()=>Date.now(),existingOnly=false){
  if(existingOnly&&!existsSync(path))throw new Error('Credential registry must already exist.');
  const created=!existsSync(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);
  try{
   if(created)chmodSync(path,0o600);
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
   if(tables.some(t=>!['credential_tenants','credential_tokens','credential_audit'].includes(String(t.name))))throw new Error('Use a dedicated credential database.');
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS credential_tenants(tenant TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','revoked')),expires_at INTEGER,revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
    CREATE TABLE IF NOT EXISTS credential_tokens(token_hash TEXT PRIMARY KEY,tenant TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS credential_audit(tenant TEXT NOT NULL,revision INTEGER NOT NULL,scope_hash TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER,actor TEXT NOT NULL,reason TEXT NOT NULL,rotated INTEGER NOT NULL,changed_at TEXT NOT NULL,PRIMARY KEY(tenant,revision)) STRICT;`);
  }catch(cause){this.db.close();throw cause;}
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(cause){this.db.exec('ROLLBACK');throw cause;}}
 private row(tenant:string):Row{const r=this.db.prepare('SELECT * FROM credential_tenants WHERE tenant=?').get(tenant);if(!r)throw new Error('Tenant is not registered.');return z.object({tenant:z.string(),scope_hash:hash,token_hash:hash,state:z.enum(['active','revoked']),expires_at:z.number().int().positive().nullable(),revision:z.number().int().nonnegative()}).strict().parse(r);}
 seed(tenants:AutonomousTenant[],chain:{program:string;genesis:string}){
  this.transaction(()=>{for(const tenant of tenants){
   const {tokenSha256,...scope}=tenant,scopeHash=createHash('sha256').update(canonicalJson({...scope,...chain})).digest('hex');
   const exists=this.db.prepare('SELECT tenant FROM credential_tenants WHERE tenant=?').get(tenant.tenant);
   if(exists){if(this.row(tenant.tenant).scope_hash!==scopeHash)throw new Error('Registered tenant authority cannot change through credential configuration.');continue;}
   if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM credential_tenants').get()!.n)>=100)throw new Error('Credential registry is full.');
   if(this.db.prepare('SELECT tenant FROM credential_tokens WHERE token_hash=?').get(tokenSha256))throw new Error('A credential hash cannot be reused.');
   this.db.prepare('INSERT INTO credential_tokens VALUES(?,?)').run(tokenSha256,tenant.tenant);
   this.db.prepare("INSERT INTO credential_tenants VALUES(?,?,?,'active',NULL,0)").run(tenant.tenant,scopeHash,tokenSha256);
   this.audit({tenant:tenant.tenant,scope_hash:scopeHash,token_hash:tokenSha256,state:'active',expires_at:null,revision:0},'runtime-bootstrap','Configured initial credential',false);
  }});
 }
 authenticate(digest:Buffer):string|null{
  if(digest.length!==32)return null;
  const found=this.db.prepare('SELECT tenant FROM credential_tenants WHERE token_hash=?').get(digest.toString('hex'));if(!found)return null;
  const r=this.row(String(found.tenant));return r.state==='active'&&(r.expires_at===null||r.expires_at>Math.floor(this.now()/1000))?r.tenant:null;
 }
 snapshot(tenant:string){const r=this.row(tenant);return {tenant:r.tenant,revision:r.revision,state:r.state,expiresAt:r.expires_at,scopeHash:r.scope_hash};}
 private audit(r:Row,actor:string,reason:string,rotated:boolean){this.db.prepare('INSERT INTO credential_audit VALUES(?,?,?,?,?,?,?,?,?)').run(r.tenant,r.revision,r.scope_hash,r.state,r.expires_at,actor,reason,rotated?1:0,new Date(this.now()).toISOString());}
 change(raw:Change){const c=tenantCredentialChange.parse(raw);return this.transaction(()=>{
  const previous=this.row(c.tenant);if(previous.revision!==c.expectedRevision)throw new Error('Credential revision changed; review the current revision.');
  const expires=c.expiresAt===undefined?previous.expires_at:c.expiresAt,token=c.tokenSha256??previous.token_hash,rotated=token!==previous.token_hash;
  if(c.state==='active'&&expires!==null&&expires<=Math.floor(this.now()/1000))throw new Error('Active credentials must expire in the future.');
  if(c.state==='active'&&(previous.state==='revoked'||previous.expires_at!==null&&previous.expires_at<=Math.floor(this.now()/1000))&&!rotated)throw new Error('Restore requires a fresh credential hash.');
  if(rotated){if(this.db.prepare('SELECT tenant FROM credential_tokens WHERE token_hash=?').get(token))throw new Error('A credential hash cannot be reused.');this.db.prepare('INSERT INTO credential_tokens VALUES(?,?)').run(token,c.tenant);}
  if(previous.state===c.state&&previous.expires_at===expires&&!rotated)throw new Error('Credential change has no effect.');
  const next={...previous,state:c.state,expires_at:expires,token_hash:token,revision:previous.revision+1};
  this.db.prepare('UPDATE credential_tenants SET token_hash=?,state=?,expires_at=?,revision=? WHERE tenant=? AND revision=?').run(token,c.state,expires,next.revision,c.tenant,c.expectedRevision);
  this.audit(next,c.actor,c.reason,rotated);return this.snapshot(c.tenant);
 });}
 history(tenant:string,afterRevision=-1){if(!Number.isSafeInteger(afterRevision)||afterRevision< -1)throw new Error('Invalid audit cursor.');this.row(tenant);return this.db.prepare('SELECT tenant,revision,scope_hash AS scopeHash,state,expires_at AS expiresAt,actor,reason,rotated,changed_at AS changedAt FROM credential_audit WHERE tenant=? AND revision>? ORDER BY revision LIMIT 100').all(tenant,afterRevision);}
 close(){this.db.close();}
}
