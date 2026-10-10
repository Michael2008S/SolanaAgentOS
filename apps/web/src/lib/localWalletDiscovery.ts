/** Discover an existing role wallet before opening another ephemeral key window. */
export function probeLocalWallet(channel: Pick<BroadcastChannel, 'addEventListener' | 'removeEventListener' | 'postMessage'>, timeoutMs = 350): Promise<boolean> {
  const probeId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const responders = new Set<string>();
    let legacyResponses = 0;
    const listen = (event: MessageEvent) => {
      const data = event.data;
      if (data?.kind !== 'ready' || data.probeId && data.probeId !== probeId) return;
      if (typeof data.address === 'string') responders.add(data.address);
      else legacyResponses++;
    };
    channel.addEventListener('message', listen);
    const timer = setTimeout(() => {
      channel.removeEventListener('message', listen);
      const count = responders.size + legacyResponses;
      if (count > 1) reject(new Error('Multiple local wallets are open for this role. Keep the intended wallet window and close the duplicate before connecting.'));
      else resolve(count === 1);
    }, timeoutMs);
    try { channel.postMessage({ kind: 'probe', probeId }); }
    catch (cause) { clearTimeout(timer); channel.removeEventListener('message', listen); reject(cause); }
  });
}
