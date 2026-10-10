import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { address, generateKeyPairSigner, getAddressEncoder, createTransactionMessage, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, addSignersToInstruction, signTransactionMessageWithSigners, compileTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, type Instruction, type KeyPairSigner } from '@solana/kit';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
export const digest = (text: string | Uint8Array) => new Uint8Array(createHash('sha256').update(text).digest());
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class LocalHarness {
 root = ''; rpcUrl = 'http://127.0.0.1:19899'; runtimeUrl = 'http://127.0.0.1:19787';
 runtimeProcess?: ChildProcess; runtimeGeneration=0; processes: ChildProcess[] = []; signers!: Record<'payer'|'workerOwner'|'judgeOwner'|'session'|'workerSession'|'judgeSession'|'provider',KeyPairSigner>;
 wrongMint!: ReturnType<typeof address>;
 initialSol = 0n; genesis = ''; approved = false; sent = 0; tests: { name: string; details: unknown }[] = []; transactions: unknown[] = [];
 async rpc(method: string, params: unknown[] = []) {
  const r=await fetch(this.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  const b=JSON.parse(await r.text(), (_key: string, value: unknown, context?: {source?: string}) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source ? BigInt(context.source) : value); if(!r.ok||b.error)throw new Error(`${method}: ${JSON.stringify(b.error)}`);return b.result;
 }
 async start(options: { fundWorkerUsdc?: boolean } = {}) {
  this.root=await mkdtemp(join(tmpdir(),'agentos-local-e2e-'));
  this.signers=Object.fromEntries(await Promise.all(['payer','workerOwner','judgeOwner','session','workerSession','judgeSession','provider'].map(async name=>[name,await generateKeyPairSigner()]))) as typeof this.signers;
  const payer=this.signers.payer.address;
  this.wrongMint=(await generateKeyPairSigner()).address;
  const mint=Buffer.alloc(82);mint.writeUInt32LE(1,0);Buffer.from(getAddressEncoder().encode(payer)).copy(mint,4);mint.writeBigUInt64LE(1_000_000_000n,36);mint[44]=6;mint[45]=1;
  const ata=await sdk.deriveUsdcTokenAddress(payer);const token=Buffer.alloc(165);Buffer.from(getAddressEncoder().encode(sdk.DEVNET_USDC_MINT)).copy(token);Buffer.from(getAddressEncoder().encode(payer)).copy(token,32);token.writeBigUInt64LE(1_000_000_000n,64);token[108]=1;
  const fixtures=join(this.root,'fixtures');await mkdir(fixtures);
  for (const [key,data,lamports] of [[sdk.DEVNET_USDC_MINT,mint,1461600],[this.wrongMint,mint,1461600],[ata,token,2039280]] as const) await writeFile(join(fixtures,`${key}.json`),JSON.stringify({pubkey:key,account:{lamports,data:[data.toString('base64'),'base64'],owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',executable:false,rentEpoch:0}}));
  if(options.fundWorkerUsdc){const owner=this.signers.workerOwner.address,workerToken=Buffer.from(token),workerAta=await sdk.deriveUsdcTokenAddress(owner);Buffer.from(getAddressEncoder().encode(owner)).copy(workerToken,32);await writeFile(join(fixtures,`${workerAta}.json`),JSON.stringify({pubkey:workerAta,account:{lamports:2039280,data:[workerToken.toString('base64'),'base64'],owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',executable:false,rentEpoch:0}}));}
  await this.launch('validator','solana-test-validator',['--ledger',join(this.root,'ledger'),'--rpc-port','19899','--faucet-port','19901','--gossip-port','19902','--mint',payer,'--account-dir',fixtures,'--bpf-program',sdk.PROGRAM_ADDRESS,resolve('target/sbf-safe/agent_os.so'),'--quiet'],{NO_DNA:'1'});
  for(let n=0;n<120;n++){try{assert.equal(await this.rpc('getHealth'),'ok');this.genesis=await this.rpc('getGenesisHash');break;}catch(e){if(n===119)throw e;await delay(250);}}
  assert.notEqual(this.genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  for(let n=0;n<80;n++){this.initialSol=await this.sol(payer);if(this.initialSol>1_000_000_000n && await this.rpc('getSlot',[{commitment:'confirmed'}])>0)break;await delay(200);}
  assert.ok(this.initialSol>1_000_000_000n,`Local genesis payer has no funded balance: ${payer}`);
  console.log(`Local chain ready: ${this.genesis}; payer ${payer}; initial balance ${this.initialSol}`);
  process.env.AGENTOS_CLUSTER='localnet';process.env.AGENTOS_LOCALNET_GENESIS_HASH=this.genesis;process.env.SOLANA_RPC_URL=this.rpcUrl;process.env.AGENTOS_PROGRAM_ID=sdk.PROGRAM_ADDRESS;process.env.AGENTOS_DATA_DIR=join(this.root,'runtime-data');
  process.env.AGENTOS_TENANT_CREDENTIAL_DATABASE='';process.env.AGENTOS_PERSIST_MEMORY='true';process.env.AGENTOS_PERSIST_HISTORY='true';process.env.OPENAI_API_KEY='local-test-fixture';process.env.OPENAI_MODEL='local-test-fixture';process.env.AGENTOS_LOCAL_MODEL_URL='http://127.0.0.1:19789/v1/responses';process.env.AGENTOS_WORKER_AUTORUN='';process.env.AGENTOS_STORAGE_BACKEND='json';
 }
 async launch(name:string,command:string,args:string[],extra:Record<string,string>={}) {
  const child=spawn(command,args,{env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});this.processes.push(child);
  let log='';child.stdout?.on('data',b=>{log+=b.toString()});child.stderr?.on('data',b=>{log+=b.toString()});child.on('error',e=>{log+=String(e)});
  child.on('exit',()=>{void writeFile(join(this.root,`${name}.log`),log)});return child;
 }
 async runtime() {
  const child=await this.launch(`runtime-${++this.runtimeGeneration}`,process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{PORT:'19787',AGENTOS_WEB_ORIGINS:'http://127.0.0.1:15173',AGENTOS_PERSIST_ESCROW_HANDOFFS:'true'});
  this.runtimeProcess=child;
  for(let n=0;n<100;n++){try{const b=await this.api('/api/health');assert.equal(b.network,'localnet-preview');return child;}catch(e){if(exited(child)||n===99)throw e;await delay(200);}}
  throw new Error('Runtime did not start');
 }
 async restartRuntime() {
  const child=this.runtimeProcess;assert.ok(child && !exited(child),'Runtime is not running');
  child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);assert.ok(exited(child),'Runtime did not stop');
  return this.runtime();
 }
 async api(path:string,body?:unknown,expected=200) {
  const r=await fetch(this.runtimeUrl+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});const text=await r.text();assert.equal(r.status,expected,`${path}: ${text}`);return JSON.parse(text);
 }
 async message(instructions:Instruction[],signers:KeyPairSigner[]=[],feePayer:KeyPairSigner=this.signers.payer) {
  const lifetime=(await this.rpc('getLatestBlockhash',[{commitment:'confirmed'}])).value;
  const base=setTransactionMessageFeePayerSigner(feePayer,createTransactionMessage({version:0}));
  return appendTransactionMessageInstructions(instructions.map(i=>addSignersToInstruction(signers,i)),setTransactionMessageLifetimeUsingBlockhash({...lifetime,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},base));
 }
 async prepareReview() {
  const init=await sdk.buildInitializeAgent(this.signers.payer.address,'Local E2E Employer',5,1,100,20,['api','payment','escrow']);
  const unsigned=getBase64EncodedWireTransaction(compileTransaction(await this.message([init.instruction])));
  const simulation=(await this.rpc('simulateTransaction',[unsigned,{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
  assert.equal(simulation.err,null,JSON.stringify(simulation.logs));
  const binaryHash=hex(digest(await readFile('target/sbf-safe/agent_os.so')));
  const review={cluster:'localnet',rpc:this.rpcUrl,genesis:this.genesis,program:sdk.PROGRAM_ADDRESS,binaryHash,feePayer:this.signers.payer.address,recipients:Object.fromEntries(Object.entries(this.signers).map(([role,signer])=>[role,signer.address])),funds:'Local genesis/faucet balances only',limits:{maxTransactions:200,maxWalletSolSpend:5,initialFakeUsdc:1000,maxEscrowSol:0.02,maxEscrowUsdc:2,maxSkillSol:0.001,maxSkillUsdc:0.1},scope:['Agent/vault/SOL/USDC','Session/task budgets and recovery','Skill 402/results/Memory','Worker handoff/delivery','Judge pass/fail/review','refund/cancel/split/reputation'],simulation:{operation:'initialize_agent',error:simulation.err,unitsConsumed:simulation.unitsConsumed},privateKeys:'Generated only in memory; never saved; not user wallets',root:this.root};
  await writeFile(join(this.root,'review.json'),JSON.stringify(review,null,2));console.log('LOCAL TEST REVIEW\n'+JSON.stringify(review,null,2));
  return init;
 }
 async authorize() {
  const input=createInterface({input:process.stdin,output:process.stdout});
  try{const reply=await input.question('Waiting for explicit approval. Type APPROVE LOCAL TESTS to run, otherwise abort: ');assert.equal(reply.trim(),'APPROVE LOCAL TESTS');this.approved=true;}finally{input.close();}
 }
 async tx(name:string,instructions:Instruction[],signers:KeyPairSigner[]=[],expectError?:string,feePayer:KeyPairSigner=this.signers.payer) {
  assert.equal(this.approved,true,'Explicit local test approval required');assert.ok(this.sent<200,'Transaction cap exceeded');
  assert.ok(this.initialSol - await this.sol(this.signers.payer.address) < 5_000_000_000n, 'Local payer spending cap exceeded');
  const message=await this.message(instructions,signers,feePayer);
  const unsigned=getBase64EncodedWireTransaction(compileTransaction(message));
  const preflight=(await this.rpc('simulateTransaction',[unsigned,{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
  if(expectError){assert.notEqual(preflight.err,null,`${name} unexpectedly succeeded`);assert.ok((preflight.logs||[]).some((line:string)=>line.includes(expectError)),`${name}: wanted ${expectError}; ${preflight.logs}`);this.pass(name,{expectedError:expectError,simulationError:preflight.err});return '';}
  assert.equal(preflight.err,null,`${name}: ${JSON.stringify(preflight.logs)}`);
  const fee=(await this.rpc('getFeeForMessage',[Buffer.from(compileTransaction(message).messageBytes).toString('base64'),{commitment:'confirmed'}])).value;
  assert.ok(Number.isSafeInteger(fee)&&fee>=0&&fee<=10000,`${name}: network fee exceeds local acceptance cap`);
  const signed=await signTransactionMessageWithSigners(message);const wire=getBase64EncodedWireTransaction(signed);
  const simulation=(await this.rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}])).value;
  assert.equal(simulation.err,null,`${name}: ${JSON.stringify(simulation.logs)}`);
  this.sent++;const signature=await this.rpc('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:3}]);assert.equal(signature,String(getSignatureFromTransaction(signed)));
  this.transactions.push({name,signature,units:simulation.unitsConsumed,confirmed:false});
  let status;for(let n=0;n<200;n++){status=(await this.rpc('getSignatureStatuses',[[signature]])).value[0];if(status&&['confirmed','finalized'].includes(status.confirmationStatus))break;await delay(100);}
  assert.ok(status,'Transaction status missing');assert.equal(status.err,null);assert.ok(['confirmed','finalized'].includes(status.confirmationStatus));
  assert.ok(this.initialSol - await this.sol(this.signers.payer.address) <= 5_000_000_000n, 'Local payer spending cap exceeded');
  this.transactions[this.transactions.length-1]={name,signature,units:simulation.unitsConsumed,confirmed:true};console.log(`TX ${name} ${signature}`);return signature;
 }
 async data(key:string,owner=sdk.PROGRAM_ADDRESS) {const a=(await this.rpc('getAccountInfo',[key,{encoding:'base64',commitment:'confirmed'}])).value;assert.ok(a,`Missing ${key}`);assert.equal(a.owner,owner);return Buffer.from(a.data[0],'base64');}
 async sol(key:string) {return BigInt((await this.rpc('getBalance',[key,{commitment:'confirmed'}])).value);}
 async usdc(owner:string) {const ata=await sdk.deriveUsdcTokenAddress(address(owner));const b=await this.data(ata,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');assert.equal(b.length,165);return b.readBigUInt64LE(64);}
 pass(name:string,details:unknown={}) {this.tests.push({name,details});console.log(`PASS ${name}`);}
 async finish(error?:unknown) {
  const evidence={format:'agentos-local-integration',version:1,passed:!error,checkedAt:new Date().toISOString(),genesis:this.genesis,rpc:this.rpcUrl,program:sdk.PROGRAM_ADDRESS,transactions:this.transactions,tests:this.tests,error:error?String(error):null,scope:'Local signed transactions and deterministic service fixtures; not Devnet or real external-model quality',root:this.root};
  await writeFile(join(this.root,'report.json'),JSON.stringify(evidence,null,2));console.log(`Evidence: ${this.root}/report.json`);
  for(const p of this.processes.reverse()){if(!exited(p)){p.kill('SIGTERM');await Promise.race([once(p,'exit'),delay(3000)]);if(!exited(p))p.kill('SIGKILL');}}
 }
}
