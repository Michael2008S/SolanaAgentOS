import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from '@solana/kit';

const format = 'agentos-session-backup';
const iterations = 310_000;
const encoder = new TextEncoder();
const ed25519Pkcs8Prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

type SessionBackup = {
  format: typeof format;
  version: 1;
  agent: string;
  session: string;
  sessionKey: string;
  expiresAt: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string, expectedLength: number): Uint8Array {
  const binary = atob(value);
  if (binary.length !== expectedLength) throw new Error('The Session backup file is malformed.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: arrayBuffer(salt), iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function createEncryptedSessionBackup(input: {
  signer: KeyPairSigner;
  agent: string;
  session: string;
  expiresAt: number;
  passphrase: string;
}): Promise<string> {
  if (input.passphrase.length < 12) throw new Error('Use a backup password with at least 12 characters.');
  const privateKey = input.signer.keyPair.privateKey;
  if (!privateKey.extractable) throw new Error('This Session key cannot be exported. Create a Session with the current version of AgentOS.');
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  if (pkcs8.length !== 48 || !ed25519Pkcs8Prefix.every((byte, index) => pkcs8[index] === byte)) {
    pkcs8.fill(0);
    throw new Error('The browser returned an unsupported Session key format.');
  }
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32));
  secret.set(getBase58Encoder().encode(input.signer.address), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ciphertext: Uint8Array;
  try {
    const key = await encryptionKey(input.passphrase, salt);
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(iv) }, key, arrayBuffer(secret)));
  }
  finally { secret.fill(0); pkcs8.fill(0); }
  const backup: SessionBackup = {
    format,
    version: 1,
    agent: input.agent,
    session: input.session,
    sessionKey: input.signer.address,
    expiresAt: input.expiresAt,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
  return JSON.stringify(backup, null, 2);
}

export async function restoreEncryptedSessionBackup(input: {
  backupText: string;
  passphrase: string;
  agent: string;
  session: string;
}): Promise<KeyPairSigner> {
  if (input.backupText.length > 16_384) throw new Error('The Session backup file exceeds the 16 KiB limit.');
  let backup: SessionBackup;
  try { backup = JSON.parse(input.backupText) as SessionBackup; }
  catch { throw new Error('Choose a valid AgentOS Session backup file.'); }
  if (!backup || backup.format !== format || backup.version !== 1 || backup.agent !== input.agent || backup.session !== input.session
    || typeof backup.sessionKey !== 'string' || !Number.isSafeInteger(backup.expiresAt) || typeof backup.salt !== 'string'
    || typeof backup.iv !== 'string' || typeof backup.ciphertext !== 'string') {
    throw new Error('This backup belongs to a different Agent or Session.');
  }
  if (backup.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('This Session has expired. Create a replacement Session.');
  let cleartext: Uint8Array;
  try {
    const salt = fromBase64(backup.salt, 16);
    const iv = fromBase64(backup.iv, 12);
    const ciphertext = fromBase64(backup.ciphertext, 80);
    const key = await encryptionKey(input.passphrase, salt);
    cleartext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(iv) }, key, arrayBuffer(ciphertext)));
  } catch { throw new Error('The backup password is incorrect or the file is damaged.'); }
  if (cleartext.length !== 64) throw new Error('The Session backup contains an invalid signing key.');
  let signer: KeyPairSigner;
  try { signer = await createKeyPairSignerFromBytes(cleartext, true); }
  finally { cleartext.fill(0); }
  if (signer.address !== backup.sessionKey) throw new Error('The backup key does not match its Session address.');
  return signer;
}
