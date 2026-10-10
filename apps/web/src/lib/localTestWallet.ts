import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { WEB_NETWORK } from './chainNetwork';
import { probeLocalWallet } from './localWalletDiscovery';

export const LOCAL_WALLET_NAME = 'Localnet Test Wallet';
export const localWalletChannel = `agentos-local-wallet:${WEB_NETWORK.genesisHash}`;
export type LocalWalletRole = 'default' | 'worker' | 'judge';
export const channelForLocalRole = (role: LocalWalletRole) => role === 'default' ? localWalletChannel : `${localWalletChannel}:${role}`;

// The separate wallet window owns the ephemeral key. No key is stored by the dapp.
export function registerLocalTestWallet(role: LocalWalletRole = 'default') {
  if (!import.meta.env.DEV || WEB_NETWORK.cluster !== 'localnet') return;
  const channel = new BroadcastChannel(channelForLocalRole(role));
  let accounts: readonly WalletAccount[] = [];
  let popup: Window | null = null;
  const listeners = new Set<(event: { accounts: readonly WalletAccount[] }) => void>();
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: number }>();
  channel.onmessage = ({ data }) => {
    if (!data || data.kind !== 'response') return;
    const call = pending.get(data.id);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(data.id);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data.value);
  };
  async function request(method: string, payload?: unknown) {
    const id = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('Local wallet window did not respond. Keep it open and retry.')); }, 120_000);
      pending.set(id, { resolve, reject, timer });
      channel.postMessage({ kind: 'request', id, method, payload });
    });
  }
  const signing: SolanaSignTransactionFeature['solana:signTransaction'] = {
    version: '1.0.0', supportedTransactionVersions: [0],
    async signTransaction(...inputs) {
      const outputs = [];
      for (const input of inputs) {
        if (input.chain !== undefined && input.chain !== 'solana:localnet') throw new Error('Local wallet only supports Localnet.');
        if (!accounts.some(account => account.address === input.account.address)) throw new Error('Local wallet account is disconnected.');
        popup?.focus();
        outputs.push({ signedTransaction: await request('sign', { address: input.account.address, transaction: input.transaction }) as Uint8Array });
      }
      return outputs;
    },
  };
  const wallet: Wallet = {
    version: '1.0.0', name: role === 'default' ? LOCAL_WALLET_NAME : `${LOCAL_WALLET_NAME} · ${role === 'judge' ? 'Judge' : 'Worker'}`,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzY0NTZmZiIvPjx0ZXh0IHg9IjIwIiB5PSIyNyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiPkxUPC90ZXh0Pjwvc3ZnPg==',
    chains: ['solana:localnet'], get accounts() { return accounts; },
    features: {
      'standard:connect': { version: '1.0.0', async connect() {
        if (await probeLocalWallet(channel)) {
          const account = await request('account');
          accounts = [{ ...account, chains: ['solana:localnet'], features: ['solana:signTransaction'] }];
          listeners.forEach(listener => listener({ accounts }));
          return { accounts };
        }
        // Different ledgers must not reuse an old role window with another genesis.
        popup = window.open('', `agentos-local-test-wallet-${WEB_NETWORK.genesisHash}-${role}`, 'popup,width=650,height=760');
        if (!popup) throw new Error('Allow popups to open the Localnet test wallet.');
        if (popup.location.href === 'about:blank') popup.location.href = role === 'default' ? '/local-wallet.html' : `/local-wallet.html?role=${role}`;
        // The wallet announces readiness; existing windows answer the probe.
        const ready = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => { channel.removeEventListener('message', listen); reject(new Error('Local wallet is not ready.')); }, 15_000);
          function listen(event: MessageEvent) { if (event.data?.kind === 'ready') { clearTimeout(timeout); channel.removeEventListener('message', listen); resolve(); } }
          channel.addEventListener('message', listen); channel.postMessage({ kind: 'probe' });
        });
        await ready;
        const account = await request('account');
        accounts = [{ ...account, chains: ['solana:localnet'], features: ['solana:signTransaction'] }];
        listeners.forEach(listener => listener({ accounts }));
        return { accounts };
      } },
      'standard:disconnect': { version: '1.0.0', async disconnect() { accounts = []; listeners.forEach(listener => listener({ accounts })); } },
      'standard:events': { version: '1.0.0', on(event: string, listener: (event: { accounts: readonly WalletAccount[] }) => void) { if (event === 'change') listeners.add(listener); return () => listeners.delete(listener); } },
      'solana:signTransaction': signing,
    },
  };
  getWallets().register(wallet);
}
