import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainNetwork, assertChainNetwork, DEVNET_GENESIS } from './chain-network.js';
const localGenesis = '11111111111111111111111111111111';
test('default retains Devnet identity and x402 network', () => {
 const n = chainNetwork(); assert.equal(n.identity, 'devnet-preview'); assert.equal(n.transactionVersion, 1);
 assert.equal(n.x402Network, `solana:${DEVNET_GENESIS.slice(0,32)}`);
 assertChainNetwork(n, new URL('https://api.devnet.solana.com'), DEVNET_GENESIS);
});
test('localnet requires explicit genesis and rejects unsupported clusters', () => {
 for (const args of [['localnet'], ['mainnet'], ['localnet', DEVNET_GENESIS], ['localnet', 'bad']]) assert.throws(() => chainNetwork(...args as [string, string?]));
});
test('localnet binds loopback and exact genesis', () => {
 const n=chainNetwork('localnet',localGenesis); assert.equal(n.identity,'localnet-preview'); assert.equal(n.transactionVersion, 0);
 for (const host of ['127.0.0.1','localhost','[::1]']) assertChainNetwork(n,new URL(`http://${host}:18899`),localGenesis);
 for (const url of ['https://api.devnet.solana.com','http://127.0.0.1.evil.test','http://user@localhost','http://localhost/#x']) assert.throws(()=>assertChainNetwork(n,new URL(url),localGenesis));
 assert.throws(()=>assertChainNetwork(n,new URL('http://localhost:18899'),DEVNET_GENESIS));
 assert.throws(()=>assertChainNetwork(chainNetwork(),new URL('http://localhost:18899'),localGenesis));
});

test('subscription endpoint follows validator port and retains Devnet port', async () => {
 const { chainSubscriptionsUrl } = await import('./chain-network.js');
 const local = chainNetwork('localnet', localGenesis);
 assert.equal(chainSubscriptionsUrl(local, 'http://127.0.0.1:18899/'), 'ws://127.0.0.1:18900/');
 assert.equal(chainSubscriptionsUrl(local, 'http://[::1]:8899/'), 'ws://[::1]:8900/');
 assert.equal(chainSubscriptionsUrl(chainNetwork(), 'https://api.devnet.solana.com/'), 'wss://api.devnet.solana.com/');
 assert.equal(chainSubscriptionsUrl(local, 'http://localhost:18899/', 'ws://localhost:19900/'), 'ws://localhost:19900/');
 for (const url of ['wss://api.devnet.solana.com/', 'http://localhost:18900/', 'ws://user@localhost:18900/', 'ws://localhost:18900/#x']) assert.throws(() => chainSubscriptionsUrl(local, 'http://localhost:18899/', url));
 assert.throws(() => chainSubscriptionsUrl(local, 'http://localhost:65535/'));
});
