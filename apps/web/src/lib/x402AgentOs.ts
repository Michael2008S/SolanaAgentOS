import { WEB_NETWORK } from './chainNetwork';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { x402HTTPClient as X402HTTPClient } from '@x402/core/http';

export const AGENTOS_X402_SCHEME = 'agentos-vault';
export const AGENTOS_X402_NETWORK = WEB_NETWORK.x402Network;
export const AGENTOS_X402_PROTOCOL = 'agentos-vault-v1';

export type AgentOsPaymentProof = {
  signature: string;
  execution: string;
  agent: string;
  skill: string;
  inputHash: string;
};

export type AgentOsPaymentChallenge = {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function readAgentOsPaymentChallenge(response: Response): Promise<PaymentRequired> {
  const header = response.headers.get('PAYMENT-REQUIRED');
  try { await response.body?.cancel(); } catch { /* The v2 challenge is fully contained in the header. */ }
  if (!header || header.length > 16_384) throw new Error('The Skill provider did not return a valid x402 v2 payment challenge header.');
  const [{ x402Client }, { x402HTTPClient }] = await Promise.all([import('@x402/core/client'), import('@x402/core/http')]);
  const httpClient = new x402HTTPClient(new x402Client());
  return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name));
}

export function validateAgentOsPaymentChallenge(
  paymentRequired: PaymentRequired,
  expected: { endpoint: string; programId: string; skill: string; provider: string; asset: 'SOL' | 'USDC'; amount: bigint; inputHash: string },
): AgentOsPaymentChallenge {
  if (paymentRequired.x402Version !== 2) throw new Error('The Skill provider must return an x402 v2 payment challenge.');
  if (paymentRequired.resource.url !== expected.endpoint) throw new Error('The x402 challenge is for a different Skill endpoint.');

  const asset = expected.asset === 'USDC' ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'SOL';
  const matches = paymentRequired.accepts.filter((requirement) => {
    if (requirement.scheme !== AGENTOS_X402_SCHEME || requirement.network !== AGENTOS_X402_NETWORK) return false;
    const extra = requirement.extra;
    return requirement.asset === asset
      && requirement.amount === expected.amount.toString()
      && requirement.payTo === expected.provider
      && requirement.maxTimeoutSeconds > 0
      && isRecord(extra)
      && extra.agentosProtocol === AGENTOS_X402_PROTOCOL
      && extra.programId === expected.programId
      && extra.skill === expected.skill
      && extra.inputHash === expected.inputHash;
  });
  if (matches.length !== 1) throw new Error(`The x402 challenge does not match the registered ${expected.asset} price, provider, Skill, and request commitment.`);
  return { paymentRequired, requirement: matches[0] };
}

export async function encodeAgentOsPaymentSignature(
  challenge: AgentOsPaymentChallenge,
  proof: AgentOsPaymentProof,
): Promise<{ headers: Record<string, string>; httpClient: X402HTTPClient; paymentPayload: PaymentPayload }> {
  const { requirement } = challenge;
  const [{ x402Client }, { x402HTTPClient }] = await Promise.all([import('@x402/core/client'), import('@x402/core/http')]);
  const coreClient = new x402Client((_version, requirements) => {
    const matching = requirements.filter((candidate) => candidate.scheme === requirement.scheme
      && candidate.network === requirement.network
      && candidate.asset === requirement.asset
      && candidate.amount === requirement.amount
      && candidate.payTo === requirement.payTo
      && candidate.extra.agentosProtocol === requirement.extra.agentosProtocol
      && candidate.extra.programId === requirement.extra.programId
      && candidate.extra.skill === requirement.extra.skill
      && candidate.extra.inputHash === requirement.extra.inputHash);
    if (matching.length !== 1) throw new Error('The x402 payment requirements changed after review.');
    return matching[0];
  }).register(AGENTOS_X402_NETWORK, {
    scheme: AGENTOS_X402_SCHEME,
    async createPaymentPayload(x402Version, selectedRequirement) {
      if (x402Version !== 2) throw new Error('Only x402 v2 AgentOS payments are supported.');
      if (selectedRequirement.scheme !== requirement.scheme || selectedRequirement.network !== requirement.network
        || selectedRequirement.asset !== requirement.asset || selectedRequirement.amount !== requirement.amount
        || selectedRequirement.payTo !== requirement.payTo) throw new Error('The selected x402 requirement differs from the reviewed challenge.');
      return { x402Version, payload: { ...proof } };
    },
  }).setSpendControls(false);
  const httpClient = new x402HTTPClient(coreClient);
  const paymentPayload = await httpClient.createPaymentPayload(challenge.paymentRequired);
  return { headers: httpClient.encodePaymentSignatureHeader(paymentPayload), httpClient, paymentPayload };
}

export function validateAgentOsSettlement(
  settlement: SettleResponse,
  expected: { signature: string; amount: bigint; execution: string; skill: string },
): void {
  if (settlement.success !== true || settlement.transaction !== expected.signature
    || settlement.network !== AGENTOS_X402_NETWORK || settlement.amount !== expected.amount.toString()
    || settlement.extra?.agentosProtocol !== AGENTOS_X402_PROTOCOL
    || settlement.extra?.execution !== expected.execution || settlement.extra?.skill !== expected.skill) {
    throw new Error('The Skill provider did not return a matching x402 payment confirmation.');
  }
}

/** Reconstructs this protocol's original accepted terms; creates no new payment. */
export function recoveryPaymentChallenge(input: { endpoint: string; programId: string; skill: string; provider: string; asset: 'SOL' | 'USDC'; amount: string; inputHash: string }): AgentOsPaymentChallenge {
  const requirement: AgentOsPaymentChallenge['requirement'] = { scheme: AGENTOS_X402_SCHEME, network: AGENTOS_X402_NETWORK, asset: input.asset === 'SOL' ? 'SOL' : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', amount: input.amount, payTo: input.provider, maxTimeoutSeconds: 120, extra: { agentosProtocol: AGENTOS_X402_PROTOCOL, programId: input.programId, skill: input.skill, inputHash: input.inputHash } };
  return { requirement, paymentRequired: { x402Version: 2, resource: { url: input.endpoint }, accepts: [requirement] } };
}
