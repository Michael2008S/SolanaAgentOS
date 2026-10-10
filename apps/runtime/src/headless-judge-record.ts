import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature,type Instruction,type TransactionPartialSigner } from '@solana/kit';
import { HeadlessJournal } from './headless-journal.js';
import { prepareHeadlessTransaction,confirmHeadlessTransaction } from './headless-executor.js';
import { canonicalJson } from './canonical-json.js';
import { judgeRecordInput,judgeRecordProfiles,type JudgeRecordInput } from './judge-record-protocol.js';
type Rpc=(method:string,params:unknown[])=>Promise<any>;
type Identity={tenant:string;agent:string;session:string};
type Options={program:string;genesis:string;rpc:Rpc;feePayer:TransactionPartialSigner;signers:Map<string,TransactionPartialSigner>;identities:Identity[];profiles:z.infer<typeof judgeRecordProfiles>;journal:HeadlessJournal};
const digest=(text:string)=>createHash('sha256').update(text).digest();
const bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
const uuid=(seed:string)=>{const h=digest(seed).toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
/** Records a structured assessment under an already accepted independent Judge
 * mandate. No model, mandate creation or settlement; original wire is immutable. */
export class HeadlessJudgeRecord {
 private tail:Promise<unknown>=Promise.resolve();
 private readonly options:Options;
 constructor(options:Options){this.options={...options,identities:structuredClone(options.identities),profiles:judgeRecordProfiles.parse(structuredClone(options.profiles)),signers:new Map(options.signers)};if(this.options.profiles.some(profile=>!this.options.identities.some(identity=>identity.tenant===profile.tenant)||!this.options.signers.has(profile.tenant)))throw new Error('Judge record profiles require existing tenant identities and signers.');}
 execute(raw:unknown){const input=judgeRecordInput.parse(raw),run=this.tail.then(()=>this.dispatch(input));this.tail=run.catch(()=>{});return run;}
 async preflight(raw:unknown){const input=judgeRecordInput.parse(raw);await this.validate(input);return {tenant:input.tenant,escrow:input.escrow,taskHash:input.taskHash,resultHash:input.resultHash,ready:true as const};}
 private async pda(seeds:Uint8Array[]){return await getProgramDerivedAddress({programAddress:address(this.options.program),seeds});}
 private async account(key:string,kind:string,length?:number){const info=(await this.options.rpc('getAccountInfo',[key,{encoding:'base64',commitment:'confirmed'}])).value;if(!info||info.owner!==this.options.program||info.executable||!Array.isArray(info.data)||info.data[1]!=='base64'||typeof info.data[0]!=='string')throw new Error('Judge record requires an owned program account.');const data=Buffer.from(info.data[0],'base64');if(data.length>512||(length!==undefined&&data.length!==length)||!data.subarray(0,8).equals(digest('account:'+kind).subarray(0,8)))throw new Error('Judge record account layout is invalid.');return data;}
 private context(input:JudgeRecordInput){const profile=this.options.profiles.find(profile=>profile.tenant===input.tenant),identity=this.options.identities.find(identity=>identity.tenant===input.tenant),signer=this.options.signers.get(input.tenant);if(!identity||!signer||!profile?.escrows.some(scope=>scope.escrow===input.escrow&&scope.taskHash===input.taskHash))throw new Error('Judge record exceeds the configured Escrow and task scope.');return {identity,signer};}
 private async validate(input:JudgeRecordInput){
  const {identity,signer}=this.context(input),{rpc,program,genesis}=this.options,now=BigInt(Math.floor(Date.now()/1000));
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Judge record chain changed.');
  const [policy,policyBump]=await this.pda([Buffer.from('policy'),bytes(identity.agent)]),[mandate,mandateBump]=await this.pda([Buffer.from('escrow_judge'),bytes(input.escrow)]),[session,sessionBump]=await this.pda([Buffer.from('session'),bytes(identity.agent),bytes(signer.address)]);
  if(session!==identity.session||signer.address===this.options.feePayer.address)throw new Error('Judge Session identity differs.');
  const [a,p,s,e,m]=await Promise.all([this.account(identity.agent,'Agent',138),this.account(policy,'Policy',123),this.account(session,'Session',147),this.account(input.escrow,'Escrow',180),this.account(mandate,'JudgeMandate',220)]);
  const [agent,agentBump]=await this.pda([Buffer.from('agent'),a.subarray(8,40),a.subarray(40,72)]);
  if(agent!==identity.agent||a[121]!==agentBump||a[104]!==0||!p.subarray(8,40).equals(bytes(identity.agent))||p[74]!==policyBump||p[73]!==0||(p[72]&4)!==4)throw new Error('Judge Agent or API Policy is inactive.');
  if(!s.subarray(8,40).equals(bytes(identity.agent))||!s.subarray(40,72).equals(bytes(signer.address))||s[106]!==sessionBump||s[105]!==0||(s[104]&4)!==4||s.readBigInt64LE(72)<=now||s.subarray(115,123).equals(Buffer.from('AGTASK01')))throw new Error('Judge Session is inactive or task-bound.');
  if(e[128]!==1||e[161]!==0||e.subarray(96,128).toString('hex')!==input.taskHash||e.subarray(129,161).toString('hex')!==input.resultHash||e.readBigInt64LE(88)<=now)throw new Error('Judge Escrow task, result, deadline or state differs.');
  const [escrow,escrowBump]=await this.pda([Buffer.from('escrow'),e.subarray(8,40),e.subarray(72,80)]);
  if(escrow!==input.escrow||e[162]!==escrowBump)throw new Error('Judge Escrow is not canonical.');
  if(!m.subarray(8,40).equals(bytes(input.escrow))||!m.subarray(40,72).equals(e.subarray(8,40))||!m.subarray(72,104).equals(e.subarray(40,72))||!m.subarray(104,136).equals(bytes(identity.agent))||!m.subarray(136,168).equals(bytes(session))||m.subarray(168,200).toString('hex')!==input.taskHash||m.readBigInt64LE(200)<=now||m.readBigInt64LE(200)>e.readBigInt64LE(88)||m[216]!==1||m[217]!==0||m[218]!==0||m[219]!==mandateBump)throw new Error('Judge mandate is unaccepted, expired, used or mismatched.');
  const decoder=(await import('@solana/kit')).getAddressDecoder(),employer=String(decoder.decode(e.subarray(8,40))),worker=String(decoder.decode(e.subarray(40,72)));
  const parties=await Promise.all([this.account(employer,'Agent',138),this.account(worker,'Agent',138)]);
  for(const [index,party] of parties.entries()){const [key,bump]=await this.pda([Buffer.from('agent'),party.subarray(8,40),party.subarray(40,72)]);if(key!==[employer,worker][index]||party[121]!==bump)throw new Error('Judge party identity is not canonical.');}
  if(new Set([identity.agent,employer,worker]).size!==3||new Set([a, ...parties].map(party=>party.subarray(8,40).toString('hex'))).size!==3)throw new Error('Judge must remain independent of both current party Owners.');
  const minimum=this.options.profiles.find(profile=>profile.tenant===input.tenant)!.minimumConfidence;
  if(input.judgment.verdict!=='needs_review'&&input.judgment.confidence<minimum)throw new Error('Judge confidence is below the configured pass/fail threshold.');
  const instruction=await this.instruction(input,identity,signer,policy,mandate);
  return {instruction,signer};
 }
 private async instruction(input:JudgeRecordInput,identity:Identity,signer:TransactionPartialSigner,policy?:ReturnType<typeof address>,mandate?:ReturnType<typeof address>){
  const program=this.options.program;
  policy??=(await this.pda([Buffer.from('policy'),bytes(identity.agent)]))[0];mandate??=(await this.pda([Buffer.from('escrow_judge'),bytes(input.escrow)]))[0];const decision=(await this.pda([Buffer.from('escrow_decision'),bytes(input.escrow)]))[0];
  const instruction:Instruction={programAddress:address(program),accounts:[{address:signer.address,role:2},{address:this.options.feePayer.address,role:3},{address:address(identity.agent),role:0},{address:policy,role:0},{address:address(identity.session),role:0},{address:address(input.escrow),role:0},{address:mandate,role:1},{address:decision,role:1},{address:address('11111111111111111111111111111111'),role:0}],data:Buffer.concat([digest('global:record_escrow_judgment').subarray(0,8),Buffer.from([['pass','fail','needs_review'].indexOf(input.judgment.verdict)]),Buffer.from(input.taskHash,'hex'),Buffer.from(input.resultHash,'hex'),digest(canonicalJson(input.judgment))])};
  return instruction;
 }
 private async verifySaved(input:JudgeRecordInput,transaction:{wire:string;signature:string}){
  const {identity,signer}=this.context(input),expected=await this.instruction(input,identity,signer),tx=getTransactionDecoder().decode(Buffer.from(transaction.wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if(message.version!==0||message.instructions.length!==1||message.header.numSignerAccounts!==2||message.staticAccounts[0]!==this.options.feePayer.address||String(getSignatureFromTransaction(tx))!==transaction.signature)throw new Error('Saved Judge transaction identity differs.');
  const ix=message.instructions[0],keys=(ix.accountIndices??[]).map(index=>message.staticAccounts[index]);
  if(message.staticAccounts[ix.programAddressIndex]!==this.options.program||!Buffer.from(ix.data??[]).equals(Buffer.from(expected.data!))||keys.length!==expected.accounts!.length||keys.some((key,index)=>key!==expected.accounts![index].address))throw new Error('Saved Judge transaction exceeds its original instruction scope.');
  for(const key of message.staticAccounts.slice(0,2)){if(![signer.address,this.options.feePayer.address].includes(key)||!tx.signatures[key]||!await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes))throw new Error('Saved Judge transaction signature is invalid.');}
 }
 private async dispatch(input:JudgeRecordInput){
  const {identity,signer}=this.context(input),{journal,program,genesis,rpc}=this.options,jobId=uuid('judge-job:'+input.escrow),intentId=uuid('judge-record:'+input.escrow),scopeHash=digest(canonicalJson({kind:'judge-record-v1',program,genesis,identity,signer:signer.address,feePayer:this.options.feePayer.address,input})).toString('hex');
  let record=journal.load(input.tenant,jobId,intentId);
  if(record&&(record.scopeHash!==scopeHash||record.execution!==input.escrow||record.content!==canonicalJson(input.judgment)))throw new Error('Original Judge record commitments cannot change.');
  if(!record?.result){const prepared=await this.validate(input),transaction=await prepareHeadlessTransaction(this.options,prepared.instruction,prepared.signer);record={tenant:input.tenant,jobId,intentId,scopeHash,execution:input.escrow,content:canonicalJson(input.judgment),result:transaction,complete:false};journal.save(record);}
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Judge record chain changed during recovery.');
  await this.verifySaved(input,record.result!);
  await confirmHeadlessTransaction(this.options,record.result!,true,async()=>{await this.validate(input);});
  const [decision,bump]=await this.pda([Buffer.from('escrow_decision'),bytes(input.escrow)]),d=await this.account(decision,'JudgeDecision',243),[mandate]=await this.pda([Buffer.from('escrow_judge'),bytes(input.escrow)]),judgmentHash=digest(canonicalJson(input.judgment)).toString('hex');
  if(d[242]!==bump||!d.subarray(8,40).equals(bytes(input.escrow))||!d.subarray(40,72).equals(bytes(mandate))||!d.subarray(72,104).equals(bytes(identity.agent))||!d.subarray(104,136).equals(bytes(identity.session))||d.subarray(136,168).toString('hex')!==input.taskHash||d.subarray(168,200).toString('hex')!==input.resultHash||d.subarray(200,232).toString('hex')!==judgmentHash||d[232]!==['pass','fail','needs_review'].indexOf(input.judgment.verdict))throw new Error('Finalized Judge decision differs from the original commitments.');
  record.complete=true;journal.save(record);
  return {tenant:input.tenant,escrow:input.escrow,decision,taskHash:input.taskHash,resultHash:input.resultHash,judgmentHash,verdict:input.judgment.verdict,signature:record.result!.signature,commitment:'finalized' as const};
 }
}
