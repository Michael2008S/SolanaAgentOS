import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature,type Instruction,type TransactionPartialSigner } from '@solana/kit';
import { HeadlessJournal } from './headless-journal.js';
import { prepareHeadlessTransaction,confirmHeadlessTransaction } from './headless-executor.js';
import { canonicalJson } from './canonical-json.js';
import { workerDeliveryInput,workerDeliveryProfiles,type WorkerDeliveryInput } from './worker-delivery-protocol.js';
export { workerDeliveryInput,workerDeliveryProfiles } from './worker-delivery-protocol.js';
export type { WorkerDeliveryInput } from './worker-delivery-protocol.js';
type Rpc=(method:string,params:unknown[])=>Promise<any>;
type Identity={tenant:string;agent:string;session:string};
type Options={program:string;genesis:string;rpc:Rpc;feePayer:TransactionPartialSigner;signers:Map<string,TransactionPartialSigner>;identities:Identity[];profiles:z.infer<typeof workerDeliveryProfiles>;journal:HeadlessJournal};
const digest=(text:string)=>createHash('sha256').update(text).digest();
const bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
const uuid=(seed:string)=>{const h=digest(seed).toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
/** One irreversible delivery per fixed Escrow, with original wire recovery.
 * This signs only the already authorized permit; it does not grant permits,
 * hire Workers, run a model, judge work or transfer task funds. */
export class HeadlessWorkerDelivery {
 private tail:Promise<unknown>=Promise.resolve();
 private readonly options:Options;
 constructor(options:Options){this.options={...options,identities:structuredClone(options.identities),profiles:workerDeliveryProfiles.parse(structuredClone(options.profiles)),signers:new Map(options.signers)};if(this.options.profiles.some(profile=>!this.options.identities.some(identity=>identity.tenant===profile.tenant)||!this.options.signers.has(profile.tenant)))throw new Error('Worker delivery profiles require existing tenant identities and signers.');}
 execute(raw:unknown){const input=workerDeliveryInput.parse(raw),run=this.tail.then(()=>this.dispatch(input));this.tail=run.catch(()=>{});return run;}
 private async pda(seeds:Uint8Array[]){return await getProgramDerivedAddress({programAddress:address(this.options.program),seeds});}
 private async account(key:string,kind:string,length?:number){const info=(await this.options.rpc('getAccountInfo',[key,{encoding:'base64',commitment:'confirmed'}])).value;if(!info||info.owner!==this.options.program||info.executable||!Array.isArray(info.data)||info.data[1]!=='base64'||typeof info.data[0]!=='string')throw new Error('Worker delivery requires an owned program account.');const data=Buffer.from(info.data[0],'base64');if(data.length>512||(length!==undefined&&data.length!==length)||!data.subarray(0,8).equals(digest('account:'+kind).subarray(0,8)))throw new Error('Worker delivery account layout is invalid.');return data;}
 private context(input:WorkerDeliveryInput){const profile=this.options.profiles.find(profile=>profile.tenant===input.tenant),identity=this.options.identities.find(identity=>identity.tenant===input.tenant),signer=this.options.signers.get(input.tenant);if(!identity||!signer||!profile?.escrows.some(scope=>scope.escrow===input.escrow&&scope.taskHash===input.taskHash))throw new Error('Worker delivery exceeds the configured Escrow and task scope.');return {identity,signer};}
 private async validate(input:WorkerDeliveryInput){
  const {identity,signer}=this.context(input),{rpc,program,genesis}=this.options,now=BigInt(Math.floor(Date.now()/1000));
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Worker delivery chain changed.');
  const [policy,policyBump]=await this.pda([Buffer.from('policy'),bytes(identity.agent)]),[permit,permitBump]=await this.pda([Buffer.from('worker_delivery'),bytes(input.escrow)]),[session,sessionBump]=await this.pda([Buffer.from('session'),bytes(identity.agent),bytes(signer.address)]);
  if(session!==identity.session||signer.address===this.options.feePayer.address)throw new Error('Worker Session identity differs.');
  const [a,p,s,e,w]=await Promise.all([this.account(identity.agent,'Agent',138),this.account(policy,'Policy',123),this.account(session,'Session',147),this.account(input.escrow,'Escrow'),this.account(permit,'WorkerDeliveryPermit',115)]);
  const [agent,agentBump]=await this.pda([Buffer.from('agent'),a.subarray(8,40),a.subarray(40,72)]);
  if(agent!==identity.agent||a[121]!==agentBump||a[104]!==0||!p.subarray(8,40).equals(bytes(identity.agent))||p[74]!==policyBump||p[73]!==0||(p[72]&2)!==2)throw new Error('Worker Agent or delivery Policy is inactive.');
  if(!s.subarray(8,40).equals(bytes(identity.agent))||!s.subarray(40,72).equals(bytes(signer.address))||s[106]!==sessionBump||s[105]!==0||(s[104]&2)!==2||s.readBigInt64LE(72)<=now||s.subarray(115,123).equals(Buffer.from('AGTASK01')))throw new Error('Worker delivery Session is inactive or task-bound.');
  if(e.length!==180||e[128]>1||!e.subarray(40,72).equals(bytes(identity.agent))||e.subarray(96,128).toString('hex')!==input.taskHash||e.readBigInt64LE(88)<=now)throw new Error('Worker Escrow commitment or deadline differs.');
  const offset=129+(e[128]===1?32:0),[escrow,escrowBump]=await this.pda([Buffer.from('escrow'),e.subarray(8,40),e.subarray(72,80)]);
  if(escrow!==input.escrow||e[offset+1]!==escrowBump||e[offset]!==0||e[128]!==0)throw new Error('Worker Escrow is not awaiting its original delivery.');
  if(!w.subarray(8,40).equals(bytes(input.escrow))||!w.subarray(40,72).equals(bytes(identity.agent))||!w.subarray(72,104).equals(bytes(session))||w.readBigInt64LE(104)<=now||w[112]!==0||w[113]!==0||w[114]!==permitBump)throw new Error('Worker delivery permit is inactive, used or mismatched.');
  const instruction=await this.instruction(input,identity,signer,policy,permit);
  return {instruction,signer};
 }
 private async instruction(input:WorkerDeliveryInput,identity:Identity,signer:TransactionPartialSigner,policy?:ReturnType<typeof address>,permit?:ReturnType<typeof address>){
  const program=this.options.program;
  policy??=(await this.pda([Buffer.from('policy'),bytes(identity.agent)]))[0];permit??=(await this.pda([Buffer.from('worker_delivery'),bytes(input.escrow)]))[0];const session=address(identity.session);
  const evidence=input.sources.length?(await this.pda([Buffer.from('escrow_evidence'),bytes(input.escrow)]))[0]:address(program),count=Buffer.alloc(4);count.writeUInt32LE(input.sources.length);
  const instruction:Instruction={programAddress:address(program),accounts:[{address:signer.address,role:2},{address:this.options.feePayer.address,role:3},{address:address(identity.agent),role:0},{address:policy,role:0},{address:session,role:0},{address:address(input.escrow),role:1},{address:permit,role:1},{address:evidence,role:input.sources.length?1:0},{address:address('11111111111111111111111111111111'),role:0},...input.sources.map(source=>({address:address(source.execution),role:0 as const}))],data:Buffer.concat([digest('global:submit_session_escrow_result').subarray(0,8),digest(input.result),count,...input.sources.flatMap(source=>[bytes(source.execution),Buffer.from(source.contentHash,'hex')])])};
  return instruction;
 }
 private async verifySaved(input:WorkerDeliveryInput,transaction:{wire:string;signature:string}){
  const {identity,signer}=this.context(input),expected=await this.instruction(input,identity,signer),tx=getTransactionDecoder().decode(Buffer.from(transaction.wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if(message.version!==0||message.instructions.length!==1||message.header.numSignerAccounts!==2||message.staticAccounts[0]!==this.options.feePayer.address||String(getSignatureFromTransaction(tx))!==transaction.signature)throw new Error('Saved Worker transaction identity differs.');
  const ix=message.instructions[0],keys=(ix.accountIndices??[]).map(index=>message.staticAccounts[index]);
  if(message.staticAccounts[ix.programAddressIndex]!==this.options.program||!Buffer.from(ix.data??[]).equals(Buffer.from(expected.data!))||keys.length!==expected.accounts!.length||keys.some((key,index)=>key!==expected.accounts![index].address))throw new Error('Saved Worker transaction exceeds its original instruction scope.');
  for(const key of message.staticAccounts.slice(0,2)){if(![signer.address,this.options.feePayer.address].includes(key)||!tx.signatures[key]||!await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes))throw new Error('Saved Worker transaction signature is invalid.');}
 }
 private async dispatch(input:WorkerDeliveryInput){
  const {identity,signer}=this.context(input),{journal,program,genesis,rpc}=this.options,jobId=uuid('worker-job:'+input.escrow),intentId=uuid('worker-delivery:'+input.escrow),scopeHash=digest(canonicalJson({kind:'worker-delivery-v1',program,genesis,identity,signer:signer.address,feePayer:this.options.feePayer.address,input})).toString('hex');
  let record=journal.load(input.tenant,jobId,intentId);
  if(record&&(record.scopeHash!==scopeHash||record.execution!==input.escrow||record.content!==input.result))throw new Error('Original Worker delivery commitments cannot change.');
  if(!record?.result){const prepared=await this.validate(input),transaction=await prepareHeadlessTransaction(this.options,prepared.instruction,prepared.signer);record={tenant:input.tenant,jobId,intentId,scopeHash,execution:input.escrow,content:input.result,result:transaction,complete:false};journal.save(record);}
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Worker delivery chain changed during recovery.');
  await this.verifySaved(input,record.result!);
  await confirmHeadlessTransaction(this.options,record.result!,true,async()=>{await this.validate(input);});
  const e=await this.account(input.escrow,'Escrow');if(e[128]!==1||!e.subarray(129,161).equals(digest(input.result)))throw new Error('Finalized Worker delivery differs from the result commitment.');
  record.complete=true;journal.save(record);
  return {tenant:input.tenant,escrow:input.escrow,taskHash:input.taskHash,resultHash:digest(input.result).toString('hex'),signature:record.result!.signature,commitment:'finalized' as const};
 }
}
