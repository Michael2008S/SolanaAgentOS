import { createHash } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import { canonicalJson } from './canonical-json.js';
import { WorkerProfileStore,workerProfileSchema,verifyWorkerProfile,verifyWorkerProfileConflict,WorkerProfileEquivocationError,type WorkerProfileChain,type WorkerProfile } from './worker-profiles.js';
export const workerProfileCatalogSchema=z.object({format:z.literal('agentos-worker-profile-catalog'),version:z.union([z.literal(1),z.literal(2)]),network:z.enum(['localnet','devnet']),programId:z.string(),genesis:z.string(),profiles:z.array(workerProfileSchema).max(200),conflicts:z.array(z.tuple([workerProfileSchema,workerProfileSchema])).max(200).optional(),next:z.string().max(2048).optional()}).strict().refine(value=>(value.version===2||!value.conflicts?.length)&&value.profiles.length+(value.conflicts?.length??0)<=200);
export function workerProfileRoute(target:string,method:string):boolean {
 const catalog=/^\/api\/marketplace\/profiles\/catalog(?:\?cursor=[a-f0-9]{64}-[0-9]{1,5})?$/.test(target);
 return method==='POST'?target==='/api/marketplace/profile':method==='GET'?catalog:method==='OPTIONS'&&(catalog||target==='/api/marketplace/profile');
}
export function workerProfileHandler(options:{chain:()=>WorkerProfileChain;store:()=>WorkerProfileStore;agents:()=>Promise<{address:string;owner:string;active:boolean}[]>;origin:()=>string;now?:()=>number}) {
 let window=0,reads=0,writes=0;
 return async(request:IncomingMessage,response:ServerResponse,url:URL)=>{
  response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');
  const now=options.now?.()??Math.floor(Date.now()/1000),writing=request.method==='POST';
  if(Math.floor(now/60)!==window){window=Math.floor(now/60);reads=0;writes=0;}
  if(writing?++writes>30:++reads>240){response.setHeader('Retry-After','60');response.writeHead(429).end(JSON.stringify({error:'Worker profile request rate limit exceeded.'}));return;}
  try{
   const chain=options.chain();
   if(writing){
    if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json'||request.headers['content-encoding']){response.writeHead(415).end();return;}
    if(Number(request.headers['content-length']??0)>16000){response.writeHead(413).end();return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request.iterator({destroyOnReturn:false})){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>16000){response.writeHead(413).end();return;}chunks.push(bytes);}
    const candidate=workerProfileSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks))));
    await verifyWorkerProfile(candidate,{address:candidate.payload.agent,owner:candidate.payload.owner},chain,now);
    const agent=(await options.agents()).find(agent=>agent.address===candidate.payload.agent);if(!agent)throw new Error('Worker is absent from the finalized canonical directory.');
    const verified=await verifyWorkerProfile(candidate,agent,chain,now);options.store().saveVerified(verified);
    response.end(JSON.stringify({saved:true,agent:agent.address,issuedAt:verified.payload.issuedAt,expiresAt:verified.payload.expiresAt}));return;
   }
   const agents=new Map((await options.agents()).map(agent=>[agent.address,agent])),records:{profile:WorkerProfile;conflict:WorkerProfile|null}[]=[];
   for(const row of options.store().loadRecords()){
    const agent=agents.get(row.profile.payload.agent);if(!agent?.active)continue;
    try{if(row.conflict)await verifyWorkerProfileConflict([row.profile,row.conflict],agent,chain,now);else await verifyWorkerProfile(row.profile,agent,chain,now);records.push(row);}catch{/* Changed Owner or expired claims/proofs must not propagate. */}
   }
   const snapshot=createHash('sha256').update(canonicalJson(records)).digest('hex'),cursor=url.searchParams.get('cursor');let offset=0;
   if(cursor){const match=/^([a-f0-9]{64})-([0-9]{1,5})$/.exec(cursor);if(!match||match[1]!==snapshot||Number(match[2])>=records.length)throw new Error('Worker profiles changed or cursor is invalid; restart discovery.');offset=Number(match[2]);}
   const profiles:WorkerProfile[]=[],conflicts:[WorkerProfile,WorkerProfile][]=[];let end=offset;
   for(;end<Math.min(records.length,offset+200);end++){
    const row=records[end];if(row.conflict)conflicts.push([row.profile,row.conflict]);else profiles.push(row.profile);
    if(Buffer.byteLength(JSON.stringify({profiles,conflicts}))>480000){if(row.conflict)conflicts.pop();else profiles.pop();break;}
   }
   response.end(JSON.stringify({format:'agentos-worker-profile-catalog',version:conflicts.length?2:1,...chain,profiles,...(conflicts.length?{conflicts}:{}),...(end<records.length?{next:options.origin()+'/api/marketplace/profiles/catalog?cursor='+snapshot+'-'+end}:{})}));
  }catch(error){response.writeHead(error instanceof WorkerProfileEquivocationError?409:writing?400:502).end(JSON.stringify({error:error instanceof Error?error.message:'Worker profile could not be processed.'}));}
 };
}
