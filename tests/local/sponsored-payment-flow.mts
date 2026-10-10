import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { address,getTransactionDecoder,getBase64EncodedWireTransaction,getBase58Decoder,type SignatureBytes } from '@solana/kit';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { parseAutonomousJob } from '../../apps/runtime/src/autonomous-loop.ts';
import { prepareSponsoredServicePayment } from '../../apps/runtime/src/sponsored-service-payment.ts';
import { verifySponsoredSettlement } from '../../apps/runtime/src/standard-settlement.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for isolated sponsored payment acceptance.');
const h=new LocalHarness(),directory=resolve('docs/evidence/sponsored-payment-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const report:any={status:'running',network:'isolated-localnet',limitations:['Validates the transaction primitive with a local sponsor; does not yet validate a remote HTTP facilitator or autonomous x402 integration.'],transactions:[]};
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8');let sends=0,signs=0;
try{
 await h.start();h.approved=true;const original=h.rpc.bind(h);h.rpc=async(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=7);return original(method,params);};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session,provider}=h.signers;
 const init=await sdk.buildInitializeAgent(payer.address,'Sponsored payment primitive',0.001,0.001,0.001,0.001,['api','payment']),agent=init.accounts;
 const delegated=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api','payment']);
 await h.tx('initialize sponsored Agent',[init.instruction]);await h.tx('fund USDC Vault',[await sdk.buildDepositUsdc(payer.address,agent.agent,'0.001')]);await h.tx('create service Session',[delegated.instruction]);
 await h.tx('fund client rent reserve',[sdk.buildFundSessionFeeReserve(payer.address,session.address,0.01)]);await h.tx('fund fee-only merchant sponsor',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.01)]);
 const endpoint='http://127.0.0.1:19795/public',intentId=randomUUID(),action={key:hex(digest('sponsored-fixture')),tool:'http:sponsored-fixture',asset:'USDC',amount:'1000',input:'{"question":"public"}'};
 const job=parseAutonomousJob({version:1,id:randomUUID(),tenant:'owner',goal:'Verify a public sponsored USDC request.',agent:agent.agent,session:delegated.session,program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,state:'executing',limits:{sol:'0',usdc:'1000',maxCycles:1,maxActions:1,maxModelRequests:1,deadline:Math.floor(Date.now()/1000)+600,tools:[action.tool]},spent:{sol:'0',usdc:'1000'},cycle:1,modelRequests:0,intents:[{id:intentId,action,phase:'reserved',executionId:'0'}],pending:[],evaluations:[]});
 const accepted={scheme:'exact',network:`solana:${h.genesis.slice(0,32)}`,amount:'1000',asset:sdk.DEVNET_USDC_MINT,payTo:provider.address,maxTimeoutSeconds:60,extra:{feePayer:provider.address}};
 const challenge={protocol:'x402',required:{x402Version:2,resource:{url:endpoint},accepts:[accepted]},accepted} as const;
 const signer={address:session.address,signTransactions:async(...args:Parameters<typeof session.signTransactions>)=>{signs++;return session.signTransactions(...args);}};
 const args={job,action:job.intents[0].action,intentId,signer,resultFeePayer:payer.address,recipient:provider.address,endpoint,challenge:challenge as any,rpc:h.rpc.bind(h)};
 await assert.rejects(prepareSponsoredServicePayment({...args,challenge:{...challenge,accepted:{...accepted,amount:'1001'}} as any}),/fixed chain/);assert.equal(signs,0);
 const beforeClient=await h.sol(session.address),beforeSponsor=await h.sol(provider.address),prepared=await prepareSponsoredServicePayment(args);assert.equal(signs,1);assert.match(prepared.memo,/^[a-f0-9]{32}$/);
 await writeFile(join(directory,'original-partial.json'),JSON.stringify({job,action:job.intents[0].action,intentId,endpoint,recipient:provider.address,sessionKey:session.address,feePayer:payer.address,partialWire:prepared.wire,memo:prepared.memo,sponsor:prepared.sponsor},null,2)+'\n');
 // Durable PUBLIC wire is saved before the sponsor can add a signature or send.
 const decoded=getTransactionDecoder().decode(Buffer.from(prepared.wire,'base64'));assert.equal(decoded.signatures[provider.address],null);
 const sponsorSignature=new Uint8Array(await crypto.subtle.sign('Ed25519',provider.keyPair.privateKey,new Uint8Array(decoded.messageBytes))) as SignatureBytes;
 const wire=getBase64EncodedWireTransaction({...decoded,signatures:{...decoded.signatures,[provider.address]:sponsorSignature}}),signature=getBase58Decoder().decode(sponsorSignature);
 assert.equal((await h.rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}])).value.err,null);
 assert.equal(await h.rpc('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:30}]),signature);
 for(let n=0;n<200;n++){const status=(await h.rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value[0];assert.equal(status?.err??null,null);if(status?.confirmationStatus==='finalized')break;if(n===199)throw new Error('Original sponsored payment did not finalize.');await new Promise(resolve=>setTimeout(resolve,200));}
 const settlement=await verifySponsoredSettlement({rpc:h.rpc.bind(h),genesis:h.genesis,signature,partialWire:prepared.wire,sponsor:provider.address,clientSigners:[session.address],allowedSponsorAccounts:[{instruction:0,account:7}]});
 assert.equal(beforeSponsor-await h.sol(provider.address),BigInt(settlement.meta.fee));assert.ok(beforeClient>await h.sol(session.address));
 assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(agent.agent)])).value.amount,'0');assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(provider.address)])).value.amount,'1000');
 const content='Public sponsored response',scope=prepared.scope;
 const resultSignature=await h.tx('record original sponsored response',[{programAddress:sdk.PROGRAM_ADDRESS,accounts:scope.resultAccounts.map((key,index)=>({address:address(key),role:[2,3,0,0,1][index]})),data:scope.resultData(content)}],[session]);
 for(let n=0;n<200;n++){const status=(await h.rpc('getSignatureStatuses',[[resultSignature],{searchTransactionHistory:true}])).value[0];assert.equal(status?.err??null,null);if(status?.confirmationStatus==='finalized')break;if(n===199)throw new Error('Original sponsored result did not finalize.');await new Promise(resolve=>setTimeout(resolve,200));}
 assert.equal(sends,7);assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 const rpcOutput=JSON.stringify({jsonrpc:'2.0',result:settlement},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),rpcOutput);report.transactions.push({signature,sha256:hex(digest(rpcOutput)),fee:settlement.meta.fee});
 Object.assign(report,{status:'passed',paymentSignature:signature,resultSignature,clientSigningRequests:signs,totalTransactions:sends,sponsorOnlyPaidNetworkFee:true,realModelQuotaUnchanged:true,wrongQuoteRejectedBeforeSigning:true,originalWirePersistedBeforeSponsor:true,content});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 for(const item of h.transactions as {signature:string}[]){try{const tx=await h.rpc('getTransaction',[item.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(tx){const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,item.signature+'.json'),raw);report.transactions.push({signature:item.signature,sha256:hex(digest(raw)),fee:tx.meta.fee});}}catch{}}
 report.totalTransactions=sends;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');if(h.root)await h.finish(report.status==='passed'?undefined:'Sponsored payment acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}
