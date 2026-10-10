import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadSolanaResearchSources, validateSolanaResearchOutput, selectResearchSourceEvidence } from './solana-research.js';
test('official source retrieval checks origin, path, Git content hash and bounded response', async () => {
 const originalFetch = globalThis.fetch; let corrupt = false, redirect = false;
 globalThis.fetch = async (url, init) => {
  const source = new URL(String(url)); assert.equal(source.hostname, 'api.github.com'); assert.equal(new Headers(init?.headers).has('authorization'), false); assert.equal(init?.redirect, 'error');
  const path = source.pathname.split('/contents/')[1], bytes = Buffer.from('Public documentation excerpt');
  return Response.json({ type: 'file', path, html_url: `${redirect ? 'https://example.com' : 'https://github.com'}/solana-foundation/solana-com/blob/main/${path}`, encoding: 'base64', sha: corrupt ? '0'.repeat(40) : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), size: bytes.length, content: bytes.toString('base64') });
 };
 try { assert.equal((await loadSolanaResearchSources()).length, 2); corrupt = true; await assert.rejects(() => loadSolanaResearchSources(), /Git revision/); corrupt = false; redirect = true; await assert.rejects(() => loadSolanaResearchSources(), /metadata/); }
 finally { globalThis.fetch = originalFetch; }
});

test('Research requires exact retrieved citations in both the report and citation list', () => {
 const url='https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/rpc/index.mdx', sources=[{url}];
 validateSolanaResearchOutput({report:`Excerpt limits apply. [RPC](${url})`,citedUrls:[url]},sources);
 assert.throws(()=>validateSolanaResearchOutput({report:url,citedUrls:[url]},sources),/inline Markdown/);
 assert.throws(()=>validateSolanaResearchOutput({report:'[RPC](https://example.com)',citedUrls:['https://example.com']},sources),/exact retrieved/);
 assert.throws(()=>validateSolanaResearchOutput({report:'No citation',citedUrls:[]},sources),/structure/);
 assert.throws(()=>validateSolanaResearchOutput({report:`[RPC](${url})`,citedUrls:[url],extra:true},sources),/structure/);
});

test('paid Research exposes the relevant verbatim source before generated claims', () => {
 const table='| processed | newest block, may roll back |\n| confirmed | more than two-thirds active stake |\n| finalized | maximum lockout |';
 const sources=[{url:'https://example.com/transactions',excerpt:'Transaction signatures.\n\nAn unrelated long introduction.'},{url:'https://example.com/rpc',excerpt:'RPC introduction.\n\n'+table}];
 const evidence=selectResearchSourceEvidence('Explain processed, confirmed and finalized commitment levels',sources);
 assert.equal(evidence.length,1);assert.equal(evidence[0].url,sources[1].url);assert.equal(evidence[0].excerpt,table);assert.ok(sources[1].excerpt.includes(evidence[0].excerpt));assert.match(evidence[0].limitation,/partial source excerpt/);
 const other=selectResearchSourceEvidence('Transaction signatures',sources);assert.equal(other[0].url,sources[0].url);
 const bounded=selectResearchSourceEvidence('commitment',[{url:sources[1].url,excerpt:'commitment '+ 'x'.repeat(2000)}]);assert.equal(bounded[0].excerpt.length,1400);
});
