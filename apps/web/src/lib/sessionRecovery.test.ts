import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { createEncryptedSessionBackup, restoreEncryptedSessionBackup } from './sessionRecovery';

const agent = '11111111111111111111111111111111';
const session = '22222222222222222222222222222222';
const passphrase = 'local-test-only-passphrase';
async function fixture() {
  const signer = await generateKeyPairSigner(true);
  const backupText = await createEncryptedSessionBackup({ signer, agent, session, expiresAt: Math.floor(Date.now() / 1000) + 3600, passphrase });
  return { signer, backupText };
}

test('encrypted Session backup round trip restores the same signing authority', async () => {
  const { signer, backupText } = await fixture();
  const restored = await restoreEncryptedSessionBackup({ backupText, passphrase, agent, session });
  assert.equal(restored.address, signer.address);
  const message = new TextEncoder().encode('local recovery test; not a transaction');
  const signature = await crypto.subtle.sign('Ed25519', restored.keyPair.privateKey, message);
  assert.equal(await crypto.subtle.verify('Ed25519', signer.keyPair.publicKey, signature, message), true);
});

test('Session backup rejects wrong password and ciphertext corruption', async () => {
  const { backupText } = await fixture();
  await assert.rejects(restoreEncryptedSessionBackup({ backupText, passphrase: 'incorrect-test-password', agent, session }), /incorrect or the file is damaged/);
  const backup = JSON.parse(backupText);
  const encrypted = Buffer.from(backup.ciphertext, 'base64'); encrypted[0] ^= 1;
  backup.ciphertext = encrypted.toString('base64');
  await assert.rejects(restoreEncryptedSessionBackup({ backupText: JSON.stringify(backup), passphrase, agent, session }), /incorrect or the file is damaged/);
});

test('Session backup rejects unrelated identity, expired metadata and malformed files', async () => {
  const { backupText } = await fixture();
  for (const mismatch of [{ agent: session, session }, { agent, session: agent }]) {
    await assert.rejects(restoreEncryptedSessionBackup({ backupText, passphrase, ...mismatch }), /different Agent or Session/);
  }
  const backup = JSON.parse(backupText);
  for (const patch of [{ expiresAt: 1 }, { sessionKey: agent }, { iv: 'bad' }, { salt: '' }, { version: 99 }]) {
    await assert.rejects(restoreEncryptedSessionBackup({ backupText: JSON.stringify({ ...backup, ...patch }), passphrase, agent, session }));
  }
  for (const text of ['{', 'null', 'x'.repeat(16_385)]) {
    await assert.rejects(restoreEncryptedSessionBackup({ backupText: text, passphrase, agent, session }));
  }
});

test('Session backup requires a sufficiently long password and an exportable key', async () => {
  const signer = await generateKeyPairSigner();
  const input = { signer, agent, session, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  await assert.rejects(createEncryptedSessionBackup({ ...input, passphrase: 'short' }), /at least 12/);
  await assert.rejects(createEncryptedSessionBackup({ ...input, passphrase }), /cannot be exported/);
});
