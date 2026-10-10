import {handoffSources,type HandoffSources} from './handoff-sources.js';
import { runtimeDataPath } from './data-path.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { runtimeDatabase, runtimeStorageBackend } from './runtime-database.js';
import { readFileTextLimited } from './file-limits.js';
import { isValidSolanaAddress } from './memory.js';

export type Handoff = { escrow: string; task: string; result: string | null; taskHash: string; resultHash: string | null; sources?: HandoffSources };
type Commitment = { address: string; agent: string; id: string; taskHash: string; resultHash: string | null };
type SavedHandoff = Handoff & { programId: string };
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const defaultFile = runtimeDataPath('escrow-handoffs.json');

function validSaved(value: unknown): value is SavedHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<SavedHandoff>;
  return (item.sources===undefined||item.result!==null&&handoffSources.safeParse(item.sources).success) && isValidSolanaAddress(item.programId) && isValidSolanaAddress(item.escrow)
    && typeof item.task === 'string' && item.task.length > 0 && item.task.length <= 400 && item.task === item.task.trim()
    && item.taskHash === digest(item.task)
    && ((item.result === null && item.resultHash === null)
      || (typeof item.result === 'string' && item.result.length > 0 && item.result.length <= 400 && item.result === item.result.trim() && item.resultHash === digest(item.result)));
}

// Disk hashes are checked on restore. Each access still requires fresh Devnet commitments.
export class EscrowHandoffStore {
  private readonly entries = new Map<string, SavedHandoff>();
  private restored = false;
  private queue: Promise<void> = Promise.resolve();
  readonly persistent: boolean;
  private readonly file: string;
  private readonly remote?: {put(handoff:Handoff):Promise<void>;get(escrow:string,taskOnly?:boolean):Promise<Handoff|null>};
  constructor(
    private readonly lookup: (escrow: string) => Promise<Commitment | undefined>,
    private readonly programId: () => string,
    options: { persistent?: boolean; file?: string; remote?: {put(handoff:Handoff):Promise<void>;get(escrow:string,taskOnly?:boolean):Promise<Handoff|null>} } = {},
  ) {
    this.persistent = runtimeStorageBackend() === 'sqlite' || (options.persistent ?? false);
    this.file = options.file ?? defaultFile;
    this.remote=options.remote;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async restore(): Promise<void> {
    if (this.restored) return;
    if (this.persistent) {
      try {
        const legacy = async () => {
          let parsed: unknown;
          try { parsed = JSON.parse(await readFileTextLimited(this.file, 2_000_000, 'Saved handoffs exceed the 2 MB limit.')); }
          catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
          if (!Array.isArray(parsed) || parsed.length > 200 || !parsed.every(validSaved)) throw new Error('Saved handoffs contain invalid entries.');
          return parsed;
        };
        const parsed: unknown = runtimeStorageBackend() === 'sqlite' ? await (await runtimeDatabase()).restore('escrow-handoffs', legacy) : await legacy();
        if (!Array.isArray(parsed) || parsed.length > 200 || !parsed.every(validSaved)) throw new Error('Saved handoffs contain invalid entries.');
        const restored = new Map<string, SavedHandoff>();
        for (const item of parsed) {
          const key = `${item.programId}:${item.escrow}`;
          if (restored.has(key)) throw new Error('Saved handoffs contain duplicate Escrows.');
          restored.set(key, item);
        }
        for (const [key, item] of restored) this.entries.set(key, item);
      } catch (cause) {
        if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
          throw new Error(`Could not restore local handoffs; the existing storage has been preserved: ${cause instanceof Error ? cause.message : 'invalid file'}`);
        }
      }
    }
    this.restored = true;
  }

