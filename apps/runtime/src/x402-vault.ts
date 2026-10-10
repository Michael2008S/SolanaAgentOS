import { runtimeNetwork, assertRuntimeNetwork } from './chain-network.js';
import { createHash } from 'node:crypto';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { SkillResultStore, StoredSkillResponse } from './skill-result-store.js';
import { readResponseTextLimited } from './http-limits.js';

export const AGENTOS_X402_SCHEME = 'agentos-vault';
export function agentOsX402Network(): `solana:${string}` { return runtimeNetwork().x402Network; }
export const AGENTOS_X402_PROTOCOL = 'agentos-vault-v1';
export const AGENTOS_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const accountDiscriminator = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const instructionDiscriminator = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const MAX_SKILL_REQUEST_BYTES = 16_384;
const MAX_PAYMENT_SIGNATURE_BYTES = 16_384;
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const isSignature = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value);
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

class SkillRequestTooLargeError extends Error {}

async function readLimitedRequestText(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* The request stream may already be closed. */ }
        throw new SkillRequestTooLargeError(`The Skill request exceeds the ${maxBytes / 1024} KiB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

type RpcEnvelope<T> = { result?: T; error?: { code?: number; message?: string } };
type RpcAccount = { owner?: unknown; data?: unknown };
type SkillState = { provider: string; endpointHash: string; active: boolean; priceSol: bigint; priceUsdc: bigint };
export type AgentOsVerifiedPayment = {
  outputHash?: string;
  signature: string;
  execution: string;
  agent: string;
  skill: string;
  provider: string;
  asset: 'SOL' | 'USDC';
  amount: string;
  resourceUrl: string;
};
export class AgentOsPaymentClaimError extends Error {
  constructor(message: string, readonly payment: AgentOsVerifiedPayment) { super(message); }
}
class AgentOsPaymentAlreadyUsed extends AgentOsPaymentClaimError {}
export type AgentOsSkillProviderHandlerOptions = {
  resultStore?: SkillResultStore;
  programId: string;
  skill: string;
  resourceUrl: string;
  allowedOrigins: string[];
  rpcUrl?: string;
  claimExecution: (execution: string, signature: string) => Promise<boolean>;
  validatePrompt?: (prompt: string) => void | Promise<void>;
  execute: (request: { agent: string; skill: string; prompt: string; payment: AgentOsVerifiedPayment }) => Promise<unknown>;
};

function decodeBase58(value: string): Uint8Array {
  let number = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) throw new Error('A Solana address contains an invalid base58 character.');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...new Array<number>(leadingZeroes).fill(0), ...bytes]);
}

function encodeBase58(value: Uint8Array): string {
  let number = value.reduce((accumulator, byte) => (accumulator << 8n) | BigInt(byte), 0n);
  let encoded = '';
  while (number > 0n) {
    encoded = base58Alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + encoded;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function fromAccount(value: unknown, expectedOwner: string, name: string, minLength: number): Buffer {
  const account = asObject(value, `The ${name} account response is malformed.`) as RpcAccount;
  if (account.owner !== expectedOwner || !Array.isArray(account.data) || typeof account.data[0] !== 'string' || account.data[1] !== 'base64') {
    throw new Error(`The ${name} account is missing or is not owned by the configured AgentOS program.`);
  }
  const data = Buffer.from(account.data[0], 'base64');
  if (data.length < minLength || !accountDiscriminator(name).every((byte, index) => data[index] === byte)) throw new Error(`The ${name} account data is invalid.`);
  return data;
}

function rpcUrlOrDefault(rpcUrl?: string): URL {
  const endpoint = new URL(rpcUrl?.trim() || process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('The AgentOS verification RPC URL must be an HTTP(S) URL without credentials or a fragment.');
  return endpoint;
}

async function rpc<T>(endpoint: URL, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} failed (${response.status}).`);
  const text = await readResponseTextLimited(response, 2_000_000, `Solana RPC ${method} response exceeded the 2 MB limit.`);
  const envelope = JSON.parse(text) as RpcEnvelope<T>;
  if (envelope.error) throw new Error(`Solana RPC ${method} failed: ${envelope.error.message || 'RPC error'}`);
  if (envelope.result === undefined) throw new Error(`Solana RPC ${method} returned no result.`);
  return envelope.result;
}

async function assertDevnet(endpoint: URL): Promise<void> {
  assertRuntimeNetwork(endpoint, await rpc<string>(endpoint, 'getGenesisHash'));
}

