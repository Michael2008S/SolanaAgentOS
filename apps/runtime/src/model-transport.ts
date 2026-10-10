import { runtimeNetwork } from './chain-network.js';
import { assertChainNetwork } from '../../../shared/chain-network.js';
import { fetchDeepseekResponse } from './deepseek-transport.js';
/** Test transport is explicit, loopback-only and never forwards real API credentials. */
export async function fetchModelResponse(init: RequestInit): Promise<Response> {
  const fixture = process.env.AGENTOS_LOCAL_MODEL_URL?.trim();
  if (!fixture) {
    const provider = process.env.AGENTOS_MODEL_PROVIDER?.trim() || 'openai';
    if (provider === 'deepseek') return fetchDeepseekResponse(init);
    if (provider !== 'openai' || process.env.OPENAI_MODEL?.startsWith('deepseek-')) throw new Error('Select the correct model provider before sending a credential.');
    return fetch('https://api.openai.com/v1/responses', { ...init, redirect: 'error' });
  }
  const network = runtimeNetwork();
  if (network.cluster !== 'localnet') throw new Error('Local model fixtures require localnet.');
  const endpoint = new URL(fixture);
  assertChainNetwork(network, endpoint, network.genesisHash);
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer local-test-fixture');
  return fetch(endpoint, { ...init, headers, redirect: 'error' });
}
