import { pollCatalogs } from './catalog-poll.js';
import * as z from 'zod/v4';
import { canonicalJson } from './canonical-json.js';
import { externalEndpoint } from './external-mcp.js';
import { readResponseTextLimited } from './http-limits.js';
import { workerProfileCatalogSchema } from './worker-profile-catalog.js';
import { verifyWorkerProfile,verifyWorkerProfileConflict,WorkerProfileEquivocationError,type WorkerProfile,type WorkerProfileChain,type WorkerProfileStore } from './worker-profiles.js';
export function configuredWorkerProfileCatalogs(env:NodeJS.ProcessEnv=process.env){
 const urls=z.array(externalEndpoint).max(20).parse(env.AGENTOS_WORKER_PROFILE_CATALOG_URLS?.trim()?JSON.parse(env.AGENTOS_WORKER_PROFILE_CATALOG_URLS):[]);
 if(new Set(urls).size!==urls.length)throw new Error('Worker profile catalog URLs must be unique.');return urls;
}
export type WorkerProfileSyncReport={checkedAt:number;catalogs:number;imported:number;unchanged:number;rejected:number;conflicts:number;failures:{catalog:string;reason:string}[]};
/** Public signatures only, from Operator-selected catalogs. No model URLs or
 * provider calls, credentials, signing, payment or remote capability trust. */
