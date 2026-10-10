import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function runtimeDataPath(name: string): string {
  const root = process.env.AGENTOS_DATA_DIR?.trim();
  if (process.env.AGENTOS_CLUSTER === 'localnet' && !root) throw new Error('Localnet requires AGENTOS_DATA_DIR to isolate test data.');
  return resolve(root || fileURLToPath(new URL('../.data/', import.meta.url)), name);
}
