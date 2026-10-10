import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLocalWallet } from './localWalletDiscovery';
function fixture(values: unknown[]) {
  const target = new EventTarget();
  return Object.assign(target, { postMessage(request: { probeId: string }) { for (const value of values) target.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? { kind:'ready', address:value, probeId:request.probeId } : value })); } });
}
test('local wallet discovery distinguishes absence, existing wallet and duplicates', async () => {
  assert.equal(await probeLocalWallet(fixture([]), 1),false);
  assert.equal(await probeLocalWallet(fixture(['wallet']),1),true);
  assert.equal(await probeLocalWallet(fixture(['wallet','wallet']),1),true);
  assert.equal(await probeLocalWallet(fixture([{kind:'ready'}]),1),true);
  await assert.rejects(probeLocalWallet(fixture(['first','second']),1),/Multiple local wallets/);
  assert.equal(await probeLocalWallet(fixture([{kind:'ready',address:'other',probeId:'unrelated'}]),1),false);
});
