import * as z from 'zod/v4';
import type { PaymentRequired } from '@x402/core/types';
const id=z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const extensionSchema=z.object({info:z.object({required:z.boolean().optional()}).strict(),schema:z.record(z.string(),z.unknown())}).strict();
/** Echo the advertised standard extension; identifiers come from durable local
 * reservations, never the model or resource server. No external schema fetch. */
export function x402IdentifierExtensions(required:PaymentRequired,identifier?:string){
 const offered=required.extensions?.['payment-identifier'];if(offered===undefined)return undefined;
 const extension=extensionSchema.parse(offered);if(Buffer.byteLength(JSON.stringify(extension.schema))>4096)throw new Error('Payment identifier schema exceeds its limit.');
 let nodes=0;
 const inspect=(value:unknown,depth=0)=>{
  if(++nodes>256||depth>20)throw new Error('Payment identifier schema exceeds its complexity limit.');
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
   if(key==='$ref'&&(typeof child!=='string'||!child.startsWith('#')))throw new Error('External payment identifier schema references are unsupported.');
   if(key==='pattern'&&!['^[a-zA-Z0-9_-]+$','^[A-Za-z0-9_-]+$','^[A-Za-z0-9_-]{16,128}$'].includes(String(child)))throw new Error('Unsupported payment identifier schema pattern.');
   inspect(child,depth+1);
  }
 };
 inspect(extension.schema);
 if(identifier===undefined){if(extension.info.required)throw new Error('Resource requires a durable payment identifier before signing.');return undefined;}
 const info={required:extension.info.required??false,id:id.parse(identifier)};
 z.fromJSONSchema(extension.schema).parse(info);
 return {'payment-identifier':{schema:extension.schema,info}};
}
