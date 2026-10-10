import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
// This read-only probe uses only the user-configured file credential. Never
// substitute the unrelated ambient OpenAI credential or follow redirects.
const values = parseEnv(await readFile(new URL('../apps/runtime/.env', import.meta.url), 'utf8'));
const key = values.OPENAI_API_KEY?.trim();
const model = values.OPENAI_MODEL?.trim();
if (!key || key === 'local-test-fixture' || !model?.startsWith('deepseek-')) throw new Error('Expected the configured DeepSeek credential and model.');
const result = { endpoint: 'https://api.deepseek.com/models', checkedAt: new Date().toISOString(), configuredModel: model, modelRequestsUsed: 0 };
try {
  const response = await fetch(result.endpoint, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  result.httpStatus = response.status;
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) throw new Error('Model directory exceeds the probe limit.');
  const data = JSON.parse(text);
  if (!Array.isArray(data.data) || data.data.some(row => typeof row.id !== 'string' || row.id.length > 128)) throw new Error('Invalid model directory.');
  result.models = data.data.map(row => row.id);
  result.configuredModelAvailable = result.models.includes(model);
  result.status = result.configuredModelAvailable ? 'ready' : 'model-unavailable';
} catch (error) {
  result.status = 'failed';
  result.error = error instanceof Error ? error.message : 'Model discovery failed.';
  if (error?.cause?.code) result.code = error.cause.code;
}
await writeFile(new URL('../docs/evidence/deepseek-goal-20261009-readiness.json', import.meta.url), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
if (result.status !== 'ready') process.exitCode = 1;
