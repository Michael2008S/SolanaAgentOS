/** Bounded independent bootstrap polls. Mutations remain synchronous inside
 * each verified callback; no untrusted URL can add work to this fixed list. */
export async function pollCatalogs(urls: string[], operation: (url: string) => Promise<void>) {
  let next = 0;
  const worker = async () => { while (next < urls.length) await operation(urls[next++]!); };
  await Promise.all(Array.from({ length: Math.min(5, urls.length) }, worker));
}
