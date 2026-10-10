import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { lstat,writeFile } from 'node:fs/promises';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { RemoteAutonomousStore } from './remote-autonomous-store.js';
import { cancellationRequest,operatorJobReview } from './autonomous-operator.js';
import { readFileTextLimited } from './file-limits.js';
let local:SQLiteAutonomousStore|undefined;
try{
 try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Configuration could not be read.');}
 const endpoint=process.env.AGENTOS_TASK_COORDINATOR?.trim();let store:SQLiteAutonomousStore|RemoteAutonomousStore;
 if(endpoint)store=new RemoteAutonomousStore(endpoint,process.env.AGENTOS_TASK_COORDINATOR_TOKEN?.trim()||'');
 else {const path=process.env.AGENTOS_AUTONOMOUS_DATABASE_PATH?.trim();if(!path)throw new Error('Configure an existing autonomous database or coordinator.');const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid autonomous database.');store=local=new SQLiteAutonomousStore(path);}
 if(process.argv[2]==='review'&&process.argv.length===6){const job=await store.load(process.argv[3]!,process.argv[4]!),review=operatorJobReview(job);await writeFile(process.argv[5]!,JSON.stringify(review.request,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({...review,reviewFile:process.argv[5],audit:await store.cancellationHistory(job.tenant,job.id)},null,2));}
 else if(process.argv[2]==='view'&&process.argv.length===5){const job=await store.load(process.argv[3]!,process.argv[4]!);console.log(JSON.stringify({...operatorJobReview(job),cancellationRequested:await store.cancelled(job.tenant,job.id),audit:await store.cancellationHistory(job.tenant,job.id)},null,2));}
 else if(process.argv[2]==='cancel'&&process.argv.length===4){const request=cancellationRequest.parse(JSON.parse(await readFileTextLimited(process.argv[3]!,16000,'Cancellation review exceeds 16 KB.')));console.log(JSON.stringify(await store.reviewedCancellation(request),null,2));}
 else throw new Error('Use review <tenant> <job UUID> <new file>, view <tenant> <job UUID>, or cancel <reviewed file>.');
}catch{console.error('Autonomous operator command failed. Check the existing store/coordinator, original job scope and reviewed file. No credentials are printed.');process.exitCode=1;}finally{local?.close();}
