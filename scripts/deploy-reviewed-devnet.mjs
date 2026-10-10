import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildInputFiles } from './build-inputs.mjs';
const review = JSON.parse(await readFile(process.env.AGENTOS_DEPLOYMENT_REVIEW || 'docs/evidence/devnet-goal-20261009-deployment-review.json', 'utf8'));
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const recovery = process.argv.length === 3 && process.argv[2] === '--recover-buffer';
const resume = process.argv.length === 3 && process.argv[2] === '--resume';
requireThat((process.argv.length === 2 || recovery || resume) && review.authorized === true, 'An authorized deployment review is required.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile('target/sbf-safe/build-manifest.json', 'utf8'));
requireThat(manifest.programId === review.program && manifest.binarySha256 === review.binarySha256 && manifest.binaryBytes === review.binaryBytes, 'Build manifest differs from review.');
requireThat(JSON.stringify(await buildInputFiles(process.cwd())) === JSON.stringify(Object.keys(manifest.inputHashes).sort()), 'Build input coverage changed.');
for (const filename of await buildInputFiles(process.cwd())) requireThat(digest(await readFile(filename)) === manifest.inputHashes[filename], 'Program sources changed after review.');
requireThat(digest(await readFile(review.binary)) === review.binarySha256, 'Reviewed executable changed.');
const env = { ...process.env, NO_DNA: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
let publicPayer;
try { publicPayer = execFileSync('solana', ['address'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
catch { throw new Error('Could not verify the configured CLI wallet public address.'); }
requireThat(publicPayer === review.feePayer && publicPayer === review.upgradeAuthority, 'CLI wallet differs from authorized payer/authority.');
if (!recovery) {
 let publicProgram;
 try { publicProgram = execFileSync('solana', ['address', '-k', 'target/sbf-safe/agent_os-keypair.json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
 catch { throw new Error('Could not verify the existing Program signer public address.'); }
 requireThat(publicProgram === review.program, 'Program signer differs from the authorized deployment target.');
}
let args = ['program', 'deploy', review.binary, '--url', 'http://127.0.0.1:18893', '--program-id', 'target/sbf-safe/agent_os-keypair.json', '--max-len', String(review.maxProgramBytes), '--max-sign-attempts', '100', '--no-auto-extend', '--use-rpc', '--commitment', 'confirmed', '--output', 'json'];
if (recovery || resume) {
 const rows = (await readFile((review.evidenceDirectory || 'docs/evidence/devnet-goal-20261009-deployment-transactions') + '/submissions.jsonl', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 const buffers = [...new Set(rows.flatMap(row => row.buffer ? [row.buffer] : []))];
 requireThat(buffers.length === 1 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(buffers[0]) && ![review.program, review.feePayer].includes(buffers[0]), 'Expected exactly the reviewed temporary buffer.');
 if(resume)args.push('--buffer',buffers[0]);
 else args = ['program', 'close', buffers[0], '--recipient', review.feePayer, '--url', 'http://127.0.0.1:18893', '--commitment', 'confirmed', '--output', 'json', '--bypass-warning'];
}
console.log(JSON.stringify({ phase: recovery ? 'recovering-reviewed-buffer' : 'deploying-reviewed-binary', program: review.program, binarySha256: review.binarySha256, rpcGuard: 'http://127.0.0.1:18893', privateOutputSuppressed: true }));
const child = spawn('solana', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
// The CLI can print a temporary recovery phrase on failure. Never persist or
// forward its raw output; progress comes exclusively from the public RPC guard.
let diagnostic='unclassified-cli-failure',errorTokens=new Set(),diagnosticFlags=new Set(),cliErrorCode='',safeErrorWords=[],typedErrors=new Set();
const classify=chunk=>{const text=chunk.toString().replace(/\x1b\[[0-9;]*m/g,''); for(const token of text.match(/\b[A-Z][a-z]+(?:[A-Z][a-zA-Z]+)+\b/g)||[])if(token.length<=60)typedErrors.add(token); const safeWords=new Set('error invalid value argument file path url rpc program buffer signer keypair public key address length max len sign attempts failed parse number integer digit string unexpected configuration data account seed phrase validation missing not found cannot open read'.split(' '));safeErrorWords.push(...text.toLowerCase().split(/[^a-z]+/).filter(word=>safeWords.has(word)).slice(0,40));const errorCode=text.match(/Error: ([A-Z][A-Za-z0-9_]{1,60})(?=[\s(:,{]|$)/);if(errorCode)cliErrorCode=errorCode[1];for(const flag of text.match(/--[a-z][a-z-]+/g)||[])diagnosticFlags.add(flag);for(const word of ['RPC','request','connection','timeout','HTTP','invalid','account','feature','ELF','syscall','blockhash','No such file','Permission denied','OS error','transport','sbf','signature','payer','buffer','error'])if(text.toLowerCase().includes(word.toLowerCase()))errorTokens.add(word);};
child.stdout.on('data', classify); child.stderr.on('data', chunk => { classify(chunk); const text=chunk.toString();for(const [pattern,code] of [[/unexpected argument/i,'unsupported-cli-option'],[/ELF|syscall/i,'elf-or-syscall-validation'],[/RPC request error|Unreviewed RPC method/i,'rpc-request-rejected'],[/insufficient funds|balance/i,'balance-or-rent-check'],[/feature.*(inactive|not activated|not supported)/i,'cluster-feature-check']])if(pattern.test(text))diagnostic=code; });
child.on('error', () => { console.error('Could not start the Solana CLI.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { console.log(JSON.stringify({ phase: 'deployment-cli-ended', exitCode: code, signal, rawOutputSuppressed: true, ...(code===0?{}:{diagnostic,errorTokens:[...errorTokens],diagnosticFlags:[...diagnosticFlags],cliErrorCode,typedErrors:[...typedErrors],safeErrorWords:safeErrorWords.slice(0,60)}), next: code === 0 ? 'Independently verify ProgramData binary and finalized receipts.' : 'Inspect public guard journal and recover only the authorized temporary buffer if needed.' })); process.exitCode = code === 0 ? 0 : 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
