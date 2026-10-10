import { decodePaymentSignatureHeader,decodePaymentResponseHeader } from '@x402/core/http';
import { readResponseTextLimited } from './http-limits.js';
export type SavedSkillResponseScope={endpoint:string;program:string;genesis:string;agent:string;skill:string;provider:string;asset:'SOL'|'USDC';amount:string;input:string;inputHash:string;execution:string;signature:string};
/** Only request an already stored response for a separately verified original payment. */
export async function recoverSavedSkillResponse(scope:SavedSkillResponseScope,paymentHeader:string,reserveAttempt:()=>void,transport:typeof fetch=fetch):Promise<string>{
 const original=decodePaymentSignatureHeader(paymentHeader),accepted=original.accepted,payload=original.payload;
 if(original.x402Version!==2||original.resource?.url!==scope.endpoint||accepted.scheme!=='agentos-vault'||accepted.network!==`solana:${scope.genesis.slice(0,32)}`||accepted.asset!==(scope.asset==='SOL'?'SOL':'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')||accepted.amount!==scope.amount||accepted.payTo!==scope.provider||accepted.extra?.programId!==scope.program||accepted.extra?.skill!==scope.skill||accepted.extra?.inputHash!==scope.inputHash||payload.agent!==scope.agent||payload.skill!==scope.skill||payload.inputHash!==scope.inputHash||payload.execution!==scope.execution||payload.signature!==scope.signature)throw new Error('Original Skill payment header differs from its verified scope.');
 reserveAttempt();
 const response=await transport(scope.endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json','PAYMENT-SIGNATURE':paymentHeader,'AGENTOS-RESULT-ONLY':'true'},signal:AbortSignal.timeout(55000),body:JSON.stringify({protocol:'agentos-skill-v2',agent:scope.agent,paymentPreference:scope.asset,skill:{address:scope.skill},request:{skill:scope.skill,prompt:scope.input,sha256:scope.inputHash}})});
 if(!response.ok){await response.body?.cancel();throw new Error('Saved Skill response is unavailable; original tool will not be repeated.');}
 const settlement=decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')??'');
 if(!settlement.success||settlement.transaction!==scope.signature||settlement.network!==accepted.network){await response.body?.cancel();throw new Error('Saved Skill response settlement differs from the original payment.');}
 return readResponseTextLimited(response,65536,'Saved Skill response exceeds its limit.');
}
