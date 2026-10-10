import * as z from 'zod/v4';
import { readResponseTextLimited } from './http-limits.js';
import type { AutonomousAction, AutonomousJob, AutonomousReceipt } from './autonomous-loop.js';
import { sponsoredPaymentSchema } from './headless-journal.js';

const output = z.object({ intentId: z.string().uuid(), execution: z.string().min(32).max(44),
  paymentSignature: z.string().min(64).max(88), resultSignature: z.string().min(64).max(88),
  fundingSignature:z.string().min(64).max(88).optional(),content: z.string().max(65536),paymentChallenge:z.string().max(20000).optional(),sponsoredPayment:sponsoredPaymentSchema.optional() }).strict();
export type GatewayOutput = z.infer<typeof output>;

/** Operator-configured execution service holding its own protected wallet.
 * The Runtime never accepts a signer URL, key or credential from a job/model.
 * Result retrieval is read-only. A separate recovery POST can resume only
 * the saved paid response result, with live authority for a missing result
 * signature and without paying or invoking the service again. */
export class AutonomousGateway {
  private readonly url: URL;
  constructor(endpoint: string, private readonly token: string,
    private readonly verify: (job: AutonomousJob, action: AutonomousAction, intentId: string, value: GatewayOutput) => Promise<AutonomousReceipt>,
    private readonly transport: typeof fetch = fetch) {
    this.url = new URL(endpoint);
    if (this.url.username || this.url.password || this.url.hash || this.url.search ||
      !(this.url.protocol === 'https:' || this.url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(this.url.hostname)) || token.length < 24)
      throw new Error('Execution gateway requires HTTPS or local loopback and an operator credential.');
  }
  private async call(job: AutonomousJob, action: AutonomousAction, intentId: string, recover: boolean, resumeOriginal=false) {
    const route = new URL(this.url.href.endsWith('/') ? this.url.href : this.url.href + '/');
    route.pathname += recover ? resumeOriginal?'recover':`results/${job.tenant}/${job.id}/${intentId}` : 'execute';
    const response = await this.transport(route, { method: recover&&!resumeOriginal ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type':'application/json' },
      signal: AbortSignal.timeout(55_000), ...(recover&&!resumeOriginal ? {} : { body: JSON.stringify({ intentId,
        job:{...job,intents:job.intents.map(({receipt: _receipt,...intent})=>intent),answer:undefined}, action }) }),
    });
    if (recover && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Execution gateway returned HTTP ${response.status}.`); }
    const value = output.parse(JSON.parse(await readResponseTextLimited(response, 400_000, 'Execution result exceeds the limit.')));
    if (value.intentId !== intentId) throw new Error('Execution gateway returned another intent.');
    return this.verify(job, action, intentId, value);
  }
  async execute(job: AutonomousJob, action: AutonomousAction, intentId: string) {
    const receipt = await this.call(job, action, intentId, false);
    if (!receipt) throw new Error('Execution gateway returned no result.');
    return receipt;
  }
  async reconcile(job: AutonomousJob, intentId: string) {
    const intent = job.intents.find(intent => intent.id === intentId);
    if (!intent) throw new Error('Unknown execution intent.');
    const ready=await this.call(job,intent.action,intentId,true);
    return ready??this.call(job,intent.action,intentId,true,true);
  }
}
