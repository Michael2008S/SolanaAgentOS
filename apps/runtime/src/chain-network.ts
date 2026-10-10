import { chainNetwork, assertChainNetwork } from '../../../shared/chain-network.js';
export function runtimeNetwork() { return chainNetwork(process.env.AGENTOS_CLUSTER || 'devnet', process.env.AGENTOS_LOCALNET_GENESIS_HASH); }
export function assertRuntimeNetwork(endpoint: URL, genesis: unknown) { assertChainNetwork(runtimeNetwork(), endpoint, genesis); }
