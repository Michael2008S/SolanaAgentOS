import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TenantCredentialRegistry,tenantCredentialChange } from './tenant-credentials.js';
import { readFileTextLimited } from './file-limits.js';
let registry:TenantCredentialRegistry|undefined;
try{
 try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Runtime configuration could not be read.');}
 const path=process.env.AGENTOS_TENANT_CREDENTIAL_DATABASE?.trim();if(!path)throw new Error('Configure AGENTOS_TENANT_CREDENTIAL_DATABASE.');
 registry=new TenantCredentialRegistry(path,undefined,true);
 if([4,5].includes(process.argv.length)&&process.argv[2]==='view'){const tenant=process.argv[3]!,raw=process.argv[4]??'-1';if(!/^(?:-1|0|[1-9][0-9]{0,15})$/.test(raw))throw new Error('Invalid audit cursor.');const audit=registry.history(tenant,Number(raw));console.log(JSON.stringify({scope:registry.snapshot(tenant),audit,nextCursor:audit.length===100?audit.at(-1)!.revision:null},null,2));}
 else if(process.argv.length===4&&process.argv[2]==='change'){const change=tenantCredentialChange.parse(JSON.parse(await readFileTextLimited(process.argv[3]!,16000,'Credential change exceeds 16 KB.')));console.log(JSON.stringify({status:'changed',scope:registry.change(change),signingAuthorityChanged:false,acceptedJobsCancelled:false}));}
 else throw new Error('Use view <tenant> [after revision] or change <reviewed JSON file>. The file accepts token hashes only.');
}catch{console.error('Tenant credential command failed. Check the configured registry, reviewed revision and change fields. No token is printed.');process.exitCode=1;}finally{registry?.close();}
