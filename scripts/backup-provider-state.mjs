import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--providers-stopped' || args[1] !== '--output' || args[2].startsWith('--')) throw new Error('Stop both local Providers, then use --providers-stopped --output /new/backup/directory.');
const output = resolve(args[2]);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value);
const files = []; let total = 0;
for (const namespace of ['weather', 'research']) {
  for (const kind of ['claims', 'results']) {
    const directory = `${namespace}-${kind}`;
    const source = resolve(root, 'apps/runtime/.data', directory);
    let names = [];
    try { const stat = await lstat(source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Provider directory.'); names = await readdir(source); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (names.length > 10000) throw new Error('Provider directory exceeds 10,000 files.');
    await mkdir(resolve(output, directory), { mode: 0o700 });
    for (const name of names.sort()) {
      if (!(kind === 'claims' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}-[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/).test(name)) throw new Error('Unexpected Provider file; preserve separately.');
      const path = resolve(source, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 500000 || (total += stat.size) > 200000000) throw new Error('Provider backup type or size limit exceeded.');
      const bytes = await readFile(path);
      if (bytes.length !== stat.size) throw new Error('Provider file changed while copying.');
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (kind === 'claims') {
        if (!address(body.execution) || name !== `${body.execution}.json` || !signature(body.signature) || typeof body.claimedAt !== 'string' || !Number.isFinite(Date.parse(body.claimedAt))) throw new Error('Invalid Provider claim.');
      } else {
        const c = body.context;
        if (body.version !== 1 || !c || ![c.programId,c.execution,c.agent,c.skill,c.provider].every(address) || name !== `${c.programId}-${c.execution}.json` || !signature(c.signature) || !['SOL','USDC'].includes(c.asset) || typeof c.amount !== 'string' || !/^[1-9][0-9]{0,19}$/.test(c.amount) || BigInt(c.amount) > 18446744073709551615n || typeof c.resourceUrl !== 'string' || !/^[a-f0-9]{64}$/.test(c.inputHash) || typeof body.body !== 'string' || Buffer.byteLength(body.body) > 65536 || digest(Buffer.from(body.body)) !== body.outputHash || !['application/json; charset=utf-8','text/plain; charset=utf-8'].includes(body.contentType) || !Number.isFinite(Date.parse(body.savedAt))) throw new Error('Invalid Provider result or output hash.');
      }
      const destination = resolve(output, directory, name), file = await open(destination, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      files.push({ path: `${directory}/${name}`, bytes: bytes.length, sha256: digest(bytes) });
    }
    const dir = await open(resolve(output, directory), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
}
const manifest = { format: 'agentos-provider-backup', version: 1, createdAt: new Date().toISOString(), files,
  limitations: ['Operator must keep both Providers stopped during capture.', 'Claims without saved results may be interrupted; never clear claims to replay a paid request.', 'Local state hashes do not verify on-chain payments or model execution.', 'Restore claim and result directories together; no signers or API keys included.'] };
const text = JSON.stringify(manifest, null, 2), file = await open(resolve(output, 'manifest.json'), 'wx', 0o600);
try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
const dir = await open(output, 'r'); try { await dir.sync(); } finally { await dir.close(); }
console.log(JSON.stringify({ output, files: files.length, bytes: total, manifestSha256: digest(Buffer.from(text)) }, null, 2));
