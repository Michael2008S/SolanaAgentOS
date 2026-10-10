import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { HeadlessJournal } from './headless-journal.js';
import { judgeQueueProfiles } from './judge-jobs.js';
import { importJudgeReview, judgeReview } from './judge-review.js';
import { RemoteJudgeRecord } from './remote-judge-record.js';
import { runtimeDataPath } from './data-path.js';
import { runtimeNetwork, assertRuntimeNetwork } from './chain-network.js';
import { readFileTextLimited } from './file-limits.js';
import { readResponseTextLimited } from './http-limits.js';

let journal: HeadlessJournal | undefined;
try {
  if (process.argv.length !== 3) throw new Error('Provide exactly one reviewed JSON file. Stop the Judge Runtime before importing.');
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Runtime configuration could not be read.'); }
  const review = judgeReview.parse(JSON.parse(await readFileTextLimited(process.argv[2]!, 20000, 'Review file exceeds 20 KB.')));
  const endpoint = new URL(process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid fixed RPC origin.');
  const client = new RemoteJudgeRecord(process.env.AGENTOS_JUDGE_GATEWAY?.trim() || '', process.env.AGENTOS_EXECUTION_GATEWAY_TOKEN?.trim() || '');
  // Acquiring the existing journal refuses a live Runtime owner. No copy,
  // reset, alternate journal or local HTTP mutation endpoint is introduced.
  journal = new HeadlessJournal(runtimeDataPath('judge-jobs.sqlite'));
  const result = await importJudgeReview({
    journal, program: process.env.AGENTOS_PROGRAM_ID?.trim() || '', genesis: runtimeNetwork().genesisHash,
    profiles: judgeQueueProfiles.parse(JSON.parse(process.env.AGENTOS_JUDGE_AUTORUN?.trim() || '[]')),
    preflight: async input => {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Review RPC network check failed.'); }
      const value = JSON.parse(await readResponseTextLimited(response, 4096, 'Review RPC response exceeds its limit.'));
      if (value.error) throw new Error('Review RPC network check failed.');
      assertRuntimeNetwork(endpoint, value.result);
      await client.preflight(input);
    },
  }, review);
  console.log(JSON.stringify({ ...result, signed: false, sent: false, modelRequests: 0, next: 'Restart the same Judge Runtime to dispatch the saved assessment under its existing delegation.' }));
} catch {
  // Reviewed files and configuration may contain sensitive free text.
  // Do not echo parser inputs, paths, environment values or remote bodies.
  console.error('Judge review import rejected. Check the fixed scope, original reservation, unexpired review, live authority and stopped Runtime; no assessment was replaced.');
  process.exitCode = 1;
} finally { journal?.close(); }
