import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputFiles } from './build-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const out = path.join(root, 'target/sbf-safe');
const manifestPath = path.join(out, 'build-manifest.json');
const sources = await buildInputFiles(root);
const inputHashes = Object.fromEntries(await Promise.all(sources.map(async (name) => [name, hash(await readFile(path.join(root, name)))])));
const source = await readFile(path.join(root, 'programs/agent_os/src/lib.rs'), 'utf8');
const programId = source.match(/declare_id!\("([^"]+)"\)/)?.[1];
// Use the existing Program signer through the CLI; never load or print its secret.
const existingId = execFileSync('solana-keygen', ['pubkey', path.join(out, 'agent_os-keypair.json')], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_DNA: '1' } }).trim();
if (existingId !== programId) throw new Error('Existing Program keypair public address does not match declare_id!.');
const tools = process.env.AGENTOS_SBF_TOOLS_VERSION ?? 'v1.57';
if (!/^v\d+\.\d+$/.test(tools)) throw new Error('Invalid SBF tools version.');
const toolchain = process.env.AGENTOS_SBF_RUST_TOOLCHAIN ?? `1.95.0-sbpf-solana-${tools}`;
const rustc = execFileSync('rustup', ['which', 'rustc', '--toolchain', toolchain], { cwd: root, encoding: 'utf8' }).trim();
const args = ['build-sbf', '--manifest-path', 'programs/agent_os/Cargo.toml', '--tools-version', tools, '--skip-tools-install', '--no-rustup-override', '--sbf-out-dir', out];
const build = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000, env: { ...process.env, NO_DNA: '1', RUSTC: rustc } });
const log = String(build.stdout ?? '') + String(build.stderr ?? '');
await writeFile(path.join(out, 'build.log'), log, { mode: 0o600 });
const diagnosticsFailed = build.status !== 0 || /Stack offset of .+ exceeded|Error:.*stack|^error[\[:]/im.test(log);
for (const [name, expected] of Object.entries(inputHashes)) {
  if (hash(await readFile(path.join(root, name))) !== expected) throw new Error('Sources changed during build. Rebuild before collecting evidence.');
}
if (JSON.stringify(await buildInputFiles(root)) !== JSON.stringify(sources)) throw new Error('Program source files changed during build. Rebuild before collecting evidence.');
const binary = await readFile(path.join(out, 'agent_os.so'));
const manifest = { format: 'agentos-sbf-build', version: 1, status: diagnosticsFailed ? 'failed' : 'built', builtAt: new Date().toISOString(), programId, inputHashes, binarySha256: hash(binary), binaryBytes: binary.length, toolsVersion: tools, rustToolchain: toolchain, logSha256: hash(log), warnings: /not known syscalls/.test(log) ? ['SDK reports unrecognized syscalls; deployment and executed transaction verification are still required.'] : [] };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
if (diagnosticsFailed) throw new Error('Build diagnostics include errors. This artifact cannot be used as deployment evidence.');
console.log(`Built ${programId}\nBinary SHA-256: ${manifest.binarySha256}\nManifest: ${manifestPath}`);
for (const warning of manifest.warnings) console.warn(warning);
