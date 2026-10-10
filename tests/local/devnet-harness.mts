import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {address,generateKeyPairSigner,compileTransaction,signTransactionMessageWithSigners,getBase64EncodedWireTransaction,getSignatureFromTransaction,type Instruction,type KeyPairSigner} from '@solana/kit';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import {LocalHarness,hex,digest} from './harness.mts';
import {inspectWorkflowFunding} from '../../scripts/devnet-workflow-funding.mjs';
import {inspectWorkflowTransaction} from '../../scripts/devnet-workflow-rpc.mjs';
import {parseDeploymentRpc} from '../../scripts/devnet-deployment-guard.mjs';
import {workflowFundingCliSteps} from '../../scripts/devnet-workflow-funding-rpc.mjs';
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',originalWallet='88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4';
const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const exited=(child:ChildProcess)=>child.exitCode!==null||child.signalCode!==null;
const json=(value:unknown)=>JSON.stringify(value,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n';

/** Same business flow as LocalHarness, real official Devnet assets and original
 * wallet CLI funding. Ephemeral role keys never leave this parent process. */
export class DevnetHarness extends LocalHarness {
 readonly evidenceDirectory:string;
 fundingReview:any;businessReview:any;preflight:any;deployment:any;businessReady=false;
 constructor(directory:string){super();this.evidenceDirectory=resolve(directory);this.rpcUrl='http://127.0.0.1:18895';}
 async rpc(method:string,params:unknown[]=[]){
  const response=await fetch(this.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(120000)}),body=parseDeploymentRpc(await response.text());assert.ok(response.ok&&!body.error,'Protected Devnet read/send failed; preserve its original wire.');return body.result;
 }
 private proxyEnvironment(){return {NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:'http://127.0.0.1:17897',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',NO_DNA:'1'};}
 private async nodeStep(name:string,args:string[],extra:Record<string,string>={}){
  const child=await this.launch(name,process.execPath,args,{...this.proxyEnvironment(),...extra});const [code]=await once(child,'exit');return code;
 }
 private async ready(child:ChildProcess,url:string){
  for(let n=0;n<120;n++){
   assert.ok(!exited(child),'Protected Devnet RPC stopped before readiness.');
   try{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]}),signal:AbortSignal.timeout(20000)}),body=await response.json();if(body.result===genesis)return;}catch{}
   await pause(500);
  }
  throw Error('Protected Devnet RPC readiness timed out; no replacement process started.');
 }
 async start(options:{fundWorkerUsdc?:boolean;preflightOnly?:boolean;solOnly?:boolean}={}){
  this.root=await mkdtemp(join(tmpdir(),'agentos-devnet-e2e-'));await mkdir(this.evidenceDirectory,{recursive:true});
  this.signers=Object.fromEntries(await Promise.all(['payer','workerOwner','judgeOwner','session','workerSession','judgeSession','provider'].map(async name=>[name,await generateKeyPairSigner()]))) as typeof this.signers;
  this.wrongMint=(await generateKeyPairSigner()).address;this.genesis=genesis;
  const deploymentDirectory=join(this.evidenceDirectory,'deployment');
  const code=await this.nodeStep('deployment-preflight',['scripts/capture-devnet-evidence.mjs','--deployment-only','--output',deploymentDirectory]);
  this.deployment=JSON.parse(await readFile(join(deploymentDirectory,'report.json'),'utf8'));
  assert.equal(code,0,'Current-source Devnet deployment preflight failed.');assert.equal(this.deployment.status,'deployment-verified-workflows-pending');assert.equal(this.deployment.deployment.binarySha256,hex(digest(await readFile('target/sbf-safe/agent_os.so'))));
  const solOnly=options.solOnly===true;
  const fundingDirectory=join(this.evidenceDirectory,'funding'),proposalPath=join(fundingDirectory,'proposal.json');await mkdir(fundingDirectory,{recursive:true});
  this.fundingReview={...(solOnly?{assetMode:'SOL'}:{}),authorized:false,network:'devnet',genesisHash:genesis,rpc:'https://api.devnet.solana.com',fundingWallet:originalWallet,recipients:{payer:this.signers.payer.address,workerOwner:this.signers.workerOwner.address},amounts:{payerSolLamports:'300000000',payerUsdcAtomic:solOnly?'0':'10000',workerOwnerUsdcAtomic:solOnly?'0':'200000'},limits:{maximumAtaRentLamports:solOnly?'0':'2100000',networkFeePerTransactionLamports:'10000',maximumWalletLamports:solOnly?'300010000':'305000000'},evidenceDirectory:fundingDirectory,scope:'Fixed isolated Worker/Judge/Task acceptance; assetMode determines permitted payments. Recipient keys remain in parent memory for this run and are never exported.'};
  await writeFile(proposalPath,json(this.fundingReview),{mode:0o600});
  const fundingCode=await this.nodeStep('funding-preflight',['scripts/devnet-workflow-funding-rpc.mjs','--preflight'],{AGENTOS_WORKFLOW_FUNDING_REVIEW:proposalPath});
  const proofs=(await readdir(fundingDirectory)).filter(name=>name.startsWith('preflight-')).sort();assert.equal(proofs.length,1,'Original funding preflight missing.');this.preflight=JSON.parse(await readFile(join(fundingDirectory,proofs[0]),'utf8'));assert.ok([0,2].includes(Number(fundingCode)),'Official funding preflight failed.');
  await writeFile(join(this.evidenceDirectory,'preflight.json'),json({deployment:this.deployment.deployment,funding:this.preflight,modelRequests:0,transactionsSent:0}),{mode:0o600});
  if(options.preflightOnly)return;
  assert.ok(solOnly||options.fundWorkerUsdc,'Full Devnet role acceptance requires the fixed real USDC funding.');
  assert.equal(this.preflight.fundsAvailable,true,'Official Devnet USDC/SOL funding is missing; no transaction or model request sent.');
  let wallet:string;try{wallet=execFileSync('solana',['address'],{env:{...process.env,NO_DNA:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('Could not verify the CLI wallet public address.');}assert.equal(wallet,originalWallet,'CLI funding wallet differs from the saved scope.');
  if(!solOnly){let tokenWallet:string;try{tokenWallet=JSON.parse(execFileSync('spl-token',['address','--output','json'],{env:{...process.env,NO_DNA:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe']})).walletAddress;}catch{throw Error('Could not verify SPL Token CLI public identity.');}assert.equal(tokenWallet,originalWallet,'Token CLI wallet differs; no funding started.');}
  // This run is authorized by the active user request to finish Devnet tests.
  // The exact public scope is persisted before the original CLI signs anything.
  this.fundingReview.authorized=true;this.fundingReview.authorizationScope='Active thread request for current-source Devnet deployment and complete dual-asset transaction acceptance';const fundingPath=join(fundingDirectory,'review.json');await writeFile(fundingPath,json(this.fundingReview),{mode:0o600});
  this.businessReview={...(solOnly?{assetMode:'SOL'}:{}),authorized:true,network:'devnet',genesisHash:genesis,rpc:'https://api.devnet.solana.com',program:String(sdk.PROGRAM_ADDRESS),feePayer:this.signers.payer.address,fundingWallet:originalWallet,recipients:{workerOwner:this.signers.workerOwner.address,judgeOwner:this.signers.judgeOwner.address,provider:this.signers.provider.address},maximumTransactions:50,maximumNetworkFeeLamports:10000,binarySha256:this.deployment.deployment.binarySha256,evidenceDirectory:this.evidenceDirectory};
  const businessPath=join(this.evidenceDirectory,'business-review.json');await writeFile(businessPath,json(this.businessReview),{mode:0o600});
  const relay=await this.launch('business-rpc',process.execPath,['scripts/devnet-workflow-rpc.mjs','--serve'],{...this.proxyEnvironment(),AGENTOS_DEVNET_WORKFLOW_REVIEW:businessPath});await this.ready(relay,this.rpcUrl);this.businessReady=true;
  const funding=await this.launch('funding-rpc',process.execPath,['scripts/devnet-workflow-funding-rpc.mjs','--serve'],{...this.proxyEnvironment(),AGENTOS_WORKFLOW_FUNDING_REVIEW:fundingPath});await this.ready(funding,'http://127.0.0.1:18894');
  for(const step of workflowFundingCliSteps(this.fundingReview))await this.cliStep(step.phase,step.command,step.args);
  const original=await this.records(join(fundingDirectory,'funding-submissions.jsonl'));for(const row of original.filter(row=>row.transactionSha256))await this.finalized(row.signature);
  this.initialSol=await this.sol(this.signers.payer.address);assert.equal(this.initialSol,300000000n);if(!solOnly){assert.equal(await this.usdc(String(this.signers.payer.address)),10000n);assert.equal(await this.usdc(String(this.signers.workerOwner.address)),200000n);}
  process.env.AGENTOS_CLUSTER='devnet';process.env.AGENTOS_LOCALNET_GENESIS_HASH='';process.env.SOLANA_RPC_URL=this.rpcUrl;process.env.AGENTOS_PROGRAM_ID=String(sdk.PROGRAM_ADDRESS);process.env.AGENTOS_DATA_DIR=join(this.root,'runtime-data');
  process.env.AGENTOS_TENANT_CREDENTIAL_DATABASE='';process.env.AGENTOS_PERSIST_MEMORY='true';process.env.AGENTOS_PERSIST_HISTORY='true';process.env.AGENTOS_WORKER_AUTORUN='';process.env.AGENTOS_STORAGE_BACKEND='json';
 }
 private async cliStep(phase:string,command:string,args:string[]){
  console.log(JSON.stringify({phase:'fixed-workflow-funding',assetPhase:phase,rawCliOutputSuppressed:true}));
  const child=spawn(command,args,{env:{...process.env,NO_DNA:'1',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']});this.processes.push(child);child.stdout?.resume();child.stderr?.resume();
  const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);try{const [code]=await once(child,'exit');assert.equal(code,0,'Original CLI funding failed; inspect its public journal, do not replace its wire.');}finally{clearTimeout(timeout);}
 }
 async finalized(signature:string){
  for(let n=0;n<120;n++){const response=await this.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);if(response){assert.equal(response.meta.err,null,'Original transaction finalized with a failure.');return response;}await pause(1000);}
  throw Error('Original finalized transaction is unavailable; preserve its signed wire.');
 }
 async runtime(){
  const child=await this.launch(`runtime-${++this.runtimeGeneration}`,process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{PORT:'19787',AGENTOS_WEB_ORIGINS:'http://127.0.0.1:15173',AGENTOS_PERSIST_ESCROW_HANDOFFS:'true'});this.runtimeProcess=child;
  for(let n=0;n<120;n++){try{const health=await this.api('/api/health');assert.equal(health.network,'devnet-preview');return child;}catch(error){if(exited(child)||n===119)throw error;await pause(500);}}throw Error('Devnet Runtime did not start.');
 }
 async tx(name:string,instructions:Instruction[],signers:KeyPairSigner[]=[],expectError?:string,feePayer:KeyPairSigner=this.signers.payer){
  assert.equal(this.approved,true);assert.ok(this.sent<50);assert.ok(this.initialSol-await this.sol(String(this.signers.payer.address))<300000000n);
  const message=await this.message(instructions,signers,feePayer),unsigned=getBase64EncodedWireTransaction(compileTransaction(message)),preflight=(await this.rpc('simulateTransaction',[unsigned,{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
  if(expectError){assert.notEqual(preflight.err,null);assert.ok(preflight.logs.some((line:string)=>line.includes(expectError)));return '';}
  assert.equal(preflight.err,null,'Unsigned Devnet setup simulation failed.');const fee=(await this.rpc('getFeeForMessage',[Buffer.from(compileTransaction(message).messageBytes).toString('base64'),{commitment:'confirmed'}])).value;assert.ok(Number.isSafeInteger(fee)&&fee>0&&fee<=10000);
  const signed=await signTransactionMessageWithSigners(message),wire=getBase64EncodedWireTransaction(signed),signature=String(getSignatureFromTransaction(signed));this.sent++;
  const acknowledged=await this.rpc('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);assert.equal(acknowledged,signature);this.transactions.push({name,signature,confirmed:false});
  for(let n=0;n<120;n++){const status=(await this.rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value[0];if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){assert.equal(status.err,null);this.transactions[this.transactions.length-1]={name,signature,confirmed:true};return signature;}await pause(500);}
  throw Error('Original Devnet transaction confirmation is unknown; do not re-sign.');
 }
 private async records(file:string){try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as any).code==='ENOENT')return [];throw error;}}
 async captureAllTransactions({requireComplete=true}={}){
  assert.ok(this.businessReady);const fundingRows=await this.records(join(this.evidenceDirectory,'funding','funding-submissions.jsonl')),businessRows=await this.records(join(this.evidenceDirectory,'business-submissions.jsonl')),verified:any[]=[],unknown:string[]=[];
  for(const [kind,rows] of [['funding',fundingRows],['business',businessRows]] as const)for(const row of rows.filter(row=>row.transactionSha256)){
   const checked=kind==='funding'?await inspectWorkflowFunding(row.wire,this.fundingReview):await inspectWorkflowTransaction(row.wire,this.businessReview);assert.equal(checked.transactionSha256,row.transactionSha256);assert.equal(checked.signature,row.signature);
   if(requireComplete)await this.finalized(row.signature);else{const value=await this.rpc('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);if(!value){unknown.push(row.signature);continue;}}
   const path=join(this.evidenceDirectory,'all-transactions',row.signature+'.json'),bytes=await readFile(path),payload=parseDeploymentRpc(bytes),tx=payload.result;assert.equal(tx.transaction[1],'base64');assert.equal(tx.transaction[0],row.wire);assert.equal(tx.meta.fee,row.feeLamports);assert.ok(Number.isSafeInteger(tx.slot));
   verified.push({kind,signature:row.signature,slot:tx.slot,successful:tx.meta.err===null,feeLamports:tx.meta.fee,rawSha256:hex(digest(bytes)),transactionSha256:row.transactionSha256});
  }
  const expectedFunding=this.fundingReview.assetMode==='SOL'?1:3,expectedBusiness=this.fundingReview.assetMode==='SOL'?39:41;
  const complete=unknown.length===0&&verified.every(row=>row.successful)&&verified.filter(row=>row.kind==='funding').length===expectedFunding&&verified.filter(row=>row.kind==='business').length===expectedBusiness&&new Set(verified.map(row=>row.signature)).size===expectedFunding+expectedBusiness;
  const report={format:'agentos-devnet-role-transactions',version:1,assetMode:this.fundingReview.assetMode??'SOL/USDC',status:complete?'complete':'incomplete',genesisHash:genesis,program:String(sdk.PROGRAM_ADDRESS),transactions:verified,unknown};await writeFile(join(this.evidenceDirectory,'all-transactions-report.json'),json(report),{mode:0o600});if(requireComplete)assert.ok(complete,'All original Devnet funding and business transactions required.');return report;
 }
 async finish(error?:unknown){
  await writeFile(join(this.root,'report.json'),json({format:'agentos-devnet-integration',version:1,passed:!error,checkedAt:new Date().toISOString(),genesis:this.genesis,rpc:this.rpcUrl,program:String(sdk.PROGRAM_ADDRESS),transactions:this.transactions,tests:this.tests,error:error?String(error):null,scope:'Actual official Devnet, explicit reviewed assets and in-memory test role signers. No production Vault claim.',evidenceDirectory:this.evidenceDirectory}),{mode:0o600});
  for(const child of this.processes.reverse())if(!exited(child)){child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(3000)]);if(!exited(child))child.kill('SIGKILL');}
 }
}
