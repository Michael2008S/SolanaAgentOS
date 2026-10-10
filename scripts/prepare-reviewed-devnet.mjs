import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {buildInputFiles} from './build-inputs.mjs';

if(process.argv.length!==3||process.argv[2]!=='--authorize')throw new Error('Use --authorize only for an explicitly requested Devnet deployment.');
const manifest=JSON.parse(await readFile('target/sbf-safe/build-manifest.json','utf8'));
assert.equal(manifest.status,'built');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(Object.keys(manifest.inputHashes).sort(),await buildInputFiles(process.cwd()));
for(const [path,expected] of Object.entries(manifest.inputHashes))assert.equal(hash(await readFile(path)),expected);
const binary='target/sbf-safe/agent_os.so';assert.equal(hash(await readFile(binary)),manifest.binarySha256);
const payer=execFileSync('solana',['address'],{encoding:'utf8',env:{...process.env,NO_DNA:'1'}}).trim();
assert.equal(payer,'88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4');
const rpc=async(method,params=[])=>{
 const response=await fetch('https://api.devnet.solana.com',{method:'POST',headers:{'content-type':'application/json'},redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
 assert.ok(response.ok);const data=await response.json();assert.ok(!data.error);return data.result;
};
const genesisHash=await rpc('getGenesisHash');assert.equal(genesisHash,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
assert.equal((await rpc('getAccountInfo',[manifest.programId,{commitment:'finalized'}])).value,null,'Existing deployments require a separate upgrade review.');
const [programLamports,programDataLamports,temporaryBufferLamports]=await Promise.all([36,manifest.binaryBytes+45,manifest.binaryBytes+45].map(bytes=>rpc('getMinimumBalanceForRentExemption',[bytes])));
const balance=(await rpc('getBalance',[payer,{commitment:'finalized'}])).value;
// Solana CLI funds its Buffer at ProgramData rent so the same funds can be used at deploy.
const peak=programLamports+programDataLamports+temporaryBufferLamports;
assert.ok(peak<16_000_000_000&&balance>peak+100_000_000,'Deployment exceeds bounded Devnet funding scope.');
const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
const evidenceDirectory='docs/evidence/devnet-deployment-'+timestamp;await mkdir(evidenceDirectory,{mode:0o700});
const review={format:'agentos-devnet-deployment-review',version:1,preparedAt:new Date().toISOString(),authorized:true,authorizationBasis:'User explicitly requested current-source Devnet deployment and complete transaction evidence in this goal.',network:'devnet',genesisHash,rpc:'https://api.devnet.solana.com',feePayer:payer,upgradeAuthority:payer,program:manifest.programId,binary,binaryBytes:manifest.binaryBytes,binarySha256:manifest.binarySha256,maxProgramBytes:manifest.binaryBytes,currentBalanceLamports:String(balance),rent:{programLamports:String(programLamports),programDataLamports:String(programDataLamports),temporaryBufferLamports:String(temporaryBufferLamports),peakLamports:String(peak)},limits:{maximumTransactions:3000,networkFeePerTransactionLamports:'10000',totalNetworkFeeLamports:'30000000',totalTemporaryRentAndProgramDepositLamports:String(peak)},evidenceDirectory,conditions:['Devnet only; original Program and wallet authority.','Inspect and simulate every original transaction; preserve all public receipts.','Never suppress preflight, finalize authority, or expose signing secrets.']};
const path=evidenceDirectory+'/review.json';await writeFile(path,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({review:path,program:review.program,binarySha256:review.binarySha256,binaryBytes:review.binaryBytes,peakRentLamports:String(peak),balanceLamports:String(balance)}));