  private async persist(): Promise<void> {
    if (!this.persistent) return;
    if (runtimeStorageBackend() === 'sqlite') { (await runtimeDatabase()).replace('escrow-handoffs', [...this.entries.values()]); return; }
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file=await open(temporary,'wx',0o600);
      try{await file.writeFile(JSON.stringify([...this.entries.values()]),'utf8');await file.sync();}finally{await file.close();}
      await rename(temporary, this.file);
      const directory=await open(dirname(this.file),'r');try{await directory.sync();}finally{await directory.close();}
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async verify(escrow: string, task: string, result: string | null,sources?:HandoffSources): Promise<Handoff> {
    if (!isValidSolanaAddress(escrow) || typeof task !== 'string' || !task.trim() || task.length > 400
      || (result !== null && (typeof result !== 'string' || !result.trim() || result.length > 400))) throw new Error('Provide an Escrow address and task/result texts of 1–400 characters.');
    if(sources&&result===null)throw new Error('Sources require a committed Worker result.');
    const live = await this.lookup(escrow);
    if (!live) throw new Error('The Escrow was not found on Devnet.');
    if (result !== null && !live.resultHash) throw new Error('The Worker has not committed a result for this Escrow on Devnet.');
    const id = new Uint8Array(8);
    new DataView(id.buffer).setBigUint64(0, BigInt(live.id), true);
    const [canonical] = await getProgramDerivedAddress({ programAddress: address(this.programId()), seeds: [
      new TextEncoder().encode('escrow'), getAddressEncoder().encode(address(live.agent)), id,
    ] });
    if (canonical !== escrow || live.address !== escrow) throw new Error('Escrow address does not match its canonical PDA.');
    task = task.trim(); result = result === null ? null : result.trim();
    const taskHash = digest(task); const resultHash = result === null ? null : digest(result);
    if (taskHash !== live.taskHash || (result !== null && resultHash !== live.resultHash)) throw new Error('Task or result text does not match the on-chain commitment.');
    return { escrow, task, result, taskHash, resultHash,...(sources?{sources:handoffSources.parse(sources)}:{}) };
  }

  private async remember(handoff:Handoff):Promise<SavedHandoff>{
    const programId=this.programId(),key=`${programId}:${handoff.escrow}`,existing=this.entries.get(key);
    if(existing&&(existing.task!==handoff.task||(existing.result!==null&&handoff.result!==null&&existing.result!==handoff.result)))throw new Error('An existing handoff cannot be replaced.');
    if(existing?.sources&&handoff.sources&&JSON.stringify(existing.sources)!==JSON.stringify(handoff.sources))throw new Error('Original handoff sources cannot be replaced.');if(existing&&(handoff.result===null||existing.result===handoff.result)&&(!handoff.sources||existing.sources))return {...existing};
    if(!existing&&this.entries.size>=200)throw new Error('Local handoff storage is full (200 entries). Existing storage is preserved.');
    const saved={...handoff,...(existing?.sources?{sources:existing.sources}:{}),programId};this.entries.set(key,saved);
    try{if(Buffer.byteLength(JSON.stringify([...this.entries.values()]))>2000000)throw new Error('Local handoff storage exceeds 2 MB.');await this.persist();}catch(cause){if(existing)this.entries.set(key,existing);else this.entries.delete(key);throw new Error(`Could not persist the Escrow handoff: ${cause instanceof Error?cause.message:'write failed'}`);}
    return saved;
  }

  async save(escrow: string, task: string, result: string | null,sources?:HandoffSources): Promise<Handoff> {
    return this.serialize(async () => {
      await this.restore();
      const handoff=await this.verify(escrow,task,result,sources),saved=await this.remember(handoff);
      // Retry publication even when the local record already exists. A lost
      // acknowledgement cannot erase its original text or repeat delivery.
      if(this.remote)await this.remote.put({escrow:saved.escrow,task:saved.task,result:saved.result,taskHash:saved.taskHash,resultHash:saved.resultHash,...(saved.sources?{sources:saved.sources}:{})});
      return {...handoff};
    });
  }

  async read(escrow: string, taskOnly = false,refreshSources=false): Promise<Handoff> {
    return this.serialize(async () => {
      if (!isValidSolanaAddress(escrow)) throw new Error('Provide a valid Escrow address.');
      await this.restore();
      let handoff = this.entries.get(`${this.programId()}:${escrow}`);
      if(this.remote&&(!handoff||!taskOnly&&handoff.result===null||refreshSources&&!taskOnly&&!handoff.sources)){
        const shared=await this.remote.get(escrow,taskOnly);
        if(shared){
          if(shared.escrow!==escrow||!validSaved({...shared,programId:this.programId()}))throw new Error('Shared handoff body or scope differs.');
          handoff=await this.remember(await this.verify(escrow,shared.task,shared.result,shared.sources));
        }
      }
      if (!handoff) throw new Error('No local handoff found. Ask the sender to share its browser receipt with this Runtime, or paste the texts manually.');
      if (!taskOnly && handoff.result === null) throw new Error('The task is shared, but no Worker result has been shared yet.');
      return this.verify(escrow, handoff.task, taskOnly ? null : handoff.result,taskOnly?undefined:handoff.sources);
    });
  }
}
