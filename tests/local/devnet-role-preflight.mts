import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DevnetHarness} from './devnet-harness.mts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw Error('Use --run for the read-only Devnet role preflight.');
const directory=resolve('docs/evidence/devnet-role-preflight-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const quota='docs/evidence/deepseek-goal-20261009-quota.json',before=await readFile(quota,'utf8'),h=new DevnetHarness(directory);let error:unknown;
const report:any={format:'agentos-devnet-role-preflight',version:1,status:'running',scope:'Read-only current-source deployment and real funding preflight; no CLI wallet signing, model dispatch, role service or transaction.',transactionsSent:0,modelRequests:0,recipientKeysDiscarded:true};
try{
 await h.start({solOnly:true,preflightOnly:true});assert.equal(await readFile(quota,'utf8'),before);assert.equal(h.transactions.length,0);assert.equal(h.businessReady,false);assert.equal(h.fundingReview.authorized,false);
 Object.assign(report,{status:h.preflight.fundsAvailable?'funds-available-workflow-not-run':'funding-required',deploymentVerified:true,genesis:h.genesis,funding:h.preflight,modelQuotaUnchanged:true});if(!h.preflight.fundsAvailable)process.exitCode=2;
}catch(cause){error=cause;report.status='failed';report.error=cause instanceof Error?cause.message:String(cause);process.exitCode=1;}
finally{await h.finish(error);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:report.status,evidence:directory,transactionsSent:0,modelRequests:0}));}
