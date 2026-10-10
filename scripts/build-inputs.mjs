import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function buildInputFiles(root) {
  const files = ['programs/agent_os/Cargo.toml', 'Cargo.toml', 'Cargo.lock'];
  async function visit(directory) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error('Program source tree must not contain symlinks or special files.');
    }
  }
  await visit('programs/agent_os/src');
  return files.sort();
}
