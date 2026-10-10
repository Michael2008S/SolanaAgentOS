import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { ExternalMcp, parseExternalMcpServers } from './external-mcp.js';
import { HeadlessJournal } from './headless-journal.js';
import type { AutonomousJob } from './autonomous-loop.js';

test('real HTTP MCP discovers, validates and durably recovers one original tool response', async () => {
  let calls = 0;
  const credential='local-test-mcp-credential';process.env.AGENTOS_TEST_MCP_TOKEN=credential;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'local-external-test', version: '1.0.0' });
    server.registerTool('lookup', { description:'Untrusted echo '+credential,inputSchema: z.object({ query: z.string().min(1) }),
      outputSchema: z.object({ fact: z.string() }) }, async ({ query }) => {
      calls++; return { content: [{ type: 'text', text: query+' '+credential }], structuredContent: { fact: query } };
    });
    server.registerTool('unapproved', { inputSchema: z.object({}) }, async () => { throw new Error('Should not call.'); });
    return server;
  }, { responseMode: 'json' });
  const http = createServer(toNodeHandler(handler)); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const addr = http.address(); assert.ok(addr && typeof addr !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'agentos-mcp-')); let journal = new HeadlessJournal(join(root, 'calls.sqlite'));
  try {
    const config = parseExternalMcpServers(JSON.stringify([{ id: 'public', endpoint: `http://127.0.0.1:${addr.port}/mcp`, tools: ['lookup'],tokenEnv:'AGENTOS_TEST_MCP_TOKEN' }]));
    let client = new ExternalMcp(config, journal);
    const catalog = await client.catalog(); assert.deepEqual(catalog.map(tool => tool.id), ['mcp:public:lookup']);
    assert.ok(!JSON.stringify(catalog).includes(credential));
    const intentId = randomUUID(), action = { tool: catalog[0].id, input: '{"query":"Public fact"}', key: 'unique', asset: 'SOL' as const, amount: '0' };
    const job = { id: randomUUID(), tenant: 'one', agent: '11111111111111111111111111111111', session: '11111111111111111111111111111111',
      program: '11111111111111111111111111111111', genesis: '11111111111111111111111111111111', limits: { tools: [action.tool] },
      intents: [{ id: intentId, phase: 'reserved', action }] } as unknown as AutonomousJob;
    await assert.rejects(client.execute(job, { ...action, input: '{}' }, intentId), /reservation/); assert.equal(calls, 0);
    const invalidId=randomUUID(),invalidAction={...action,input:'{}'};job.intents.push({id:invalidId,phase:'reserved',action:invalidAction});
    const invalidReceipt=await client.execute(job,invalidAction,invalidId);assert.equal(calls,0);assert.equal(invalidReceipt.outcome,'error');assert.equal(JSON.parse(invalidReceipt.output).dispatched,false);assert.equal(JSON.parse(invalidReceipt.output).assurance,'local-mcp-preflight');assert.equal(JSON.parse(invalidReceipt.output).result.code,'invalid-input-schema');
    assert.deepEqual(await client.execute(job,invalidAction,invalidId),invalidReceipt);assert.equal(calls,0);
    const changedJob=structuredClone(job);changedJob.intents.find(intent=>intent.id===invalidId)!.action=action;await assert.rejects(client.execute(changedJob,action,invalidId),/scope/);assert.equal(calls,0);
    const receipt = await client.execute(job, action, intentId); assert.equal(calls, 1); assert.equal(JSON.parse(receipt.output).result.structuredContent.fact, 'Public fact');assert.ok(!receipt.output.includes(credential));
    journal.close(); journal = new HeadlessJournal(join(root, 'calls.sqlite')); client = new ExternalMcp(config, journal);
    assert.deepEqual(await client.reconcile(job, intentId), receipt); assert.deepEqual(await client.execute(job, action, intentId), receipt); assert.equal(calls, 1);
    const unknownId = randomUUID(); job.intents.push({ id: unknownId, phase: 'reserved', action });
    // Simulate a crash after dispatch but before receiving its response.
    journal.save({ tenant: job.tenant, jobId: job.id, intentId: unknownId, execution: job.agent, scopeHash: 'a'.repeat(64), complete: false });
    assert.equal(await client.reconcile(job, unknownId), null);
    await assert.rejects(client.execute(job, action, unknownId)); assert.equal(calls, 1);
  } finally {delete process.env.AGENTOS_TEST_MCP_TOKEN; journal.close(); await handler.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
