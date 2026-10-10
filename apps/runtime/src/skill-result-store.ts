import { runtimeDataPath } from './data-path.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { AgentOsVerifiedPayment } from './x402-vault.js';
import { isValidSolanaAddress } from './memory.js';
import { readFileTextLimited } from './file-limits.js';

export type StoredSkillResponse = { body: string; contentType: 'application/json; charset=utf-8' | 'text/plain; charset=utf-8' };
export type SkillResultStore = {
  read: (payment: AgentOsVerifiedPayment, inputHash: string) => Promise<StoredSkillResponse | null>;
  save: (payment: AgentOsVerifiedPayment, inputHash: string, response: StoredSkillResponse) => Promise<void>;
};
const addr = z.string().refine(isValidSolanaAddress);
const contextSchema = z.object({ programId: addr, signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/), execution: addr, agent: addr, skill: addr, provider: addr, asset: z.enum(['SOL', 'USDC']), amount: z.string().regex(/^[1-9][0-9]{0,19}$/), resourceUrl: z.string().max(2000), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const schema = z.object({ version: z.literal(1), context: contextSchema, body: z.string().refine((value) => Buffer.byteLength(value) <= 65_536), contentType: z.enum(['application/json; charset=utf-8', 'text/plain; charset=utf-8']), outputHash: z.string().regex(/^[a-f0-9]{64}$/), savedAt: z.string().datetime() }).strict();
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function localSkillResultStore(namespace: string, programId: string): SkillResultStore {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace) || !isValidSolanaAddress(programId)) throw new Error('Invalid Skill result storage context.');
  const directory = runtimeDataPath(`${namespace}-results`);
  const context = (payment: AgentOsVerifiedPayment, inputHash: string) => contextSchema.parse({ programId, signature: payment.signature, execution: payment.execution, agent: payment.agent, skill: payment.skill, provider: payment.provider, asset: payment.asset, amount: payment.amount, resourceUrl: payment.resourceUrl, inputHash });
  const path = (payment: AgentOsVerifiedPayment) => join(directory, `${programId}-${payment.execution}.json`);
  async function read(payment: AgentOsVerifiedPayment, inputHash: string): Promise<StoredSkillResponse | null> {
    const expected = context(payment, inputHash);
    let text: string;
    try { text = await readFileTextLimited(path(payment), 500_000, 'Saved Skill response exceeds the storage limit.'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
    const saved = schema.parse(JSON.parse(text));
    if (JSON.stringify(saved.context) !== JSON.stringify(expected) || saved.outputHash !== hash(saved.body) || payment.outputHash && payment.outputHash !== saved.outputHash) throw new Error('Saved Skill response does not match the payment, request or output commitment.');
    return { body: saved.body, contentType: saved.contentType };
  }
  async function save(payment: AgentOsVerifiedPayment, inputHash: string, response: StoredSkillResponse) {
    const saved = schema.parse({ version: 1, context: context(payment, inputHash), ...response, outputHash: hash(response.body), savedAt: new Date().toISOString() });
    if (payment.outputHash && payment.outputHash !== saved.outputHash) throw new Error('Skill response differs from the existing output commitment.');
    const previous = await read(payment, inputHash);
    if (previous) { if (previous.body !== response.body || previous.contentType !== response.contentType) throw new Error('A successful Skill response cannot be replaced.'); return; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path(payment)}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(saved)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path(payment)); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        const concurrent = await read(payment, inputHash);
        if (!concurrent || concurrent.body !== response.body || concurrent.contentType !== response.contentType) throw new Error('A saved Skill response cannot be replaced.');
      }
      const directoryHandle = await open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  return { read, save };
}
