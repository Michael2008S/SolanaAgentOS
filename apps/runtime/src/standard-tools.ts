import * as z from 'zod/v4';
import { validateStandardTerms,type StandardPaymentTerms } from './standard-payments.js';
export const standardToolSchema=z.object({id:z.string().regex(/^http:[A-Za-z0-9_-]{1,80}$/),protocol:z.enum(['mpp','x402']),endpoint:z.string().url().max(2000),
 recoverResponse:z.boolean().optional(),x402Mode:z.enum(['agentos-cpi','prefunded']).optional(),recipient:z.string().min(32).max(44),asset:z.enum(['SOL','USDC']),amount:z.string().regex(/^[1-9][0-9]{0,19}$/),description:z.string().max(1000).default('Operator-approved paid HTTP resource'),method:z.enum(['GET','POST']).default('POST')}).strict().refine(tool=>tool.x402Mode===undefined||tool.protocol==='x402'&&tool.asset==='USDC','x402 payment mode requires classic USDC x402.');
export type StandardTool=z.infer<typeof standardToolSchema>;
export function parseStandardTools(raw:string){
 if(Buffer.byteLength(raw)>200000)throw new Error('Standard tool configuration exceeds its limit.');
 const tools=z.array(standardToolSchema).max(100).parse(JSON.parse(raw)).map(tool=>({...tool,endpoint:new URL(tool.endpoint).href}));
 if(new Set(tools.map(tool=>tool.id)).size!==tools.length)throw new Error('Standard HTTP tool identities must be unique.');return tools;
}
export function standardToolTerms(tool:StandardTool,cluster:'devnet'|'localnet',genesis:string):StandardPaymentTerms{
 const terms:StandardPaymentTerms={protocol:tool.protocol,endpoint:tool.endpoint,cluster,genesis,amount:tool.amount,recipient:tool.recipient,
  currency:tool.asset==='SOL'?'sol':'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',...(tool.asset==='USDC'?{decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}:{})};
 validateStandardTerms(terms);return terms;
}
export function validateStandardInput(tool:StandardTool,input:string){
 if(tool.method==='GET'){if(input!=='{}')throw new Error('A fixed GET tool requires empty JSON input.');return;}
 const body=JSON.parse(input);if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(input)>16384)throw new Error('Paid HTTP POST input must be a bounded JSON object.');
}
