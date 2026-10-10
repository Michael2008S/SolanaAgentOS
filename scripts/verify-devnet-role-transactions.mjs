import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {getAddressDecoder} from '@solana/kit';
import {inspectWorkflowFunding,validateWorkflowFundingRecords} from './devnet-workflow-funding.mjs';
import {inspectWorkflowTransaction} from './devnet-workflow-rpc.mjs';
import {verifyFundingReview} from './devnet-workflow-funding-rpc.mjs';
import {parseDeploymentRpc} from './devnet-deployment-guard.mjs';
import {buildInputFiles} from './build-inputs.mjs';
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',loader='BPFLoaderUpgradeab1e11111111111111111111111';

/** Additional Devnet gate; the existing role verifier still proves exact Task,
 * Worker source, Judge, settlement and completion commitments independently. */
export async function verifyDevnetRoleTransactions(directory,roleReport){
 requireThat(roleReport.network==='devnet'&&roleReport.genesis===genesis&&roleReport.plan?.network==='devnet','Full official Devnet identity required.');
 const read=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
 const manifest=await read('all-transactions-report.json'),fundingReview=await read('funding/review.json'),businessReview=await read('business-review.json');
 const solOnly=roleReport.assetMode==='SOL',businessCount=solOnly?39:41,fundingCount=solOnly?1:3,total=businessCount+fundingCount;verifyFundingReview(fundingReview);requireThat((fundingReview.assetMode==='SOL')===solOnly&&(businessReview.assetMode==='SOL')===solOnly,'Reviewed asset mode differs.');if(solOnly)requireThat(roleReport.plan.actions.length===2&&roleReport.plan.actions.every(row=>row.asset==='SOL'&&row.amount==='1000000')&&roleReport.toolProfiles.every(profile=>profile.tools.every(tool=>tool.request.asset==='SOL')),'SOL-only acceptance cannot contain USDC effects.');
 requireThat(manifest.format==='agentos-devnet-role-transactions'&&manifest.version===1&&manifest.status==='complete'&&manifest.genesisHash===genesis&&manifest.program===roleReport.program&&manifest.unknown.length===0&&manifest.transactions.length===total,'Complete original 44-transaction Devnet manifest required.');
 requireThat(fundingReview.recipients.payer===businessReview.feePayer&&fundingReview.recipients.workerOwner===businessReview.recipients.workerOwner&&fundingReview.fundingWallet===businessReview.fundingWallet,'Original funding and business payer differ.');
 const deployment=await read('deployment/report.json'),rpc=await read('deployment/rpc-evidence.json');
 requireThat(deployment.status==='deployment-verified-workflows-pending'&&deployment.errors.length===0&&deployment.deployment.programId===roleReport.program&&deployment.network==='devnet'&&rpc.network.actualGenesisHash===genesis,'Original current-source deployment proof required.');
 const program=rpc.accounts[roleReport.program]?.value;requireThat(program?.owner===loader&&program.executable&&program.data[1]==='base64','Original executable Program proof differs.');
 const programBytes=Buffer.from(program.data[0],'base64');requireThat(programBytes.length===36&&programBytes.readUInt32LE(0)===2,'Original Program layout differs.');const dataAddress=getAddressDecoder().decode(programBytes.subarray(4,36)),programData=rpc.accounts[dataAddress]?.value;
 requireThat(dataAddress===deployment.deployment.programData&&programData?.owner===loader&&!programData.executable&&programData.data[1]==='base64','Original ProgramData proof differs.');
 const bytes=Buffer.from(programData.data[0],'base64'),binaryBytes=deployment.deployment.binaryBytes;requireThat(bytes.length>=45+binaryBytes&&bytes.readUInt32LE(0)===3&&hash(bytes.subarray(45,45+binaryBytes))===deployment.deployment.binarySha256&&bytes.subarray(45+binaryBytes).every(byte=>byte===0)&&businessReview.binarySha256===deployment.deployment.binarySha256,'Deployed binary proof changed.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),inputs=await buildInputFiles(root),build=deployment.localBuild,binary=await readFile(join(root,'target/sbf-safe/agent_os.so'));requireThat(binary.length===binaryBytes&&hash(binary)===deployment.deployment.binarySha256&&build.status==='built'&&build.binarySha256===deployment.deployment.binarySha256&&JSON.stringify(Object.keys(build.inputHashes).sort())===JSON.stringify(inputs),'Current build provenance differs.');for(const file of inputs)requireThat(hash(await readFile(join(root,file)))===build.inputHashes[file],'Current Rust source differs from deployed proof.');
 const rows=async file=>(await readFile(join(directory,file),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),fundingRows=await rows('funding/funding-submissions.jsonl'),businessRows=await rows('business-submissions.jsonl');
 await validateWorkflowFundingRecords(fundingReview,fundingRows);
 const original=new Map();for(const [kind,records] of [['funding',fundingRows],['business',businessRows]])for(const record of records.filter(row=>row.transactionSha256)){requireThat(!original.has(record.signature),'Duplicate original transaction.');original.set(record.signature,{kind,record});}
 requireThat(original.size===total&&new Set(manifest.transactions.map(row=>row.signature)).size===total,'Original public journal and manifest counts differ.');
 const expectedBusiness=new Set(roleReport.transactions.map(row=>row.signature));for(const [role,rows] of Object.entries(roleReport.receipts))for(const row of Array.isArray(rows)?rows:[rows])expectedBusiness.add(row.receipt.signature);for(const row of roleReport.toolReceipts){expectedBusiness.add(row.receipt.paymentSignature);expectedBusiness.add(row.receipt.resultSignature);}
 requireThat(expectedBusiness.size===businessCount,'Full native role report must describe all 41 distinct business sends.');
 let fees=0,business=0,funding=0;
 for(const row of manifest.transactions){
  const entry=original.get(row.signature);requireThat(entry&&entry.kind===row.kind&&row.successful===true,'Manifest outcome differs from original reservation.');const record=entry.record,checked=row.kind==='funding'?await inspectWorkflowFunding(record.wire,fundingReview):await inspectWorkflowTransaction(record.wire,businessReview);
  requireThat(checked.signature===row.signature&&checked.transactionSha256===row.transactionSha256&&checked.transactionSha256===record.transactionSha256,'Original signed transaction commitment differs.');
  const raw=await readFile(join(directory,'all-transactions',row.signature+'.json'));requireThat(hash(raw)===row.rawSha256,'Original raw transaction receipt changed.');const payload=parseDeploymentRpc(raw),tx=payload.result;
  requireThat(!payload.error&&tx?.meta?.err===null&&tx.transaction[1]==='base64'&&tx.transaction[0]===record.wire&&Number.isSafeInteger(tx.slot)&&tx.slot===row.slot&&tx.meta.fee===record.feeLamports&&tx.meta.fee===row.feeLamports&&Number.isSafeInteger(tx.meta.fee)&&tx.meta.fee>0&&tx.meta.fee<=10000,'Finalized receipt does not match original reviewed wire or fee.');
  fees+=tx.meta.fee;if(row.kind==='business'){requireThat(expectedBusiness.has(row.signature),'Unexpected business send.');business++;}else{requireThat(row.kind==='funding','Unknown transaction category.');funding++;}
 }
 requireThat(business===businessCount&&funding===fundingCount&&fees<=530000,'Complete Devnet funding/business counts or network fee cap differ.');
 return {status:'passed',network:'devnet',assetMode:solOnly?'SOL':'SOL/USDC',fundingTransactionsVerified:funding,businessTransactionsVerified:business,currentSourceDeploymentVerified:true,allOriginalRawReceiptsVerified:true,totalNetworkFeeLamports:fees};
}
