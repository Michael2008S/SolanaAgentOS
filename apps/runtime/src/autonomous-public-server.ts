import { createServer,type IncomingMessage,type ServerResponse,type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile,stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { AutonomousController } from './autonomous-controller.js';

export type PublicDirectoryRoutes = { matches: (target: string, method: string) => boolean; handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> };
export type PublicApiConfig={port:number;bind:string;origin:string;browserOrigins:string[];cert?:string;key?:string};
export function publicOrigin(value:string){
 const url=new URL(value);if(value.length>2000||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use a fixed HTTPS origin or a local test origin.');return url.origin;
}
export function parsePublicApiConfig(env:NodeJS.ProcessEnv=process.env):PublicApiConfig|undefined{
 if(!env.AGENTOS_PUBLIC_PORT?.trim())return;
 const raw=env.AGENTOS_PUBLIC_PORT.trim();if(!/^[1-9][0-9]{0,4}$/.test(raw)||Number(raw)>65535)throw new Error('Invalid public API port.');
 const bind=env.AGENTOS_PUBLIC_BIND?.trim()||'127.0.0.1';if(!isIP(bind))throw new Error('Public API bind must be an IP address.');
 const origin=publicOrigin(env.AGENTOS_PUBLIC_API_ORIGIN?.trim()||''),rawOrigins=env.AGENTOS_PUBLIC_BROWSER_ORIGINS?.trim()||'[]';
 if(Buffer.byteLength(rawOrigins)>40000)throw new Error('Public browser origins exceed their limit.');
 const values:unknown=JSON.parse(rawOrigins);if(!Array.isArray(values)||values.length>20||values.some(value=>typeof value!=='string'))throw new Error('Invalid public browser origin list.');
 const browserOrigins=values.map(value=>publicOrigin(value as string));if(new Set(browserOrigins).size!==browserOrigins.length)throw new Error('Public browser origins must be unique.');
 const cert=env.AGENTOS_PUBLIC_TLS_CERT?.trim(),key=env.AGENTOS_PUBLIC_TLS_KEY?.trim();
 if(!!cert!==!!key||!['127.0.0.1','::1'].includes(bind)&&!cert)throw new Error('Non-loopback public APIs require a TLS certificate and transport key.');
 if(cert&&!origin.startsWith('https:'))throw new Error('TLS public API requires an HTTPS origin.');
 return {port:Number(raw),bind,origin,browserOrigins,...(cert?{cert,key}: {})};
}
function route(target:string,method:string){
 // Reject URL normalization, encoded separators, credentials in query strings,
 // unknown routes and methods before reaching the existing local runtime.
 if(target.length>2000||!target.startsWith('/')||/[\\%#]/.test(target))return false;
 const url=new URL(target,'http://localhost');if(target!==url.pathname+url.search)return false;
 const path=url.pathname,read=/^\/api\/autonomous\/(scope|jobs|events|notifications)$/.test(path)||/^\/api\/autonomous\/jobs\/[a-f0-9-]{36}$/.test(path),write=path==='/api/autonomous/jobs'||/^\/api\/autonomous\/jobs\/[a-f0-9-]{36}\/(resume|cancel)$/.test(path);
 if(url.search&&(path!=='/api/autonomous/events'||!/^\?after=(0|[1-9][0-9]{0,15})$/.test(url.search)))return false;
 return method==='GET'?read:method==='POST'?write:method==='OPTIONS'?read||write:false;
}
function fail(response:ServerResponse,status:number,message:string){response.writeHead(status,{'Connection':'close'}).end(JSON.stringify({error:message}));}
export function publicApiHandler(controller:AutonomousController,config:PublicApiConfig,now=()=>Date.now(),directory?:PublicDirectoryRoutes){
 const authority=new URL(config.origin).host,origins=new Set(config.browserOrigins),unauthenticated=new Map<string,{window:number;count:number}>();
 return async(request:IncomingMessage,response:ServerResponse)=>{
  response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
  if(config.origin.startsWith('https:'))response.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
   for(const name of ['host','authorization','origin'])if(request.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()===name).length>1){fail(response,400,'Duplicate request identity headers.');return;}
   if(request.headers.host!==authority){fail(response,421,'Public API host does not match.');return;}
   const directoryRequest=directory?.matches(request.url||'',request.method||'')??false;
   if(!route(request.url||'',request.method||'')&&!directoryRequest){fail(response,404,'Public route not found.');return;}
   const origin=request.headers.origin;if(origin&&!origins.has(origin)){fail(response,403,'This browser origin is not configured.');return;}
   if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
   if(request.method==='OPTIONS'){
    const method=request.headers['access-control-request-method'],headers=String(request.headers['access-control-request-headers']||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
    if(!origin||typeof method!=='string'||!(route(request.url!,method)||directory?.matches(request.url!,method))||headers.some(value=>!['authorization','content-type'].includes(value))){fail(response,403,'Invalid public API preflight.');return;}
    response.setHeader('Access-Control-Allow-Methods','GET,POST');response.setHeader('Access-Control-Allow-Headers','authorization,content-type');response.writeHead(204).end();return;
   }
   if(directoryRequest||!controller.authorized(request)){
    const window=Math.floor(now()/60000),address=request.socket.remoteAddress||'unknown';
    if(unauthenticated.size>=10000)for(const [key,value] of unauthenticated)if(value.window!==window)unauthenticated.delete(key);
    const old=unauthenticated.get(address),count=old?.window===window?old.count+1:1;
    if(!old&&unauthenticated.size>=10000||count>(directoryRequest&&request.method==='GET'?240:60)){response.setHeader('Retry-After','60');fail(response,429,'Please wait before retrying.');return;}
    unauthenticated.set(address,{window,count});if(!directoryRequest){fail(response,401,'Autonomous credentials are required.');return;}
   }
   let incoming=request;
   if(request.method==='POST'){
    if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json'){fail(response,415,'Use application/json.');return;}
    if(request.headers['content-encoding']){fail(response,415,'Compressed request bodies are not supported.');return;}
    const declared=request.headers['content-length'];if(declared&&(!/^[0-9]+$/.test(declared)||Number(declared)>20000)){fail(response,413,'Public request exceeds 20 KB.');return;}
    let size=0;const chunks:Buffer[]=[];for await(const chunk of request.iterator({destroyOnReturn:false})){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>20000){fail(response,413,'Public request exceeds 20 KB.');return;}chunks.push(bytes);}
    const bytes=Buffer.concat(chunks),value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value)){fail(response,422,'Use a JSON object.');return;}
    incoming=Readable.from([bytes]) as IncomingMessage;incoming.headers=request.headers;incoming.method=request.method;
   }else if(request.headers['transfer-encoding']||Number(request.headers['content-length']||0)>0){fail(response,400,'Read requests cannot have a body.');return;}
   if(directoryRequest)await directory!.handle(incoming,response,new URL(request.url!,config.origin));else await controller.handle(incoming,response,new URL(request.url!,config.origin));
  }catch{if(!response.headersSent)fail(response,422,'Public request could not be processed.');else response.destroy();}
 };
}
export async function createPublicApiServer(controller:AutonomousController,config:PublicApiConfig,directory?:PublicDirectoryRoutes):Promise<Server>{
 const handler=publicApiHandler(controller,config,undefined,directory);let server:Server;
 if(config.cert&&config.key){
  try{for(const path of [config.cert,config.key]){const info=await stat(path);if(!info.isFile()||info.size>65536)throw new Error('Invalid transport credential');}
   server=createHttpsServer({cert:await readFile(config.cert),key:await readFile(config.key),minVersion:'TLSv1.2',maxHeaderSize:8192},(request,response)=>void handler(request,response));
  }catch{throw new Error('Public API TLS certificate or transport key could not be loaded.');}
 }else server=createServer({maxHeaderSize:8192},(request,response)=>void handler(request,response));
 server.maxConnections=256;server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.on('upgrade',(_request,socket)=>socket.destroy());server.on('connect',(_request,socket)=>socket.destroy());return server;
}
