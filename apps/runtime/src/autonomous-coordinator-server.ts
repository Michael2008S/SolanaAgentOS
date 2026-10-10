import { createServer } from 'node:http';
import { createHash,timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { loadRuntimeEnv } from './local-provider.js';
import { parseAutonomousTenants } from './autonomous-controller.js';
import { SQLiteAutonomousStore,AutonomousLeaseBusyError } from './autonomous-sqlite.js';
import { AutonomousCoordinator } from './autonomous-coordination.js';
import { AutonomousNotifier,parseNotificationDestinations } from './autonomous-notifications.js';
loadRuntimeEnv();
const token=process.env.AGENTOS_COORDINATOR_TOKEN?.trim()||'';
if(!/^[A-Za-z0-9_-]{24,256}$/.test(token))throw new Error('Configure a separate coordinator operator credential.');
const tenants=parseAutonomousTenants(process.env.AGENTOS_AUTONOMOUS_TENANTS?.trim()||''),program=process.env.AGENTOS_PROGRAM_ID?.trim()||'',genesis=process.env.AGENTOS_COORDINATOR_GENESIS?.trim()||'';
if(!program||!genesis)throw new Error('Pin coordinator Program and full genesis.');
const destinations=parseNotificationDestinations(process.env.AGENTOS_AUTONOMOUS_NOTIFICATIONS?.trim()||'[]',tenants.map(t=>t.tenant));
const store=new SQLiteAutonomousStore(resolve(process.env.AGENTOS_AUTONOMOUS_DATABASE_PATH?.trim()||'apps/runtime/.data/coordinator.sqlite'),new Map(destinations.map(d=>[d.tenant,d.hash])));
const coordinator=new AutonomousCoordinator(store,tenants,{program,genesis}),notifier=new AutonomousNotifier(store,destinations),expected=createHash('sha256').update(token).digest();
const server=createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 const auth=req.headers.authorization;
 if(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='authorization').length!==1||typeof auth!=='string'||!/^Bearer [A-Za-z0-9_-]{24,256}$/.test(auth)||!timingSafeEqual(createHash('sha256').update(auth.slice(7)).digest(),expected)){res.writeHead(401).end('{}');return;}
 if(req.url!=='/coordination'||req.method!=='POST'){res.writeHead(404).end('{}');return;}
 try{
  if(req.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new Error('JSON required.');
  let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>8_000_000)throw new Error('Request too large.');chunks.push(bytes);}
  const result=await coordinator.dispatch(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));const body=JSON.stringify(result);if(Buffer.byteLength(body)>8_000_000)throw new Error('Response too large.');res.end(body);
 }catch(cause){res.writeHead(cause instanceof AutonomousLeaseBusyError?409:422).end('{}');}
});
server.requestTimeout=20000;server.headersTimeout=10000;server.maxConnections=100;server.maxHeadersCount=40;
const port=Number(process.env.AGENTOS_COORDINATOR_PORT||8791);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid coordinator port.');
server.listen(port,'127.0.0.1',()=>{notifier.start();console.log('Task coordinator listening on loopback.');});
let closing=false;async function close(){if(closing)return;closing=true;const drained=new Promise<void>(done=>server.close(()=>done()));server.closeIdleConnections();await drained;await notifier.stop();await coordinator.close();store.close();}
process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