async function readSkill(endpoint: URL, programId: string, skillAddress: string): Promise<SkillState> {
  const response = await rpc<{ value: RpcAccount | null }>(endpoint, 'getAccountInfo', [skillAddress, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!response.value) throw new Error('The registered Skill account could not be found.');
  const data = fromAccount(response.value, programId, 'Skill', 130);
  if (data[112] > 1) throw new Error('The registered Skill active flag is invalid.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    provider: encodeBase58(data.subarray(8, 40)),
    endpointHash: toHex(data.subarray(72, 104)),
    active: data[112] === 1,
    priceSol: view.getBigUint64(104, true),
    priceUsdc: view.getBigUint64(114, true),
  };
}

export async function hashAgentOsSkillRequest(skill: string, prompt: string): Promise<string> {
  if (!isAddress(skill) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1_000) throw new Error('The Skill request is invalid.');
  return createHash('sha256').update(JSON.stringify({ skill, prompt: prompt.trim() })).digest('hex');
}

export async function createAgentOsPaymentRequired(input: {
  resourceUrl: string;
  description?: string;
  programId: string;
  skill: string;
  inputHash: string;
  asset: 'SOL' | 'USDC';
  rpcUrl?: string;
}): Promise<PaymentRequired> {
  if (!isAddress(input.programId) || !isAddress(input.skill) || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error('The AgentOS x402 challenge configuration is invalid.');
  const resource = new URL(input.resourceUrl);
  if (!['http:', 'https:'].includes(resource.protocol) || resource.username || resource.password || resource.hash) throw new Error('The AgentOS x402 resource URL must be an HTTP(S) URL without credentials or a fragment.');
  const resourceUrl = resource.toString();
  const endpoint = rpcUrlOrDefault(input.rpcUrl);
  await assertDevnet(endpoint);
  const skill = await readSkill(endpoint, input.programId, input.skill);
  if (!skill.active) throw new Error('This registered Skill is inactive.');
  if (skill.endpointHash !== createHash('sha256').update(resourceUrl).digest('hex')) throw new Error('The provider URL does not match the endpoint commitment stored in the Skill account.');
  const amount = input.asset === 'USDC' ? skill.priceUsdc : skill.priceSol;
  if (amount <= 0n) throw new Error(`This Skill has no registered ${input.asset} price.`);
  const requirements: PaymentRequirements = {
    scheme: AGENTOS_X402_SCHEME,
    network: agentOsX402Network(),
    asset: input.asset === 'USDC' ? AGENTOS_DEVNET_USDC_MINT : 'SOL',
    amount: amount.toString(),
    payTo: skill.provider,
    maxTimeoutSeconds: 300,
    extra: {
      agentosProtocol: AGENTOS_X402_PROTOCOL,
      programId: input.programId,
      skill: input.skill,
      inputHash: input.inputHash,
    },
  };
  return {
    x402Version: 2,
    resource: { url: resourceUrl, ...(input.description ? { description: input.description } : {}), mimeType: 'application/json' },
    accepts: [requirements],
  };
}

export function agentOsPaymentRequiredHeaders(paymentRequired: PaymentRequired): Record<string, string> {
  return {
    'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired),
    'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    'cache-control': 'no-store',
  };
}

export function decodeAgentOsPaymentSignature(headers: Headers): PaymentPayload {
  const value = headers.get('PAYMENT-SIGNATURE');
  if (!value) throw new Error('The request is missing the x402 PAYMENT-SIGNATURE header.');
  return decodePaymentSignatureHeader(value);
}

function parseInstruction(
  ixValue: unknown,
  messageKeys: unknown[],
  programId: string,
  expected: { asset: 'SOL' | 'USDC'; skill: string; provider: string; execution: string; amount: bigint; inputHash: string; executionId: bigint },
): boolean {
  const ix = asObject(ixValue, 'The confirmed transaction contains an invalid instruction.');
  let ixProgram = typeof ix.programId === 'string' ? ix.programId : undefined;
  if (!ixProgram && Number.isInteger(ix.programIdIndex)) {
    const key = messageKeys[ix.programIdIndex as number];
    ixProgram = typeof key === 'string' ? key : isAddress(asObject(key, 'The transaction account key is invalid.').pubkey) ? (key as { pubkey: string }).pubkey : undefined;
  }
  if (ixProgram !== programId) return false;
  if (typeof ix.data !== 'string') return false;
  let data: Uint8Array;
  try { data = decodeBase58(ix.data); } catch { return false; }
  const method = expected.asset === 'USDC' ? 'pay_usdc_skill' : 'pay_skill';
  const discriminator = instructionDiscriminator(method);
  const taskMethod = expected.asset === 'USDC' ? 'pay_task_usdc_skill' : 'pay_task_skill';
  const taskDiscriminator = instructionDiscriminator(taskMethod);
  const taskPayment = data.length === 64 && taskDiscriminator.every((byte, index) => data[index] === byte);
  const legacyPayment = data.length === 56 && discriminator.every((byte, index) => data[index] === byte);
  if (!taskPayment && !legacyPayment) return false;
  // Scoped variants preserve the legacy account positions and append Task and
  // TaskAction. Successful program execution atomically verifies their binding.
  if (taskPayment && (!Array.isArray(ix.accounts) || ix.accounts.length !== (expected.asset === 'USDC' ? 16 : 12))) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getBigUint64(8, true) !== expected.amount || toHex(data.subarray(16, 48)) !== expected.inputHash || view.getBigUint64(48, true) !== expected.executionId) return false;

  const accountIndexes: number[] = expected.asset === 'USDC' ? [7, 8, 10] : [6, 7, 8];
  if (!Array.isArray(ix.accounts) || ix.accounts.length <= accountIndexes[2]) return false;
  const accountKeys = ix.accounts.map((account) => {
    if (typeof account === 'string') return account;
    if (Number.isInteger(account)) {
      const key = messageKeys[account as number];
      if (typeof key === 'string') return key;
      const parsed = asObject(key, 'The transaction account key is invalid.');
      return typeof parsed.pubkey === 'string' ? parsed.pubkey : '';
    }
    return '';
  });
  return accountKeys[accountIndexes[0]] === expected.skill
    && accountKeys[accountIndexes[1]] === expected.provider
    && accountKeys[accountIndexes[2]] === expected.execution;
}

async function verifyTransaction(endpoint: URL, programId: string, proof: { signature: string; execution: string; skill: string; provider: string; asset: 'SOL' | 'USDC'; amount: bigint; inputHash: string; executionId: bigint }): Promise<void> {
  const transaction = await rpc<unknown>(endpoint, 'getTransaction', [proof.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
  const tx = asObject(transaction, 'The AgentOS payment transaction is not available at confirmed commitment.');
  const meta = asObject(tx.meta, 'The AgentOS payment transaction has no status metadata.');
  if (meta.err !== null) throw new Error('The AgentOS payment transaction did not succeed on Devnet.');
  const transactionValue = asObject(tx.transaction, 'The confirmed transaction data is malformed.');
  if (!Array.isArray(transactionValue.signatures) || !transactionValue.signatures.includes(proof.signature)) throw new Error('The x402 payment signature does not match the confirmed transaction.');
  const message = asObject(transactionValue.message, 'The confirmed transaction message is malformed.');
  if (!Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) throw new Error('The confirmed transaction message is incomplete.');
  const messageKeys = [...message.accountKeys];
  if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
    const loaded = asObject(meta.loadedAddresses, 'The confirmed transaction address lookup data is malformed.');
    if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)
      || !loaded.writable.every(isAddress) || !loaded.readonly.every(isAddress)) {
      throw new Error('The confirmed transaction has invalid loaded account addresses.');
    }
    messageKeys.push(...loaded.writable, ...loaded.readonly);
  }
  const matched = message.instructions.some((instruction) => {
    try { return parseInstruction(instruction, messageKeys, programId, { ...proof, executionId: proof.executionId }); }
    catch { return false; }
  });
  if (!matched) throw new Error('The confirmed transaction does not pay the registered Skill from the AgentOS program.');
}