export class WorkerProfileSync {
 private readonly lifecycle=new AbortController();
 private running?:Promise<WorkerProfileSyncReport>;private timer?:ReturnType<typeof setTimeout>;private stopped=false;private watching=false;private report?:WorkerProfileSyncReport;
 constructor(private readonly options:{urls?:string[];chain:()=>WorkerProfileChain;agents:()=>Promise<{address:string;owner:string;active:boolean}[]>;store:()=>WorkerProfileStore;transport?:typeof fetch;now?:()=>number;intervalMs?:number}){
  const interval=options.intervalMs??60000;if(!Number.isSafeInteger(interval)||interval<60000||interval>3600000)throw new Error('Profile sync interval must be between one minute and one hour.');
  configuredWorkerProfileCatalogs(options.urls?{AGENTOS_WORKER_PROFILE_CATALOG_URLS:JSON.stringify(options.urls)}:process.env);
 }
 status(){return this.report?structuredClone(this.report):null;}
 sync():Promise<WorkerProfileSyncReport>{
  if(this.stopped)return Promise.reject(new Error('Worker profile synchronizer is stopped.'));if(this.running)return this.running;
  const promise=this.perform().then(report=>{this.report=report;return report;}).finally(()=>{if(this.running===promise)this.running=undefined;});this.running=promise;return promise;
 }
 start(){if(this.watching||this.stopped)return;this.watching=true;const tick=async()=>{try{await this.sync();}catch{/* Preserve original profiles. */}if(!this.stopped){this.timer=setTimeout(()=>{this.timer=undefined;void tick();},this.options.intervalMs??60000);this.timer.unref();}};void tick();}
 async stop(){this.stopped=true;this.lifecycle.abort();this.watching=false;clearTimeout(this.timer);this.timer=undefined;await this.running?.catch(()=>{});}
 private async perform():Promise<WorkerProfileSyncReport>{
  const urls=configuredWorkerProfileCatalogs(this.options.urls?{AGENTOS_WORKER_PROFILE_CATALOG_URLS:JSON.stringify(this.options.urls)}:process.env),now=this.options.now?.()??Math.floor(Date.now()/1000);
  const report:WorkerProfileSyncReport={checkedAt:now,catalogs:urls.length,imported:0,unchanged:0,rejected:0,conflicts:0,failures:[]};if(!urls.length)return report;
  let chain:WorkerProfileChain,agents:Map<string,{address:string;owner:string;active:boolean}>;
  try{chain=this.options.chain();agents=new Map((await this.options.agents()).map(agent=>[agent.address,agent]));}
  catch{report.failures=urls.map(catalog=>({catalog,reason:'Canonical Agent registry could not be verified; stored profiles preserved.'}));return report;}
  const transport=this.options.transport??fetch,overall=AbortSignal.timeout(120000);
  await pollCatalogs(urls,async catalogUrl=>{
   const deadline=AbortSignal.any([overall,this.lifecycle.signal,AbortSignal.timeout(30000)]);
   const root=new URL(catalogUrl),seen=new Set<string>(),candidates:WorkerProfile[]=[];let next:string|undefined=catalogUrl,count=0;
   try{
    // Fetch and validate the entire confined catalog before storing its prefix.
    for(let page=0;next&&page<200;page++){
     deadline.throwIfAborted();const target=new URL(externalEndpoint.parse(next));if(target.origin!==root.origin||target.pathname!==root.pathname||seen.has(target.toString()))throw new Error('Profile pagination leaves or repeats its configured endpoint.');seen.add(target.toString());
     const response=await transport(target,{redirect:'error',cache:'no-store',signal:AbortSignal.any([deadline,AbortSignal.timeout(10000)])});if(!response.ok)throw new Error(`Profile catalog returned HTTP ${response.status}.`);
     const catalog=workerProfileCatalogSchema.parse(JSON.parse(await readResponseTextLimited(response,512000,'Profile catalog exceeds 512 KB.')));
     if(catalog.network!==chain.network||catalog.programId!==chain.programId||catalog.genesis!==chain.genesis)throw new Error('Profile catalog belongs to another chain.');
     deadline.throwIfAborted();
     count+=catalog.profiles.length+(catalog.conflicts?.length??0);if(count>20000)throw new Error('Profile catalog exceeds its record budget.');
     for(const profile of catalog.profiles){deadline.throwIfAborted();try{const agent=agents.get(profile.payload.agent);if(!agent?.active)throw new Error('Unknown or inactive Agent.');candidates.push(await verifyWorkerProfile(profile,agent,chain,now));}catch{report.rejected++;}}
     for(const pair of catalog.conflicts??[]){deadline.throwIfAborted();try{const agent=agents.get(pair[0].payload.agent);if(!agent?.active)throw new Error('Unknown or inactive Agent.');candidates.push(...await verifyWorkerProfileConflict(pair,agent,chain,now));}catch{report.rejected++;}}
     if(candidates.length>40000)throw new Error('Profile catalog exceeds signed claim budget.');
     next=catalog.next;
    }
    if(next)throw new Error('Profile catalog exceeds its page budget; fetched prefix was not imported.');deadline.throwIfAborted();
    const current=new Map(this.options.store().loadRecords().map(row=>[row.profile.payload.agent,row.profile]));
    const latest=new Map<string,WorkerProfile[]>();
    for(const profile of candidates){
     const id=profile.payload.agent,known=latest.get(id);
     if(!known||known[0].payload.issuedAt<profile.payload.issuedAt)latest.set(id,[profile]);
     else if(known[0].payload.issuedAt===profile.payload.issuedAt&&known.length<2&&canonicalJson(known[0].payload)!==canonicalJson(profile.payload))known.push(profile);
    }
    for(const [id,claims] of latest){
     deadline.throwIfAborted();
     const profile=claims[0],old=current.get(id);if(old&&old.payload.issuedAt>profile.payload.issuedAt){report.unchanged++;continue;}
     if(claims.length===2){this.options.store().saveVerifiedConflict([claims[0],claims[1]]);report.conflicts++;current.set(id,profile);continue;}
     try{if(this.options.store().saveVerified(profile)){report.imported++;current.set(id,profile);}else report.unchanged++;}
     catch(error){if(error instanceof WorkerProfileEquivocationError)report.conflicts++;else throw error;}
    }
   }catch(error){report.failures.push({catalog:catalogUrl,reason:error instanceof Error?error.message.slice(0,300):'Worker profile synchronization failed.'});}
  });
  return report;
 }
}
