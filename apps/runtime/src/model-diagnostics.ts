import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Error summaries may echo credentials. Redact configured secrets and common
 * credential formats before persisting or returning any upstream message. */
export function redactModelError(value: unknown): string {
 let text = typeof value === 'string' ? value : 'Upstream service returned no error description.';
 const secrets = Object.entries(process.env).filter(([name, secret]) => /(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name) && secret && secret.length >= 8).map(([,secret]) => secret!).sort((a,b)=>b.length-a.length);
 for (const secret of secrets) text = text.split(secret).join('[redacted]');
 return text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,400);
}

export async function recordModelDiagnostic(value: { phase: 'http' | 'transport' | 'validation'; status?: number; message: string }): Promise<void> {
 const path = process.env.AGENTOS_MODEL_DIAGNOSTICS_PATH?.trim();
 if (!path) return;
 await mkdir(dirname(path), { recursive:true, mode:0o700 });
 await appendFile(path,JSON.stringify({at:new Date().toISOString(),...value,message:redactModelError(value.message)})+'\n',{mode:0o600});
}
