import { generateKeyPairSigner, getAddressEncoder, getTransactionDecoder, getTransactionEncoder, getCompiledTransactionMessageDecoder, getBase64Decoder, type SignatureBytes } from '@solana/kit';
import { WEB_NETWORK, ensureConfiguredNetwork } from './lib/chainNetwork';
import { createSolanaRpc } from '@solana/kit';
import type { LocalWalletRole } from './lib/localTestWallet';
import { getLocale, setLocale, subscribeLocale, translate } from './i18n/locale';

const root = document.getElementById('wallet')!;
root.style.cssText = 'font:16px system-ui;max-width:580px;margin:30px auto;padding:20px;overflow-wrap:anywhere';
if (!import.meta.env.DEV || WEB_NETWORK.cluster !== 'localnet') throw new Error('Development wallet is disabled outside Localnet.');
const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL;
const rpc = createSolanaRpc(rpcUrl);
const roleParam = new URLSearchParams(location.search).get('role');
const role: LocalWalletRole = roleParam === 'judge' || roleParam === 'worker' ? roleParam : 'default';
const roleLabel = role === 'default' ? 'Localnet Test Wallet' : `Localnet Test Wallet · ${role === 'judge' ? 'Judge' : 'Worker'}`;
document.title = roleLabel;
const channelName = `agentos-local-wallet:${WEB_NETWORK.genesisHash}${role === 'default' ? '' : `:${role}`}`;
const channel = new BroadcastChannel(channelName);
// This page intentionally does not opt into Vite HMR. Importing its client would
// let unrelated full-reload events destroy the wallet's ephemeral key. Its HTML
// is served without the reload client by local-wallet-memory-lifetime.
// Only an explicit reload/close discards this key; it is never persisted.
const signer = await generateKeyPairSigner();
let busy = false;
const localizedNodes = new Map<HTMLElement, string>();
function label(node: HTMLElement, text: string) { localizedNodes.set(node, text); node.textContent = text.split('\n').map(line => translate(line)).join('\n'); }
function languageButtons() {
  const group = document.createElement('div'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', translate('Language'));
  for (const [locale, text] of [['en', 'EN'], ['zh', '中文']] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.lang = locale === 'zh' ? 'zh-CN' : 'en';
    button.setAttribute('aria-pressed', String(getLocale() === locale)); button.onclick = () => setLocale(locale); group.append(button);
  }
  root.append(group);
}
subscribeLocale(() => {
  document.title = translate(roleLabel);
  root.querySelector('[role="group"]')?.setAttribute('aria-label', translate('Language'));
  for (const [node, text] of localizedNodes) if (node.isConnected) label(node, text);
  const buttons = root.querySelectorAll('button[lang]');
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('lang') === (getLocale() === 'zh' ? 'zh-CN' : 'en'))));
});
function home(message = '') {
  root.replaceChildren(); localizedNodes.clear(); languageButtons(); document.title = translate(roleLabel);
  for (const text of [roleLabel, 'Temporary keys stay in this window only. Keep it open to reconnect from the app. Reloading or closing it loses the wallet. Use local test funds only.', `Wallet: ${signer.address}`, `Network: Localnet · ${rpcUrl}`, `Genesis: ${WEB_NETWORK.genesisHash}`, message]) {
    const p = document.createElement('p'); label(p, text); root.append(p);
  }
  const fund = document.createElement('button'); label(fund, 'Claim 2 local test SOL');
  fund.onclick = async () => {
    if (busy) return; busy = true; fund.disabled = true;
    try { await ensureConfiguredNetwork({ rpc }); const signature = await rawRpc('requestAirdrop', [signer.address, 2_000_000_000]); home(`Local funds requested: ${signature}. Wait for confirmation before continuing.`); }
    catch (error) { home(String(error)); } finally { busy = false; }
  };
  root.append(fund);
}
async function rawRpc(method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const data = await response.json(); if (data.error) throw new Error(JSON.stringify(data.error)); return data.result;
}
async function sign(payload: { address: string; transaction: Uint8Array }) {
  if (payload.address !== signer.address) throw new Error('Wrong signing account.');
  await ensureConfiguredNetwork({ rpc });
  const tx = getTransactionDecoder().decode(payload.transaction);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== 0 || !Object.hasOwn(tx.signatures, signer.address)) throw new Error('Unsupported transaction or signer.');
  const simulation = await rawRpc('simulateTransaction', [getBase64Decoder().decode(payload.transaction), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  if (simulation.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n')}`);
  const fee = await rawRpc('getFeeForMessage', [getBase64Decoder().decode(tx.messageBytes), { commitment: 'confirmed' }]);
  if (fee.value === null) throw new Error('Transaction blockhash expired. Please rebuild it.');
  home('Simulation passed. Check the amount, recipient and action against the app review before signing.');
  const detail = document.createElement('pre'); detail.style.whiteSpace = 'pre-wrap';
  label(detail, `Fee payer: ${message.staticAccounts[0]}\nNetwork fee: ${fee.value} lamports\nInstruction programs:\n${message.instructions.map(ix => message.staticAccounts[ix.programAddressIndex]).join('\n')}\nAccounts involved:\n${message.staticAccounts.join('\n')}\nSimulation units: ${simulation.value.unitsConsumed} CU`);
  root.append(detail);
  await new Promise<void>((resolve, reject) => {
    const approve = document.createElement('button'); label(approve, 'Confirm local transaction and sign');
    const cancel = document.createElement('button'); label(cancel, 'Cancel signature');
    const timeout = window.setTimeout(() => { approve.disabled = true; cancel.disabled = true; reject(new Error('Signature review expired. Rebuild the transaction and review again.')); }, 90_000);
    approve.onclick = () => { clearTimeout(timeout); approve.disabled = true; cancel.disabled = true; resolve(); };
    cancel.onclick = () => { clearTimeout(timeout); approve.disabled = true; cancel.disabled = true; reject(new Error('User rejected local wallet signature.')); };
    root.append(approve, cancel);
  });
  // Recheck the network after the human review; the key never leaves this window.
  await ensureConfiguredNetwork({ rpc });
  const blockhash = await rawRpc('isBlockhashValid', [message.lifetimeToken, { commitment: 'confirmed' }]);
  if (!blockhash.value) throw new Error('Transaction expired during review. Rebuild and sign again.');
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', signer.keyPair.privateKey, new Uint8Array(tx.messageBytes))) as SignatureBytes;
  return new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [signer.address]: signature } }));
}
channel.onmessage = async ({ data }) => {
  if (data?.kind === 'probe') { channel.postMessage({ kind: 'ready', address: signer.address, probeId: data.probeId }); return; }
  if (data?.kind !== 'request' || typeof data.id !== 'string') return;
  if (busy) { channel.postMessage({ kind: 'response', id: data.id, error: 'Wallet is busy. Retry after finishing the current request.' }); return; }
  busy = true;
  try {
    await ensureConfiguredNetwork({ rpc });
    let value;
    if (data.method === 'account') value = { address: signer.address, publicKey: new Uint8Array(getAddressEncoder().encode(signer.address)) };
    else if (data.method === 'sign') value = await sign(data.payload);
    else throw new Error('Unsupported wallet request.');
    channel.postMessage({ kind: 'response', id: data.id, value }); home(data.method === 'sign' ? 'Signed. The app will submit and confirm the transaction.' : 'Connected.');
  } catch (error) { channel.postMessage({ kind: 'response', id: data.id, error: String(error) }); home(String(error)); }
  finally { busy = false; }
};
home(); channel.postMessage({ kind: 'ready' });