export async function verifyAgentOsVaultPayment(input: {
  paymentPayload: PaymentPayload;
  resourceUrl: string;
  programId: string;
  skill: string;
  agent: string;
  inputHash: string;
  rpcUrl?: string;
  claimExecution: (execution: string, signature: string) => Promise<boolean>;
  // Trusted Provider receipt, checked only for saved-result retrieval.
  previouslyVerifiedResponse?: (payment: AgentOsVerifiedPayment) => Promise<boolean>;
}): Promise<AgentOsVerifiedPayment> {
  if (!isAddress(input.programId) || !isAddress(input.skill) || !isAddress(input.agent) || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error('The AgentOS payment verification context is invalid.');
  const payment = input.paymentPayload;
  if (payment.x402Version !== 2 || payment.accepted.scheme !== AGENTOS_X402_SCHEME || payment.accepted.network !== agentOsX402Network()) throw new Error('The x402 payment payload is not an AgentOS Devnet Vault payment.');
  const resourceUrl = new URL(input.resourceUrl).toString();
  if (payment.resource?.url !== resourceUrl) throw new Error('The x402 payment payload is for a different resource URL.');
  const extra = payment.accepted.extra;
  if (extra.agentosProtocol !== AGENTOS_X402_PROTOCOL || extra.programId !== input.programId || extra.skill !== input.skill || extra.inputHash !== input.inputHash) throw new Error('The x402 payment challenge does not match this registered Skill request.');
  const proof = asObject(payment.payload, 'The AgentOS x402 proof payload is malformed.');
  if (proof.agent !== input.agent || proof.skill !== input.skill || proof.inputHash !== input.inputHash || !isSignature(proof.signature) || !isAddress(proof.execution)) throw new Error('The AgentOS x402 proof does not match the request body.');
  if (decodeBase58(proof.signature).length !== 64) throw new Error('The AgentOS payment signature is malformed.');

  const endpoint = rpcUrlOrDefault(input.rpcUrl);
  await assertDevnet(endpoint);
  const skill = await readSkill(endpoint, input.programId, input.skill);
  if (skill.endpointHash !== createHash('sha256').update(resourceUrl).digest('hex')) throw new Error('The requested provider URL does not match the endpoint commitment stored in the Skill account.');
  if (payment.accepted.payTo !== skill.provider) throw new Error('The registered Skill provider does not match the x402 challenge.');
  const asset: 'SOL' | 'USDC' = payment.accepted.asset === 'SOL' ? 'SOL'
    : payment.accepted.asset === AGENTOS_DEVNET_USDC_MINT ? 'USDC'
      : (() => { throw new Error('The x402 challenge uses an unsupported AgentOS asset.'); })();
  if (!/^\d{1,20}$/.test(payment.accepted.amount)) throw new Error('The x402 payment amount is malformed.');

  const executionAccount = await rpc<{ value: RpcAccount | null }>(endpoint, 'getAccountInfo', [proof.execution, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!executionAccount.value) throw new Error('The AgentOS Execution proof does not exist on Devnet.');
  const data = fromAccount(executionAccount.value, input.programId, 'Execution', 100);
  if (encodeBase58(data.subarray(8, 40)) !== input.agent) throw new Error('The Execution record belongs to a different Agent.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const executionId = view.getBigUint64(40, true);
  const amount = view.getBigUint64(50, true);
  const assetTag = data[48];
  const outputTag = data[98];
  if (outputTag > 1) throw new Error('The Execution result hash tag is invalid.');
  const statusOffset = 99 + (outputTag === 1 ? 32 : 0);
  if (data.length <= statusOffset || ![1, 3].includes(data[49]) || assetTag !== (asset === 'USDC' ? 1 : 0)
    || amount <= 0n || payment.accepted.amount !== amount.toString() || toHex(data.subarray(66, 98)) !== input.inputHash || data[statusOffset] !== 0) {
    throw new Error('The on-chain Execution record does not match the Skill payment.');
  }

  const verifiedPayment = { ...(outputTag === 1 ? { outputHash: toHex(data.subarray(99, 131)) } : {}), signature: proof.signature, execution: proof.execution, agent: input.agent, skill: input.skill, provider: skill.provider, asset, amount: amount.toString(), resourceUrl } satisfies AgentOsVerifiedPayment;
  const previouslyVerified = input.previouslyVerifiedResponse ? await input.previouslyVerifiedResponse(verifiedPayment) : false;
  if (!previouslyVerified) await verifyTransaction(endpoint, input.programId, {
    signature: proof.signature,
    execution: proof.execution,
    skill: input.skill,
    provider: skill.provider,
    asset,
    amount,
    inputHash: input.inputHash,
    executionId,
  });
  let claimed: boolean;
  try { claimed = await input.claimExecution(proof.execution, proof.signature); }
  catch { throw new AgentOsPaymentClaimError('The payment is confirmed, but the provider could not persist its replay-protection record.', verifiedPayment); }
  if (!claimed) throw new AgentOsPaymentAlreadyUsed('This AgentOS Skill payment proof has already been used.', verifiedPayment);
  return verifiedPayment;
}

export function agentOsPaymentResponseHeaders(payment: AgentOsVerifiedPayment): Record<string, string> {
  const settlement: SettleResponse = {
    success: true,
    transaction: payment.signature,
    network: agentOsX402Network(),
    amount: payment.amount,
    extra: { agentosProtocol: AGENTOS_X402_PROTOCOL, execution: payment.execution, skill: payment.skill },
  };
  return {
    'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement),
    'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    'cache-control': 'no-store',
  };
}

export function createAgentOsVaultSkillHandler(options: AgentOsSkillProviderHandlerOptions): (request: Request) => Promise<Response> {
  if (!isAddress(options.programId) || !isAddress(options.skill)) throw new Error('The AgentOS provider handler needs valid program and Skill addresses.');
  const resourceUrl = new URL(options.resourceUrl);
  if (!['http:', 'https:'].includes(resourceUrl.protocol) || resourceUrl.username || resourceUrl.password || resourceUrl.hash) throw new Error('The AgentOS provider resource URL must be an HTTP(S) URL without credentials or a fragment.');
  if (!options.allowedOrigins.length || options.allowedOrigins.some((origin) => origin === '*' || new URL(origin).origin !== origin)) throw new Error('Configure one or more exact browser origins for the AgentOS provider handler.');

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const pathMatches = (() => {
      const incoming = new URL(request.url);
      return incoming.pathname === resourceUrl.pathname && incoming.search === resourceUrl.search;
    })();
    const corsHeaders: Record<string, string> = {
      vary: 'Origin',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, PAYMENT-SIGNATURE, AGENTOS-RESULT-ONLY',
      'access-control-max-age': '600',
    };
    if (origin && options.allowedOrigins.includes(origin)) corsHeaders['access-control-allow-origin'] = origin;
    const json = (value: unknown, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders, ...headers },
    });

    if (origin && !options.allowedOrigins.includes(origin)) return json({ error: 'Origin is not allowed.' }, 403);
    if (!pathMatches) return json({ error: 'Resource URL does not match this Skill route.' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'POST') return json({ error: 'Use POST for AgentOS Skill requests.' }, 405);
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) return json({ error: 'The Skill request has an invalid Content-Length header.' }, 400);
      if (BigInt(contentLength) > BigInt(MAX_SKILL_REQUEST_BYTES)) return json({ error: 'The Skill request exceeds the 16 KiB limit.' }, 413);
    }
    const paymentSignature = request.headers.get('PAYMENT-SIGNATURE');
    if (paymentSignature && Buffer.byteLength(paymentSignature, 'utf8') > MAX_PAYMENT_SIGNATURE_BYTES) return json({ error: 'The PAYMENT-SIGNATURE header exceeds the 16 KiB limit.' }, 431);

    let body: Record<string, unknown>;
    try {
      const raw = await readLimitedRequestText(request, MAX_SKILL_REQUEST_BYTES);
      body = asObject(JSON.parse(raw), 'The Skill request must be a JSON object.');
    } catch (error) {
      const status = error instanceof SkillRequestTooLargeError ? 413 : 400;
      return json({ error: error instanceof Error ? error.message : 'The Skill request body is invalid.' }, status);
    }

    try {
      const skillEnvelope = asObject(body.skill, 'The Skill identity is missing.');
      const requestEnvelope = asObject(body.request, 'The Skill request payload is missing.');
      if (body.protocol !== 'agentos-skill-v2' || skillEnvelope.address !== options.skill || requestEnvelope.skill !== options.skill
        || !isAddress(body.agent) || (body.paymentPreference !== 'SOL' && body.paymentPreference !== 'USDC')
        || typeof requestEnvelope.prompt !== 'string' || typeof requestEnvelope.sha256 !== 'string') {
        return json({ error: 'The AgentOS Skill request fields are invalid.' }, 400);
      }
      const prompt = requestEnvelope.prompt.trim();
      const inputHash = await hashAgentOsSkillRequest(options.skill, prompt);
      if (inputHash !== requestEnvelope.sha256) return json({ error: 'The request hash does not match the Skill prompt.' }, 400);
      const resultOnly = request.headers.get('AGENTOS-RESULT-ONLY') === 'true';
      if (request.headers.has('AGENTOS-RESULT-ONLY') && !resultOnly) return json({ error: 'Invalid result recovery mode.' }, 400);
      if (!resultOnly) await options.validatePrompt?.(prompt);
      if (resultOnly && !options.resultStore) return json({ error: 'This provider does not support saved result recovery.' }, 501);

      if (!request.headers.has('PAYMENT-SIGNATURE')) {
        const challenge = await createAgentOsPaymentRequired({
          resourceUrl: resourceUrl.toString(),
          programId: options.programId,
          skill: options.skill,
          inputHash,
          asset: body.paymentPreference,
          ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        });
        return json({ error: 'Payment required' }, 402, agentOsPaymentRequiredHeaders(challenge));
      }

      const paymentPayload = decodeAgentOsPaymentSignature(request.headers);
      const expectedAsset = body.paymentPreference === 'USDC' ? AGENTOS_DEVNET_USDC_MINT : 'SOL';
      if (paymentPayload.accepted.asset !== expectedAsset) return json({ error: 'Payment asset does not match the request preference.' }, 402);
      let payment: AgentOsVerifiedPayment;
      try {
        payment = await verifyAgentOsVaultPayment({
          paymentPayload,
          resourceUrl: resourceUrl.toString(),
          programId: options.programId,
          skill: options.skill,
          agent: body.agent,
          inputHash,
          ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
          claimExecution: resultOnly ? async () => true : options.claimExecution,
          ...(resultOnly && options.resultStore ? { previouslyVerifiedResponse: async (previous: AgentOsVerifiedPayment) => Boolean(await options.resultStore!.read(previous, inputHash)) } : {}),
        });
      } catch (error) {
        if (error instanceof AgentOsPaymentAlreadyUsed && options.resultStore) {
          try {
            const saved = await options.resultStore.read(error.payment, inputHash);
            if (saved) return new Response(saved.body, { status: 200, headers: { ...corsHeaders, ...agentOsPaymentResponseHeaders(error.payment), 'content-type': saved.contentType } });
            return json({ error: 'Payment was already claimed, but no successful response is saved. Execution may be running, failed or interrupted; it will not be repeated.' }, 409, agentOsPaymentResponseHeaders(error.payment));
          } catch { return json({ error: 'Saved Skill response could not be verified; existing files were preserved.' }, 503, agentOsPaymentResponseHeaders(error.payment)); }
        }
        if (error instanceof AgentOsPaymentClaimError) {
          return json({ error: error.message }, 503, agentOsPaymentResponseHeaders(error.payment));
        }
        return json({ error: error instanceof Error ? error.message : 'The AgentOS payment proof is invalid.' }, 402);
      }
      const settlementHeaders = agentOsPaymentResponseHeaders(payment);
      if (resultOnly) {
        try {
          const saved = await options.resultStore!.read(payment, inputHash);
          if (!saved) return json({ error: 'No successful saved result exists for this exact payment and request. Recovery never executes tools.' }, 404, settlementHeaders);
          return new Response(saved.body, { status: 200, headers: { ...corsHeaders, ...settlementHeaders, 'content-type': saved.contentType } });
        } catch { return json({ error: 'Saved Skill response could not be verified; existing files were preserved.' }, 503, settlementHeaders); }
      }
      const complete = async (response: StoredSkillResponse) => {
        if (options.resultStore) {
          try { await options.resultStore.save(payment, inputHash, response); }
          catch { return json({ error: 'Tool executed, but its successful response could not be saved. Payment remains claimed; do not pay or execute again.' }, 503, settlementHeaders); }
        }
        return new Response(response.body, { status: 200, headers: { 'content-type': response.contentType, ...corsHeaders, ...settlementHeaders } });
      };
      let result: unknown;
      try { result = await options.execute({ agent: body.agent, skill: options.skill, prompt, payment }); }
      catch (error) { return json({ error: error instanceof Error ? error.message.slice(0, 500) : 'The Skill could not complete the request.' }, 502, settlementHeaders); }
      if (typeof result === 'string') {
        if (Buffer.byteLength(result, 'utf8') > 65_536) return json({ error: 'The Skill result exceeds the 64 KiB response limit.' }, 502, settlementHeaders);
        return complete({ body: result, contentType: 'text/plain; charset=utf-8' });
      }
      let serialized: string | undefined;
      try { serialized = JSON.stringify(result); } catch { /* Unserializable Skill outputs are reported below. */ }
      if (serialized === undefined) return json({ error: 'The Skill returned no serializable result.' }, 502, settlementHeaders);
      if (Buffer.byteLength(serialized, 'utf8') > 65_536) return json({ error: 'The Skill result exceeds the 64 KiB response limit.' }, 502, settlementHeaders);
      return complete({ body: serialized, contentType: 'application/json; charset=utf-8' });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'AgentOS Skill request failed.' }, 400);
    }
  };
}
