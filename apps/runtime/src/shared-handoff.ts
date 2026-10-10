import {verifyHandoffSources,handoffSources} from './handoff-sources.js';
import {getAddressDecoder} from '@solana/kit';
import * as z from 'zod/v4';
import {getProgramDerivedAddress,address} from '@solana/kit';
import {HeadlessJournal} from './headless-journal.js';
import {canonicalJson} from './canonical-json.js';
import {sharedHandoffCommand,sharedHandoffProfiles,sharedHandoffSchema,sharedHandoffResponse,handoffDigest} from './shared-handoff-protocol.js';
const uuid=(s:string)=>{const h=handoffDigest(s);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
type Options={program:string;genesis:string;profiles:z.infer<typeof sharedHandoffProfiles>;journal:HeadlessJournal;rpc:(method:string,params:unknown[])=>Promise<any>};
/** Read-only chain verification and immutable text publication. No wallet,
 * transactions, model, network listing or arbitrary tenant scope discovery. */
export class SharedHandoffService {
 private tail:Promise<unknown>=Promise.resolve();
 private readonly profiles:z.infer<typeof sharedHandoffProfiles>;
 constructor(private readonly options:Options){this.profiles=sharedHandoffProfiles.parse(structuredClone(options.profiles));}
 execute(tenant:string,raw:unknown){const input=sharedHandoffCommand.parse(structuredClone(raw));const run=this.tail.then(()=>this.dispatch(tenant,input));this.tail=run.catch(()=>{});return run;}
 async drain(){await this.tail;}
 private async dispatch(tenant:string,input:z.infer<typeof sharedHandoffCommand>){
  const {program,genesis,rpc,journal}=this.options,scope=this.profiles.find(p=>p.tenant===tenant)?.escrows.find(s=>s.escrow===input.escrow&&s.taskHash===input.taskHash);
  if(!scope||input.tenant!==tenant||input.program!==program||input.genesis!==genesis||input.op==='put'&&scope.access!=='write')throw new Error('Shared handoff is outside its fixed tenant or chain scope.');
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Shared handoff chain changed.');const info=(await rpc('getAccountInfo',[input.escrow,{encoding:'base64',commitment:'finalized'}])).value;
  if(!info||info.owner!==program||info.executable||!Array.isArray(info.data)||info.data[1]!=='base64'||typeof info.data[0]!=='string'||info.data[0].length>1024)throw new Error('Shared handoff Escrow is foreign.');const d=Buffer.from(info.data[0],'base64'),present=d[128],offset=129+(present===1?32:0);
  if(d.length!==180||!d.subarray(0,8).equals(Buffer.from(handoffDigest('account:Escrow'),'hex').subarray(0,8))||present>1||d[offset]>5||d[offset+18]>1)throw new Error('Shared handoff Escrow layout differs.');const [canonical,bump]=await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('escrow'),d.subarray(8,40),d.subarray(72,80)]});if(canonical!==input.escrow||d[offset+1]!==bump||d.subarray(96,128).toString('hex')!==input.taskHash)throw new Error('Shared handoff Escrow commitment differs.');
  const resultHash=present===1?d.subarray(129,161).toString('hex'):null,jobId=uuid(program+':'+genesis+':'+input.escrow),scopeHash=handoffDigest(canonicalJson({program,genesis,escrow:input.escrow,taskHash:input.taskHash})),intentId=(stage:string)=>uuid('shared-handoff:'+jobId+':'+stage),load=(stage:string)=>{const r=journal.load('shared',jobId,intentId(stage));if(r&&(r.scopeHash!==scopeHash||r.execution!==input.escrow))throw new Error('Original shared handoff scope changed.');return r;},save=(stage:string,content:string)=>journal.save({tenant:'shared',jobId,intentId:intentId(stage),scopeHash,execution:input.escrow,content,complete:true});
  if(input.op==='put'){if(handoffDigest(input.task)!==input.taskHash||input.result!==null&&handoffDigest(input.result)!==resultHash)throw new Error('Shared handoff text does not match finalized commitments.');if(input.sources){if(!input.result||!resultHash)throw new Error('Sources require a committed Worker result.');await verifyHandoffSources(program,input.escrow,getAddressDecoder().decode(d.subarray(40,72)),resultHash,input.sources,rpc);save('sources',canonicalJson(input.sources));}save('task',input.task);if(input.result!==null)save('result',input.result);}
  const savedSources=load('sources')?.content,sources=savedSources?handoffSources.parse(JSON.parse(savedSources)):undefined;if(sources){if(!resultHash)throw new Error('Saved sources require a committed result.');await verifyHandoffSources(program,input.escrow,getAddressDecoder().decode(d.subarray(40,72)),resultHash,sources,rpc);}const task=load('task')?.content,result=load('result')?.content??null;if(task===undefined)return sharedHandoffResponse.parse({version:1,program,genesis,handoff:null});if(handoffDigest(task)!==input.taskHash||result!==null&&handoffDigest(result)!==resultHash)throw new Error('Saved shared handoff differs from current chain commitments.');
  return sharedHandoffResponse.parse({version:1,program,genesis,handoff:sharedHandoffSchema.parse({escrow:input.escrow,task,taskHash:input.taskHash,result:input.op==='get'&&input.taskOnly?null:result,resultHash:input.op==='get'&&input.taskOnly?null:result===null?null:resultHash,...(sources&&!(input.op==='get'&&input.taskOnly)?{sources}:{})})});
 }
}
