import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepseekResponseError, deepseekChatBody, fetchDeepseekResponse } from './deepseek-transport.js';
import { reserveModelRequest } from './model-budget.js';
const request = { model: 'deepseek-flash', max_output_tokens: 1200, input: [{ role: 'user', content: 'Public Solana research' }], text: { format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } } };
test('DeepSeek rejects unapproved tools, excessive output and nontext inputs before dispatch', () => {
 for (const value of [{ ...request, tools: [{ type: 'web_search' }] }, { ...request, max_output_tokens: 2501 }, { ...request, input: [{ role: 'user', content: [{ type: 'input_image' }] }] }, { ...request, model: 'other-model' }]) assert.throws(() => deepseekChatBody(value));
 const body = deepseekChatBody(request); assert.equal(body.response_format?.type, 'json_object'); assert.equal(body.max_tokens, 1200); assert.equal(body.thinking.type, 'disabled'); assert.match(body.messages[0].content, /JSON schema/);
});
test('DeepSeek uses only its separate credential, rejects redirects and truncated output', async () => {
 const previous = { key: process.env.DEEPSEEK_API_KEY, budget: process.env.AGENTOS_MODEL_BUDGET_PATH, limit: process.env.AGENTOS_MODEL_REQUEST_LIMIT };
 const originalFetch = globalThis.fetch; let finish = 'stop', calls = 0, model = 'deepseek-flash', malformed = false;
 process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'; delete process.env.AGENTOS_MODEL_BUDGET_PATH; delete process.env.AGENTOS_MODEL_REQUEST_LIMIT;
 globalThis.fetch = async (url, init) => { calls++; assert.equal(String(url), 'https://api.deepseek.com/chat/completions'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-deepseek-key'); assert.equal(init?.redirect, 'error'); return malformed ? new Response('credential-do-not-record') : Response.json({ model, choices: [{ finish_reason: finish, message: { role: 'assistant', content: '{"answer":"test"}' } }] }); };
 try {
  const response = await fetchDeepseekResponse({ method: 'POST', headers: { authorization: 'Bearer unrelated-openai-key' }, body: JSON.stringify(request) }); const payload = await response.json(); assert.equal(payload.status, 'completed');
  finish = 'length'; await assert.rejects(() => fetchDeepseekResponse({ method: 'POST', body: JSON.stringify(request) }), /incomplete/); assert.equal(calls, 2);
  model = 'credential-do-not-record'; finish = 'credential-do-not-record';
  await assert.rejects(() => fetchDeepseekResponse({ method: 'POST', body: JSON.stringify(request) }), error => {
   assert.ok(error instanceof DeepseekResponseError); assert.equal(error.diagnostics.modelMatched, false); assert.equal(error.diagnostics.finishReason, 'other'); assert.ok(!JSON.stringify(error.diagnostics).includes('credential-do-not-record')); assert.ok(!error.message.includes('credential-do-not-record')); return true;
  });
  malformed = true;
  await assert.rejects(() => fetchDeepseekResponse({ method: 'POST', body: JSON.stringify(request) }), error => { assert.ok(error instanceof Error); assert.match(error.message, /malformed JSON/); assert.ok(!error.message.includes('credential-do-not-record')); return true; });
 } finally { globalThis.fetch = originalFetch; for (const [key, value] of [['DEEPSEEK_API_KEY', previous.key], ['AGENTOS_MODEL_BUDGET_PATH', previous.budget], ['AGENTOS_MODEL_REQUEST_LIMIT', previous.limit]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } }
});
test('durable quota survives reuse and cannot be enlarged or redirected', async () => {
 const previous = { path: process.env.AGENTOS_MODEL_BUDGET_PATH, limit: process.env.AGENTOS_MODEL_REQUEST_LIMIT }; const directory = await mkdtemp(join(tmpdir(), 'agentos-model-budget-'));
 process.env.AGENTOS_MODEL_BUDGET_PATH = join(directory, 'quota.json'); process.env.AGENTOS_MODEL_REQUEST_LIMIT = '2';
 try {
  await reserveModelRequest('https://api.deepseek.com/chat/completions', 'deepseek-flash', 1200);
  const concurrent = await Promise.allSettled([reserveModelRequest('https://api.deepseek.com/chat/completions', 'deepseek-flash', 900), reserveModelRequest('https://api.deepseek.com/chat/completions', 'deepseek-flash', 900)]); assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
  await assert.rejects(() => reserveModelRequest('https://api.deepseek.com/chat/completions', 'deepseek-flash', 900), /exhausted/);
  process.env.AGENTOS_MODEL_REQUEST_LIMIT = '3'; await assert.rejects(() => reserveModelRequest('https://api.deepseek.com/chat/completions', 'deepseek-flash', 900), /changed/);
  const saved = JSON.parse(await readFile(process.env.AGENTOS_MODEL_BUDGET_PATH, 'utf8')); assert.equal(saved.requests.length, 2); assert(!JSON.stringify(saved).includes('key'));
 } finally { await rm(directory, { recursive: true, force: true }); for (const [key, value] of [['AGENTOS_MODEL_BUDGET_PATH', previous.path], ['AGENTOS_MODEL_REQUEST_LIMIT', previous.limit]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } }
});
