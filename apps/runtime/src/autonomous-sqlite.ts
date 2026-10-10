import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as z from 'zod/v4';
import { parseAutonomousJob, type AutonomousJob, type AutonomousStore } from './autonomous-loop.js';
import { notificationState,notificationEvent,type NotificationClaim } from './autonomous-notification-types.js';
import { cancellationRequest,cancellationAudit,cancellationResult,operatorScopeHash } from './autonomous-operator.js';
import { canonicalJson as canonicalCancellation } from './canonical-json.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (tenant: string, id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenant) || !z.string().uuid().safeParse(id).success) throw new Error('Invalid autonomous identity.');
};
export class AutonomousLeaseBusyError extends Error {
  constructor(message='Autonomous Agent is already running.'){super(message);this.name='AutonomousLeaseBusyError';}
}
const agentScope=(job:AutonomousJob)=>JSON.stringify([job.program,job.genesis,job.agent]);
/** No elapsed-time lease stealing: paused/signing processes still own their effects. */
function requireDeadOwner(row:Record<string,unknown>){
  if(row.host!==hostname()||typeof row.pid!=='number'||!Number.isSafeInteger(row.pid)||row.pid<=0)throw new Error('Autonomous lease belongs to another host or has invalid ownership.');
  try{process.kill(row.pid,0);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ESRCH')return;}
  throw new AutonomousLeaseBusyError();
}
/** One central host, many authenticated devices and local processes. Leases
 * are fenced on every write and reclaimed only from proven dead local PIDs.
 * This is not a distributed database: use a central API, not an NFS database. */
export class SQLiteAutonomousStore implements AutonomousStore {
  private readonly db: DatabaseSync;
  private readonly leases = new Map<string, string>();
  private readonly notificationLeases=new Set<string>();
  constructor(file: string,private readonly notificationDestinations:ReadonlyMap<string,string>=new Map()) {
    if(notificationDestinations.size>100)throw new Error('Too many notification destinations.');
    for(const [tenant,hash] of notificationDestinations){identity(tenant,randomUUID());if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid notification destination identity.');}
    file = resolve(file); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { const fd = openSync(file, 'wx', 0o600); closeSync(fd); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000_000) throw new Error('Invalid autonomous database file.');
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file, { timeout: 1000 });
    try {
      const application = this.db.prepare('PRAGMA application_id').get()?.application_id;
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (application === 0 && version === 0 && !tables.length) {
        this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE jobs (
          tenant TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
          token TEXT, pid INTEGER, host TEXT, cancelled INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(tenant,id)
        ) STRICT; PRAGMA application_id=1095188812; PRAGMA user_version=1; COMMIT;`);
      } else if (application !== 1095188812 || version !== 1) throw new Error('Autonomous database schema does not match.');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_leases (
        scope TEXT PRIMARY KEY, tenant TEXT NOT NULL, job_id TEXT NOT NULL,
        token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL
      ) STRICT;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS operator_cancellations(operation_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,UNIQUE(tenant,job_id)) STRICT;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER NOT NULL, tenant TEXT NOT NULL, job_id TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant,sequence)
      ) STRICT; CREATE INDEX IF NOT EXISTS events_tenant_sequence ON events(tenant,sequence);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, hash TEXT NOT NULL, destination_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
        delivered_at INTEGER, failure TEXT, token TEXT, pid INTEGER, host TEXT,
        UNIQUE(tenant,job_id,state)
      ) STRICT; CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status,next_attempt);`);
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async load(tenant: string, id: string): Promise<AutonomousJob> {
    identity(tenant,id);
    const row = this.db.prepare('SELECT body,hash FROM jobs WHERE tenant=? AND id=?').get(tenant,id);
    if (!row || typeof row.body !== 'string' || Buffer.byteLength(row.body) > 8_000_000 || sha(row.body) !== row.hash) throw new Error('Autonomous job missing or corrupt.');
    const job = parseAutonomousJob(JSON.parse(row.body));
    if (job.id !== id || job.tenant !== tenant) throw new Error('Stored autonomous identity differs.');
    return job;
  }
  async save(value: AutonomousJob): Promise<void> {
    const job = parseAutonomousJob(value), body = JSON.stringify(job), key = job.tenant + ':' + job.id;
    if (Buffer.byteLength(body) > 8_000_000) throw new Error('Autonomous job exceeds storage limit.');
    this.transaction(() => {
      const row = this.db.prepare('SELECT token,hash,body FROM jobs WHERE tenant=? AND id=?').get(job.tenant,job.id);
      if (!row) {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE tenant=?').get(job.tenant)?.count;
        if (typeof count !== 'number' || count >= 200) throw new Error('Autonomous tenant storage is full.');
        this.db.prepare('INSERT INTO jobs(tenant,id,body,hash) VALUES(?,?,?,?)').run(job.tenant,job.id,body,sha(body));
      } else {
        if(typeof row.body!=='string'||sha(row.body)!==row.hash)throw new Error('Stored autonomous job is corrupt.');
        const previous=parseAutonomousJob(JSON.parse(row.body));
        for(const field of ['agent','session','program','genesis','limits','acceptance','evaluationMode'] as const)
          if(JSON.stringify(previous[field])!==JSON.stringify(job[field]))throw new Error('Original autonomous identity, budget, completion checks or evaluation mode cannot change.');
        const token = this.leases.get(key);
        const agentLease=this.db.prepare('SELECT token,tenant,job_id FROM agent_leases WHERE scope=?').get(agentScope(job));
        if (!token || row.token !== token||agentLease?.token!==token||agentLease.tenant!==job.tenant||agentLease.job_id!==job.id) throw new Error('Autonomous write requires its current lease for both job and Agent.');
        if(job.modelRequests>previous.modelRequests||job.intents.some(intent=>!previous.intents.some(old=>old.id===intent.id))){
          const others=this.db.prepare(`SELECT body,hash FROM jobs WHERE NOT(tenant=? AND id=?)
            AND json_extract(body,'$.program')=? AND json_extract(body,'$.genesis')=? AND json_extract(body,'$.agent')=?`).all(job.tenant,job.id,job.program,job.genesis,job.agent);
          for(const other of others){
            if(typeof other.body!=='string'||Buffer.byteLength(other.body)>8_000_000||sha(other.body)!==other.hash)throw new Error('Stored autonomous job is corrupt.');
            if(parseAutonomousJob(JSON.parse(other.body)).intents.some(intent=>intent.phase==='reserved'))throw new AutonomousLeaseBusyError('Original Agent effects require reconciliation before new model or execution reservations.');
          }
        }
        this.db.prepare('UPDATE jobs SET body=?,hash=? WHERE tenant=? AND id=? AND token=?').run(body,sha(body),job.tenant,job.id,token);
      }
      if(!row||row.hash!==sha(body))this.db.prepare('INSERT INTO events(sequence,tenant,job_id,body,created_at) VALUES(COALESCE((SELECT MAX(sequence)+1 FROM events WHERE tenant=?),1),?,?,?,?)').run(job.tenant,job.tenant,job.id,
        JSON.stringify({state:job.state,cycle:job.cycle,modelRequests:job.modelRequests,actions:job.intents.length,spent:job.spent}),new Date().toISOString());
      this.db.prepare('DELETE FROM events WHERE tenant=? AND sequence NOT IN (SELECT sequence FROM events WHERE tenant=? ORDER BY sequence DESC LIMIT 10000)').run(job.tenant,job.tenant);
      const destination=this.notificationDestinations.get(job.tenant);
      if(destination&&notificationState.safeParse(job.state).success){
        const event=notificationEvent.parse({version:1,id:randomUUID(),tenant:job.tenant,jobId:job.id,state:job.state,cycle:job.cycle,actions:job.intents.length,spent:job.spent,createdAt:new Date().toISOString()}),body=JSON.stringify(event);
        // Job checkpoint and outbox commit together. One event per job/state:
        // reconciliation polling never floods a receiver or grows storage forever.
        this.db.prepare('INSERT OR IGNORE INTO notifications(id,tenant,job_id,state,body,hash,destination_hash,next_attempt) VALUES(?,?,?,?,?,?,?,?)').run(event.id,event.tenant,event.jobId,event.state,body,sha(body),destination,Date.now());
      }
    });
  }
  async list(tenant: string): Promise<AutonomousJob[]> {
    identity(tenant,randomUUID());
    const rows = this.db.prepare('SELECT id FROM jobs WHERE tenant=? ORDER BY id LIMIT 201').all(tenant);
    if (rows.length > 200) throw new Error('Autonomous tenant storage is full.');
    return Promise.all(rows.map(row => this.load(tenant,String(row.id))));
  }
  async events(tenant:string,after=0){
    identity(tenant,randomUUID());if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid notification cursor.');
    const oldest=this.db.prepare('SELECT MIN(sequence) AS sequence FROM events WHERE tenant=?').get(tenant)?.sequence;
    const rows=this.db.prepare('SELECT sequence,job_id,body,created_at FROM events WHERE tenant=? AND sequence>? ORDER BY sequence LIMIT 100').all(tenant,after);
    return {events:rows.map(row=>({sequence:Number(row.sequence),jobId:String(row.job_id),...JSON.parse(String(row.body)),createdAt:String(row.created_at)})),
      cursor:rows.length?Number(rows[rows.length-1].sequence):after,retentionGap:after>0&&typeof oldest==='number'&&after<oldest-1};
  }
  async acquire(tenant: string,id: string): Promise<()=>Promise<void>> {
    identity(tenant,id); const key=tenant+':'+id, token=randomUUID();let scope='';
    this.transaction(() => {
      const row=this.db.prepare('SELECT token,pid,host,body,hash FROM jobs WHERE tenant=? AND id=?').get(tenant,id);
      if(!row||typeof row.body!=='string'||Buffer.byteLength(row.body)>8_000_000||sha(row.body)!==row.hash)throw new Error('Autonomous job missing or corrupt.');
      const job=parseAutonomousJob(JSON.parse(row.body));if(job.tenant!==tenant||job.id!==id)throw new Error('Stored autonomous identity differs.');scope=agentScope(job);
      if(row.token!==null)requireDeadOwner(row);
      const owner=this.db.prepare('SELECT token,pid,host FROM agent_leases WHERE scope=?').get(scope);
      if(owner)requireDeadOwner(owner);
      // Allow original reconciliation of older simultaneous reservations, but
      // save() fences all new model/action reservations until the others clear.
      // Also respect live job leases created before the Agent-fence migration.
      // Mixed old/new versions must not run together: old writers lack this fence.
      const others=this.db.prepare(`SELECT token,pid,host,body,hash FROM jobs WHERE NOT(tenant=? AND id=?)
        AND json_extract(body,'$.program')=? AND json_extract(body,'$.genesis')=? AND json_extract(body,'$.agent')=?`).all(tenant,id,job.program,job.genesis,job.agent);
      for(const candidate of others){
        if(typeof candidate.body!=='string'||Buffer.byteLength(candidate.body)>8_000_000||sha(candidate.body)!==candidate.hash)throw new Error('Stored autonomous job is corrupt.');
        const previous=parseAutonomousJob(JSON.parse(candidate.body));
        if(candidate.token!==null)requireDeadOwner(candidate);
        // Releasing a process lease does not resolve a reserved external effect.
        // Preserve the original Agent counter until that original intent reconciles.
        if(previous.intents.some(intent=>intent.phase==='reserved')&&!job.intents.some(intent=>intent.phase==='reserved'))throw new AutonomousLeaseBusyError('Original Agent effects require reconciliation before another job can run.');
      }
      this.db.prepare('UPDATE jobs SET token=?,pid=?,host=? WHERE tenant=? AND id=?').run(token,process.pid,hostname(),tenant,id);
      this.db.prepare(`INSERT INTO agent_leases(scope,tenant,job_id,token,pid,host) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET tenant=excluded.tenant,job_id=excluded.job_id,token=excluded.token,pid=excluded.pid,host=excluded.host`).run(scope,tenant,id,token,process.pid,hostname());
    });
    this.leases.set(key,token);
    return async()=>{this.transaction(()=>{
      const agentReleased=this.db.prepare('DELETE FROM agent_leases WHERE scope=? AND tenant=? AND job_id=? AND token=?').run(scope,tenant,id,token);
      const jobReleased=this.db.prepare('UPDATE jobs SET token=NULL,pid=NULL,host=NULL WHERE tenant=? AND id=? AND token=?').run(tenant,id,token);
      if(agentReleased.changes!==1||jobReleased.changes!==1)throw new Error('Autonomous job or Agent lease ownership changed.');
    });if(this.leases.get(key)===token)this.leases.delete(key);};
  }
  async requestCancellation(tenant:string,id:string){identity(tenant,id);const changed=this.db.prepare('UPDATE jobs SET cancelled=1 WHERE tenant=? AND id=?').run(tenant,id);if(changed.changes!==1)throw new Error('Autonomous job missing.');}
  async reviewedCancellation(input:unknown){
    const request=cancellationRequest.parse(input);
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT body,hash FROM operator_cancellations WHERE operation_id=?').get(request.operationId);
      if(previous){const audit=this.decodeCancellation(previous);if(canonicalCancellation(audit.request)!==canonicalCancellation(request))throw new Error('Original operator cancellation cannot change.');return cancellationResult.parse({audit,idempotent:true,cancellationRequested:true,onChainAuthorityChanged:false});}
      if(this.db.prepare('SELECT operation_id FROM operator_cancellations WHERE tenant=? AND job_id=?').get(request.tenant,request.id))throw new Error('This job already has an audited cancellation; inspect its original audit.');
      const row=this.db.prepare('SELECT body,hash,cancelled FROM jobs WHERE tenant=? AND id=?').get(request.tenant,request.id);
      if(!row||typeof row.body!=='string'||Buffer.byteLength(row.body)>8_000_000||sha(row.body)!==row.hash)throw new Error('Autonomous job missing or corrupt.');
      const job=parseAutonomousJob(JSON.parse(row.body));
      if(job.tenant!==request.tenant||job.id!==request.id||operatorScopeHash(job)!==request.scopeHash)throw new Error('Reviewed cancellation differs from the immutable original job scope.');
      if(['completed','failed','cancelled'].includes(job.state))throw new Error('Original job is already terminal; no operator cancellation was recorded.');
      if(Number(this.db.prepare('SELECT COUNT(*) AS count FROM operator_cancellations').get()?.count)>=20000)throw new Error('Operator cancellation audit is full.');
      const audit=cancellationAudit.parse({request,checkpointHash:sha(row.body),stateBefore:job.state,requestedAt:Date.now(),originalReservedEffects:job.intents.filter(item=>item.phase==='reserved').length,alreadyRequested:row.cancelled===1}),body=JSON.stringify(audit);
      this.db.prepare('UPDATE jobs SET cancelled=1 WHERE tenant=? AND id=?').run(job.tenant,job.id);
      this.db.prepare('INSERT INTO operator_cancellations VALUES(?,?,?,?,?)').run(request.operationId,job.tenant,job.id,body,sha(body));
      return cancellationResult.parse({audit,idempotent:false,cancellationRequested:true,onChainAuthorityChanged:false});
    });
  }
  private decodeCancellation(row:Record<string,unknown>){if(typeof row.body!=='string'||Buffer.byteLength(row.body)>16000||sha(row.body)!==row.hash)throw new Error('Operator cancellation audit is corrupt.');return cancellationAudit.parse(JSON.parse(row.body));}
  async cancellationHistory(tenant:string,id:string){identity(tenant,id);const row=this.db.prepare('SELECT body,hash FROM operator_cancellations WHERE tenant=? AND job_id=?').get(tenant,id);if(!row)return null;const audit=this.decodeCancellation(row);if(audit.request.tenant!==tenant||audit.request.id!==id)throw new Error('Operator audit identity differs.');return audit;}
  async cancelled(tenant:string,id:string){identity(tenant,id);return this.db.prepare('SELECT cancelled FROM jobs WHERE tenant=? AND id=?').get(tenant,id)?.cancelled===1;}
  async claimNotification(now=Date.now()):Promise<NotificationClaim|null>{
    if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid notification clock.');
    const claim=this.transaction(()=>{
      if(!this.notificationDestinations.size)return null;
      const scopes=[...this.notificationDestinations],where=scopes.map(()=>'(tenant=? AND destination_hash=?)').join(' OR ');
      const rows=this.db.prepare("SELECT * FROM notifications WHERE status='pending' AND next_attempt<=? AND ("+where+") ORDER BY next_attempt,id LIMIT 1000").all(now,...scopes.flat());
      for(const row of rows){
        const tenant=String(row.tenant);if(this.notificationDestinations.get(tenant)!==row.destination_hash)continue;
        if(row.token!==null){
          if(row.host!==hostname()||typeof row.pid!=='number'||row.pid<=0)continue;
          let alive=true;try{process.kill(row.pid,0);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)continue;
        }
        if(typeof row.body!=='string'||Buffer.byteLength(row.body)>4096||sha(row.body)!==row.hash)throw new Error('Notification is corrupt.');
        const event=notificationEvent.parse(JSON.parse(row.body));if(event.id!==row.id||event.tenant!==tenant||event.jobId!==row.job_id||event.state!==row.state)throw new Error('Notification identity differs.');
        const attempts=Number(row.attempts)+1;if(!Number.isSafeInteger(attempts)||attempts>8){this.db.prepare("UPDATE notifications SET status='failed',failure='retry_exhausted',token=NULL,pid=NULL,host=NULL WHERE id=?").run(event.id);continue;}
        const token=randomUUID();this.db.prepare('UPDATE notifications SET token=?,pid=?,host=?,attempts=? WHERE id=?').run(token,process.pid,hostname(),attempts,event.id);
        return {id:event.id,tenant,body:row.body,destinationHash:String(row.destination_hash),attempts,token};
      }return null;
    });
    if(claim)this.notificationLeases.add(claim.id);return claim;
  }
  async settleNotification(claim:NotificationClaim,outcome:'sent'|'retry'|'failed',now=Date.now()){
    if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid notification clock.');
    this.transaction(()=>{
      const row=this.db.prepare('SELECT token,attempts FROM notifications WHERE id=? AND tenant=?').get(claim.id,claim.tenant);
      if(!row||row.token!==claim.token||row.attempts!==claim.attempts)throw new Error('Notification lease ownership changed.');
      const status=outcome==='retry'?(claim.attempts>=8?'failed':'pending'):outcome;
      const delay=Math.min(1_800_000,2000*2**(claim.attempts-1));
      this.db.prepare('UPDATE notifications SET status=?,next_attempt=?,delivered_at=?,failure=?,token=NULL,pid=NULL,host=NULL WHERE id=? AND token=?').run(status,now+delay,status==='sent'?now:null,status==='failed'?(outcome==='retry'?'retry_exhausted':'receiver_rejected'):null,claim.id,claim.token);
    });
    this.notificationLeases.delete(claim.id);
  }
  async notificationStatus(tenant:string){
    identity(tenant,randomUUID());const destination=this.notificationDestinations.get(tenant);
    const rows=this.db.prepare('SELECT id,job_id,state,status,attempts,next_attempt,delivered_at,failure,destination_hash FROM notifications WHERE tenant=? ORDER BY next_attempt DESC,id LIMIT 100').all(tenant);
    return {configured:!!destination,deliveries:rows.map(row=>({id:String(row.id),jobId:String(row.job_id),state:String(row.state),status:String(row.status),attempts:Number(row.attempts),nextAttemptAt:Number(row.next_attempt),deliveredAt:row.delivered_at===null?null:Number(row.delivered_at),failure:row.failure,destinationChanged:row.destination_hash!==destination}))};
  }
  close(){if(this.leases.size||this.notificationLeases.size)throw new Error('Stop running jobs and notification deliveries before closing the autonomous store.');this.db.close();}
}
