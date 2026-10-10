/** @jsxImportSource ./i18n */
import { chainSubscriptionsUrl } from '../../../shared/chain-network';
import { registerLocalTestWallet } from './lib/localTestWallet';
import { WEB_NETWORK } from './lib/chainNetwork';
import React from 'react';
import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { ClientProvider } from '@solana/react';

const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

registerLocalTestWallet();
registerLocalTestWallet('worker');
registerLocalTestWallet('judge');

const rpcSubscriptionsUrl = chainSubscriptionsUrl(WEB_NETWORK, rpcUrl, import.meta.env.VITE_SOLANA_WS_URL);

export const client = createClient()
  .use(walletSigner({ chain: WEB_NETWORK.cluster === 'localnet' ? 'solana:localnet' : 'solana:devnet' }))
  .use(solanaRpc({ rpcUrl, rpcSubscriptionsUrl, transactionConfig: { version: WEB_NETWORK.transactionVersion } }));

export type AppClient = Awaited<typeof client>;

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClientProvider client={client}>{children}</ClientProvider>;
}
