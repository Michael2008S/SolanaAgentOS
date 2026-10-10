export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export type ChainNetwork = { cluster: 'devnet' | 'localnet'; genesisHash: string; identity: 'devnet-preview' | 'localnet-preview'; x402Network: `solana:${string}`; transactionVersion: 0 | 1 };
export function chainNetwork(cluster = 'devnet', localGenesis?: string): ChainNetwork {
  if (cluster !== 'devnet' && cluster !== 'localnet') throw new Error('Only devnet and localnet are supported.');
  const genesisHash = cluster === 'devnet' ? DEVNET_GENESIS : localGenesis?.trim();
  if (!genesisHash || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesisHash)) throw new Error('Localnet requires an explicit valid genesis hash.');
  if (cluster === 'localnet' && genesisHash === DEVNET_GENESIS) throw new Error('Localnet cannot use the Devnet genesis hash.');
  return { cluster, genesisHash, transactionVersion: cluster === 'localnet' ? 0 : 1, identity: cluster === 'localnet' ? 'localnet-preview' : 'devnet-preview', x402Network: `solana:${genesisHash.slice(0, 32)}` };
}
export function assertChainNetwork(network: ChainNetwork, endpoint: URL, actualGenesis: unknown): void {
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid RPC URL.');
  if (network.cluster === 'localnet' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Localnet RPC must use a loopback host.');
  if (actualGenesis !== network.genesisHash) throw new Error(`RPC genesis does not match configured ${network.cluster}.`);
}

/** Local validator subscriptions listen on the HTTP RPC port + 1. */
export function chainSubscriptionsUrl(network: ChainNetwork, rpcUrl: string, override?: string): string {
  const rpc = new URL(rpcUrl);
  // Validate the configured endpoint without making a network request.
  assertChainNetwork(network, rpc, network.genesisHash);
  const subscriptions = override ? new URL(override) : new URL(rpc.href);
  if (!override) {
    subscriptions.protocol = rpc.protocol === 'https:' ? 'wss:' : 'ws:';
    if (network.cluster === 'localnet') {
      const port = Number(rpc.port || (rpc.protocol === 'https:' ? 443 : 80)) + 1;
      if (port > 65535) throw new Error('Local subscription port exceeds 65535. Set an explicit WebSocket URL.');
      subscriptions.port = String(port);
    }
  }
  if (!['ws:', 'wss:'].includes(subscriptions.protocol) || subscriptions.username || subscriptions.password || subscriptions.hash) throw new Error('Invalid WebSocket URL.');
  if (network.cluster === 'localnet' && !['localhost', '127.0.0.1', '[::1]'].includes(subscriptions.hostname)) throw new Error('Localnet WebSocket must use a loopback host.');
  return subscriptions.href;
}
