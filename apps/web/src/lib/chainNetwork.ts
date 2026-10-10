import { chainNetwork, assertChainNetwork } from '../../../../shared/chain-network';
export const WEB_NETWORK = chainNetwork(import.meta.env?.VITE_AGENTOS_CLUSTER || 'devnet', import.meta.env?.VITE_AGENTOS_LOCALNET_GENESIS_HASH);
export const NETWORK_IDENTITY = WEB_NETWORK.identity;
export const NETWORK_STORAGE = WEB_NETWORK.cluster === 'devnet' ? 'devnet' : `localnet:${WEB_NETWORK.genesisHash}`;
export async function ensureConfiguredNetwork(client: { rpc: { getGenesisHash(): { send(): Promise<unknown> } } }): Promise<void> {
  assertChainNetwork(WEB_NETWORK, new URL(import.meta.env?.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'), await client.rpc.getGenesisHash().send());
}
export const EXPLORER_QUERY = WEB_NETWORK.cluster === 'localnet' ? `cluster=custom&customUrl=${encodeURIComponent(import.meta.env?.VITE_SOLANA_RPC_URL || 'http://127.0.0.1:18899')}` : 'cluster=devnet';
export const NETWORK_LABEL = WEB_NETWORK.cluster === 'localnet' ? 'Localnet' : 'Devnet';
