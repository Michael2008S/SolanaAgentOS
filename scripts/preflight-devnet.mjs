import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devnetGenesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const placeholderProgramId = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const errors = [];
const checks = [];

function report(label, ok, detail) {
  checks.push({ label, ok, detail });
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(match[1], value);
  }
  return values;
}

async function loadEnvFile(relativePath) {
  try {
    return parseEnv(await readFile(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
}

function configuredValue(name, fileValues, fallback = '') {
  return Object.hasOwn(process.env, name) ? process.env[name].trim() : (fileValues.get(name) ?? fallback).trim();
}

function parseAnchorProgram(toml, sectionName) {
  const sectionHeader = `[${sectionName}]`;
  const start = toml.indexOf(sectionHeader);
  if (start < 0) return '';
  const afterHeader = toml.slice(start + sectionHeader.length);
  const nextSection = afterHeader.search(/^\s*\[[^\]]+\]\s*$/m);
  const section = nextSection < 0 ? afterHeader : afterHeader.slice(0, nextSection);
  return section.match(/^\s*agent_os\s*=\s*"([^"]+)"/m)?.[1] ?? '';
}

async function rpc(endpoint, method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('response exceeded 64 KiB');
  const payload = JSON.parse(body);
  if (payload.error) throw new Error('RPC returned an error');
  return payload.result;
}

function safeEndpointLabel(endpoint) {
  return endpoint.protocol === 'https:' ? 'HTTPS endpoint' : 'HTTP endpoint';
}

try {
  const runtimeEnv = await loadEnvFile('apps/runtime/.env');
  const webEnv = await loadEnvFile('apps/web/.env.local');
  const [anchorToml, programSource] = await Promise.all([
    readFile(path.join(root, 'Anchor.toml'), 'utf8'),
    readFile(path.join(root, 'programs/agent_os/src/lib.rs'), 'utf8'),
  ]);

  const ids = {
    'Anchor.toml [programs.localnet]': parseAnchorProgram(anchorToml, 'programs.localnet'),
    'Anchor.toml [programs.devnet]': parseAnchorProgram(anchorToml, 'programs.devnet'),
    'declare_id!': programSource.match(/declare_id!\("([^"]+)"\)/)?.[1] ?? '',
    'apps/runtime/.env AGENTOS_PROGRAM_ID': configuredValue('AGENTOS_PROGRAM_ID', runtimeEnv),
    'apps/web/.env.local VITE_AGENTOS_PROGRAM_ID': configuredValue('VITE_AGENTOS_PROGRAM_ID', webEnv),
  };
  const expectedProgramId = ids['declare_id!'];
  let idsAreValid = Boolean(expectedProgramId && addressPattern.test(expectedProgramId));
  for (const [source, value] of Object.entries(ids)) {
    const valid = addressPattern.test(value);
    report(`${source} is configured`, valid, valid ? 'valid Solana address' : 'missing or invalid address');
    if (!valid) {
      errors.push(`${source} is missing or invalid. Set all app and Anchor program IDs to the deployed Devnet address.`);
      idsAreValid = false;
    } else if (value !== expectedProgramId) {
      report(`${source} matches declare_id!`, false, 'address differs');
      errors.push(`${source} does not match declare_id! in programs/agent_os/src/lib.rs.`);
      idsAreValid = false;
    }
  }
  if (expectedProgramId === placeholderProgramId) {
    report('Program ID is a deployed address', false, 'the repository still has its development placeholder');
    errors.push('The repository Program ID is still the development placeholder. Deploy with the intended Program keypair, then sync the ID.');
    idsAreValid = false;
  }

  const endpoints = [
    {
      name: 'Runtime',
      raw: configuredValue('SOLANA_RPC_URL', runtimeEnv, 'https://api.devnet.solana.com'),
      programId: ids['apps/runtime/.env AGENTOS_PROGRAM_ID'],
    },
    {
      name: 'Web',
      raw: configuredValue('VITE_SOLANA_RPC_URL', webEnv, 'https://api.devnet.solana.com'),
      programId: ids['apps/web/.env.local VITE_AGENTOS_PROGRAM_ID'],
    },
  ];

  for (const item of endpoints) {
    let endpoint;
    try {
      endpoint = new URL(item.raw);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
        throw new Error('Use an HTTP(S) RPC URL without embedded credentials or a URL fragment.');
      }
    } catch (error) {
      report(`${item.name} RPC URL`, false, error.message);
      errors.push(`${item.name} RPC URL is invalid.`);
      continue;
    }

    const endpointLabel = safeEndpointLabel(endpoint);
    try {
      const genesisHash = await rpc(endpoint, 'getGenesisHash');
      if (genesisHash !== devnetGenesisHash) {
        report(`${item.name} RPC is Devnet`, false, `cluster identity mismatch at ${endpointLabel}`);
        errors.push(`${item.name} RPC does not identify as Solana Devnet.`);
        continue;
      }
      report(`${item.name} RPC is Devnet`, true, endpointLabel);

      if (idsAreValid) {
        const account = await rpc(endpoint, 'getAccountInfo', [item.programId, { encoding: 'base64', commitment: 'confirmed' }]);
        const info = account?.value;
        const executable = info?.executable === true;
        report(`${item.name} Program is deployed`, executable, executable ? `executable account; loader ${info.owner}` : 'account is missing or is not executable');
        if (!executable) errors.push(`The configured Program is not deployed and executable on the ${item.name} Devnet RPC.`);
      }
    } catch {
      report(`${item.name} RPC is reachable`, false, `request failed at ${endpointLabel}`);
      errors.push(`${item.name} RPC check failed. Confirm the endpoint is online and permits JSON-RPC POST requests.`);
    }
  }
} catch (error) {
  errors.push(`Could not read the project configuration: ${error.message}`);
}

for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label} — ${check.detail}`);
}

console.log('\nThis preflight only reads local configuration and Devnet RPC state. It does not validate SBF toolchain compatibility or send transactions.');
if (errors.length) {
  console.error(`\nDevnet preflight failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('\nDevnet configuration and deployed Program checks passed.');
}
