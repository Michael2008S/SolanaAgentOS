import { address,getAddressEncoder,type TransactionPartialSigner,type SignatureBytes } from '@solana/kit';
import * as z from 'zod/v4';
import { readResponseTextLimited } from './http-limits.js';

const segment=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const vaultTransitConfigSchema=z.object({
 endpoint:z.string().url().max(2000),mount:segment.default('transit'),key:segment,
 version:z.number().int().min(1).max(2147483647),address:z.string().min(32).max(44),
 tokenEnv:z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/),
 namespace:z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).max(200).optional(),
}).strict();
export type VaultTransitConfig=z.input<typeof vaultTransitConfigSchema>;

/** Public-key-pinned, raw Ed25519 signing. This adapter never requests key material. */
export async function createVaultTransitSigner(input:VaultTransitConfig,env:NodeJS.ProcessEnv=process.env):Promise<TransactionPartialSigner>{
 const config=vaultTransitConfigSchema.parse(input),url=new URL(config.endpoint);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
  !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('Vault requires a fixed HTTPS origin or loopback origin.');
 const credential=env[config.tokenEnv];
 if(!credential||credential.length>8192||/[\r\n]/.test(credential))throw new Error('Configure the Vault credential in the named environment variable.');
 const signerAddress=address(config.address),publicBytes=getAddressEncoder().encode(signerAddress);
 const publicKey=await crypto.subtle.importKey('raw',new Uint8Array(publicBytes),{name:'Ed25519'},false,['verify']);
 async function request(path:string,body?:unknown,abort?:AbortSignal){
  try{
   const response=await fetch(new URL('/v1/'+config.mount+'/'+path,url),{
    method:body===undefined?'GET':'POST',redirect:'error',
    headers:{'X-Vault-Token':credential!,'content-type':'application/json',...(config.namespace?{'X-Vault-Namespace':config.namespace}:{})},
    signal:abort?AbortSignal.any([abort,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
   });
   if(!response.ok){await response.body?.cancel();throw new Error('Request denied.');}
   return JSON.parse(await readResponseTextLimited(response,65536,'Response exceeds limit.'));
  }catch{throw new Error('Protected signer request failed; check Vault availability and policy.');}
 }
 async function checkKey(abort?:AbortSignal){
  const response=await request('keys/'+config.key,undefined,abort),data=response?.data;
  if(!data||data.type!=='ed25519'||data.derived!==false||data.exportable!==false||
   data.allow_plaintext_backup!==false||data.supports_signing!==true||
   (typeof data.min_encryption_version==='number'&&data.min_encryption_version>config.version))throw new Error('Vault key must support non-derived, non-exportable raw Ed25519 at the pinned version.');
  if(data.keys?.[String(config.version)]?.public_key!==Buffer.from(publicBytes).toString('base64'))throw new Error('Vault public key does not match the delegated signer.');
 }
 await checkKey();
 return Object.freeze({address:signerAddress,async signTransactions(transactions,options){
  if(transactions.length>16)throw new Error('Protected signing batch exceeds its limit.');
  // Copy before awaiting: the bytes that are verified must be the bytes requested.
  const messages=transactions.map(transaction=>{
   if(!Object.prototype.hasOwnProperty.call(transaction.signatures,signerAddress))throw new Error('Delegated key is not a required transaction signer.');
   if(!transaction.messageBytes.length||transaction.messageBytes.length>4096)throw new Error('Transaction message exceeds the protected signer limit.');
   return new Uint8Array(transaction.messageBytes);
  });
  await checkKey(options?.abortSignal);
  const dictionaries=[];
  for(const message of messages){
   const response=await request('sign/'+config.key,{input:Buffer.from(message).toString('base64'),key_version:config.version,prehashed:false},options?.abortSignal);
   const prefix='vault:v'+config.version+':',encoded=response?.data?.signature;
   if(typeof encoded!=='string'||!encoded.startsWith(prefix))throw new Error('Protected signature uses an unexpected key version.');
   const base64=encoded.slice(prefix.length),signature=Buffer.from(base64,'base64');
   if(signature.length!==64||signature.toString('base64')!==base64||!await crypto.subtle.verify('Ed25519',publicKey,signature,message))throw new Error('Protected signature does not authenticate the original transaction.');
   dictionaries.push(Object.freeze({[signerAddress]:new Uint8Array(signature) as SignatureBytes}));
  }
  return dictionaries;
 }} satisfies TransactionPartialSigner);
}
