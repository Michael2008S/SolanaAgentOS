import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PaymentRequired } from '@x402/core/types';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { x402IdentifierExtensions } from './x402-payment-identifier.js';
import { standardCredential } from './standard-payments.js';
const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{required:{type:'boolean'},id:{type:'string',minLength:16,maxLength:128}},required:['required']};
const declaration=(required=true):PaymentRequired=>({x402Version:2,resource:{url:'https://example.com/paid'},accepts:[],extensions:{'payment-identifier':{info:{required},schema}}});
test('standard identifier preserves advertised schema and exact stable credential without mutating the quote',()=>{
 const required=declaration(),original=structuredClone(required),identifier='pay_'+randomUUID(),extensions=x402IdentifierExtensions(required,identifier)!;
 assert.deepEqual(extensions,{'payment-identifier':{schema,info:{required:true,id:identifier}}});assert.deepEqual(required,original);
 const challenge={protocol:'x402' as const,required,accepted:{scheme:'exact',network:'solana:local' as const,amount:'1000',asset:'USDC',payTo:'recipient',maxTimeoutSeconds:60,extra:{}}},payment={transaction:Buffer.from('public-fixture-wire').toString('base64')};
 const first=standardCredential(challenge,payment,identifier),second=standardCredential(challenge,payment,identifier);assert.deepEqual(first,second);assert.deepEqual(decodePaymentSignatureHeader(first.value).extensions,extensions);
});
test('required identifier, server-supplied identity, malformed identity and incompatible schema are rejected',()=>{
 assert.throws(()=>x402IdentifierExtensions(declaration()),/before signing/);
 for(const value of ['short','x'.repeat(129),'invalid/identifier-key','spaces are invalid'])assert.throws(()=>x402IdentifierExtensions(declaration(),value));
 assert.throws(()=>x402IdentifierExtensions({...declaration(),extensions:{'payment-identifier':{info:{required:true,id:'server-owned-identifier'},schema}}},'pay_'+randomUUID()));
 assert.throws(()=>x402IdentifierExtensions({...declaration(),extensions:{'payment-identifier':{info:{required:true},schema:{...schema,properties:{...schema.properties,id:{type:'string',minLength:100}}}}}},'pay_'+randomUUID()));
});
test('optional or unsupported identifiers are omitted and external schema references or unsafe patterns never execute',()=>{
 assert.equal(x402IdentifierExtensions(declaration(false)),undefined);assert.equal(x402IdentifierExtensions({...declaration(),extensions:undefined},'pay_'+randomUUID()),undefined);
 for(const changed of [{$ref:'https://untrusted.example/schema'},{type:'string',pattern:'(a+)+$'}])assert.throws(()=>x402IdentifierExtensions({...declaration(),extensions:{'payment-identifier':{info:{required:true},schema:changed}}},'pay_'+randomUUID()),/unsupported|Unsupported/);
});
