import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, fromJsonSchema, type Tool } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { mcpDiscoverySnapshotSchema,type McpDiscoveryStatus } from './mcp-discovery.js';
import { mcpExecutionScope } from './mcp-execution-scope.js';
import { HeadlessJournal } from './headless-journal.js';
import type { AutonomousAction, AutonomousJob, AutonomousReceipt } from './autonomous-loop.js';
import type { AutonomousTool } from './autonomous-model.js';

export const externalEndpoint = z.string().max(2000).refine(value => {
  try { const url = new URL(value); return url.href === value && !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); }
  catch { return false; }
}, 'Use canonical HTTPS, or local loopback HTTP.');
const serverSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), endpoint: externalEndpoint,
  tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).min(1).max(50),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional() }).strict();
export function parseExternalMcpServers(raw: string) {
  if (Buffer.byteLength(raw) > 100000) throw new Error('External MCP configuration exceeds its limit.');
  const servers = z.array(serverSchema).max(20).parse(JSON.parse(raw));
  if (new Set(servers.map(server => server.id)).size !== servers.length || servers.some(server => new Set(server.tools).size !== server.tools.length))
    throw new Error('External MCP server and tool identities must be unique.');
  return servers;
}
export type ExternalMcpServer = z.infer<typeof serverSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only operator-listed endpoints and tools can be called. MCP annotations and
 * remote descriptions never grant authority. No OAuth redirects, sampling,
 * elicitation, arbitrary resource fetching, or implicit HTTP payment retries. */
export class ExternalMcp {
  private catalogRun?:Promise<AutonomousTool[]>;
  private discovery:McpDiscoveryStatus[];
  constructor(private readonly servers: ExternalMcpServer[], private readonly journal: HeadlessJournal,
    private readonly transport: typeof fetch = fetch,private readonly bindLimits=false,private readonly beforeDispatch?:(job:AutonomousJob,action:AutonomousAction,intentId:string)=>Promise<void>,private readonly catalogTimeoutMs=15000) {
    if(!Number.isInteger(catalogTimeoutMs)||catalogTimeoutMs<1||catalogTimeoutMs>30000)throw new Error('MCP discovery deadline must be between 1 and 30000 ms.');
    this.servers=structuredClone(servers);
    this.discovery=this.servers.map(server=>({server:server.id,state:'not-checked',availableTools:[],missingTools:server.tools.map(name=>`mcp:${server.id}:${name}`),checkedAt:null}));
  }
  private redact<T>(value:T):T{
    const tokens=this.servers.flatMap(server=>{const token=server.tokenEnv?process.env[server.tokenEnv]?.trim():undefined;return token?[token]:[];});
    const scrub=(value:unknown):unknown=>{
      if(typeof value==='string')return tokens.reduce((text,token)=>text.replaceAll(token,'[REDACTED]'),value);
      if(Array.isArray(value))return value.map(scrub);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[scrub(key),scrub(item)]));
      return value;
    };return scrub(value) as T;
  }

  private async connected<T>(server: ExternalMcpServer, work: (client: Client) => Promise<T>,timeoutMs?:number): Promise<T> {
    const deadline=timeoutMs===undefined?undefined:AbortSignal.timeout(timeoutMs);
    const token = server.tokenEnv ? process.env[server.tokenEnv]?.trim() : undefined;
    if (server.tokenEnv && (!token || /[\r\n]/.test(token))) throw new Error('Configured external MCP credential is unavailable.');
    const client = new Client({ name: 'agentos-bounded-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { redirect: 'error', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
      fetch: async (input, init) => {
        if (String(input) !== server.endpoint) throw new Error('External MCP attempted to leave its configured endpoint.');
        const response = await this.transport(input, { ...init, redirect: 'error',
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []),...(deadline?[deadline]:[]), AbortSignal.timeout(30000)]) });
        if (!response.body) return response;
        let size = 0;
        const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          size += chunk.byteLength; if (size > 512000) throw new Error('External MCP response exceeds 512 KB.'); controller.enqueue(chunk);
        } }));
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
    try { await client.connect(transport, { timeout: Math.min(timeoutMs??30000,30000) }); return await work(client); }
    finally { await client.close().catch(() => {}); }
  }

  private async list(client: Client): Promise<Tool[]> {
    const tools: Tool[] = []; const cursors = new Set<string>(); let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result = await client.listTools({ cursor }, { timeout: 30000 });
      tools.push(...result.tools);
      if (tools.length > 500 || new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('External MCP tool listing is oversized or ambiguous.');
      if (!result.nextCursor) return tools;
      if (cursors.has(result.nextCursor)) throw new Error('External MCP pagination repeats a cursor.');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('External MCP listing exceeds ten pages.');
  }

  discoveryStatus():McpDiscoveryStatus[]{return mcpDiscoverySnapshotSchema.parse(this.redact(structuredClone(this.discovery)));}

  catalog(): Promise<AutonomousTool[]> {
    if(!this.catalogRun){const run=this.discover().finally(()=>{if(this.catalogRun===run)this.catalogRun=undefined;});this.catalogRun=run;}
    // Concurrent tenants get independent results; remote text never becomes
    // shared mutable state or grants permission to a new tool.
    return this.catalogRun.then(tools=>structuredClone(tools));
  }
  private async discover():Promise<AutonomousTool[]> {
    const results=await Promise.allSettled(this.servers.map(server=>this.connected(server,async client=>
      (await this.list(client)).filter(tool=>server.tools.includes(tool.name)).map(tool=>({
        id:`mcp:${server.id}:${tool.name}`,description:JSON.stringify({description:tool.description?.slice(0,1000)??tool.name,inputSchema:tool.inputSchema}),prices:{SOL:'0',USDC:'0'},
      })),this.catalogTimeoutMs)));
    const checkedAt=new Date().toISOString(),tools:AutonomousTool[]=[];
    this.discovery=results.map((result,index)=>{
      const server=this.servers[index],available=result.status==='fulfilled'?result.value:[],availableTools=available.map(tool=>tool.id),missingTools=server.tools.map(name=>`mcp:${server.id}:${name}`).filter(id=>!availableTools.includes(id));
      tools.push(...available);
      return {server:server.id,state:result.status==='rejected'?'unavailable':missingTools.length?'partial':'available',availableTools,missingTools,checkedAt};
    });
    // Keep current diagnostics even when the entire discovery fails. Do not
    // return a stale successful catalog or invent tool availability.
    if(this.servers.length&&results.every(result=>result.status==='rejected'))throw new Error('No configured external MCP server could be discovered.');
    return this.redact(tools).map(tool=>({...tool,description:tool.description.slice(0,8000)}));
  }

  private receipt(job: AutonomousJob, intentId: string): AutonomousReceipt | null {
    const record = this.journal.load(job.tenant, job.id, intentId);
    if (!record?.complete || record.content === undefined) return null;
    const action = job.intents.find(intent => intent.id === intentId)?.action;
    if (!action || record.scopeHash !== hash(JSON.stringify({ agent: job.agent, session: job.session, program: job.program, genesis: job.genesis, action })))
      throw new Error('Original MCP response belongs to another execution scope.');
    if((this.bindLimits||record.authorizationScopeHash!==undefined)&&record.authorizationScopeHash!==mcpExecutionScope(job,action))throw new Error('Original MCP authorization limits cannot change.');
    const result=JSON.parse(record.content).result;
    return { id: `mcp:${intentId}`, output: record.content, outputHash: hash(record.content), verified: true,...(result?.isError===true?{outcome:'error' as const}:{}) };
  }
  async reconcile(job: AutonomousJob, intentId: string) { return this.receipt(job, intentId); }

  private rejectedBeforeCall(job:AutonomousJob,action:AutonomousAction,intentId:string,scopeHash:string,code:'invalid-json-object'|'invalid-input-schema'|'tool-unavailable'|'authority-before-discovery'|'authority-before-dispatch'|'discovery-failed'):AutonomousReceipt {
    // This path is reached before callTool or its dispatch checkpoint. Never
    // label a local validation result as an authenticated remote response.
    if(this.journal.load(job.tenant,job.id,intentId))throw new Error('Original external MCP intent already has a record.');
    const reasons={'invalid-json-object':'Tool input must be a serialized JSON object.','invalid-input-schema':'Tool input does not match the current listed JSON schema.','tool-unavailable':'The authorized tool is absent from the current tool list.','authority-before-discovery':'Delegated authority could not be verified before tool discovery.','authority-before-dispatch':'Delegated authority could not be verified immediately before calling the tool.','discovery-failed':'Tool discovery or schema validation failed before calling the tool.'};
    const content=JSON.stringify(this.redact({source:action.tool,assurance:'local-mcp-preflight',dispatched:false,result:{isError:true,code,content:[{type:'text',text:reasons[code]}]}}));
    this.journal.save({tenant:job.tenant,jobId:job.id,intentId,execution:job.agent,scopeHash,content,complete:true,...(this.bindLimits?{authorizationScopeHash:mcpExecutionScope(job,action)}:{})});
    return this.receipt(job,intentId)!;
  }

  async execute(job: AutonomousJob, action: AutonomousAction, intentId: string,validateBeforeDiscovery?:(job:AutonomousJob,action:AutonomousAction,intentId:string)=>Promise<void>): Promise<AutonomousReceipt> {
    job=structuredClone(job);action=structuredClone(action);
    const intent = job.intents.find(intent => intent.id === intentId);
    const parts = action.tool.split(':'); const server = this.servers.find(server => server.id === parts[1]);
    if (!intent || intent.phase !== 'reserved' || JSON.stringify(intent.action) !== JSON.stringify(action) || action.amount !== '0' ||
      !job.limits.tools.includes(action.tool) || parts.length !== 3 || parts[0] !== 'mcp' || !server?.tools.includes(parts[2]))
      throw new Error('External MCP call differs from its authorized reservation.');
    const scopeHash = hash(JSON.stringify({ agent: job.agent, session: job.session, program: job.program, genesis: job.genesis, action }));
    const old = this.journal.load(job.tenant, job.id, intentId);
    if (old) {
      if((this.bindLimits||old.authorizationScopeHash!==undefined)&&old.authorizationScopeHash!==mcpExecutionScope(job,action))throw new Error('Original MCP authorization limits cannot change.');
      if (old.scopeHash !== scopeHash) throw new Error('External MCP intent cannot change scope.');
      const receipt = this.receipt(job, intentId); if (receipt) return receipt;
      throw new Error('Original external MCP effect is unresolved; automatic re-execution is forbidden.');
    }
    // Inspect the original record first: failed authority checks must never
    // overwrite an earlier unknown dispatch or hide an already completed call.
    try{await validateBeforeDiscovery?.(structuredClone(job),structuredClone(action),intentId);}
    catch{return this.rejectedBeforeCall(job,action,intentId,scopeHash,'authority-before-discovery');}
    let args:Record<string,unknown>;
    try{args=z.record(z.string(),z.unknown()).parse(JSON.parse(action.input));}catch{return this.rejectedBeforeCall(job,action,intentId,scopeHash,'invalid-json-object');}
    let discoveryComplete=false;
    try{return await this.connected(server, async client => {
      const tool = (await this.list(client)).find(tool => tool.name === parts[2]);
      if(!tool){discoveryComplete=true;return this.rejectedBeforeCall(job,action,intentId,scopeHash,'tool-unavailable');}
      const validation = await fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0])['~standard'].validate(args);
      discoveryComplete=true;
      if(validation.issues)return this.rejectedBeforeCall(job,action,intentId,scopeHash,'invalid-input-schema');
      // Discovery/schema work is untrusted and can be slow; recheck live
      // delegated authority immediately before exposing the actual tool call.
      try{await this.beforeDispatch?.(structuredClone(job),structuredClone(action),intentId);}
      catch{return this.rejectedBeforeCall(job,action,intentId,scopeHash,'authority-before-dispatch');}
      // Persist before dispatch; a timeout or process crash leaves an unresolved
      // original effect. A new process may read results, but never repeat a call.
      if (this.journal.load(job.tenant, job.id, intentId)) throw new Error('External MCP intent was already dispatched.');
      this.journal.save({ tenant: job.tenant, jobId: job.id, intentId, execution: job.agent, scopeHash, complete: false,...(this.bindLimits?{authorizationScopeHash:mcpExecutionScope(job,action)}:{}) });
      const result = await client.callTool({ name: parts[2], arguments: args }, { timeout: 30000, toolDefinition: tool });
      const content = JSON.stringify(this.redact({ source: action.tool, assurance: 'authenticated-mcp-response', result }));
      if (Buffer.byteLength(content) > 65000) throw new Error('External MCP output exceeds 65 KB.');
      this.journal.save({ tenant: job.tenant, jobId: job.id, intentId, execution: job.agent, scopeHash, content, complete: true,...(this.bindLimits?{authorizationScopeHash:mcpExecutionScope(job,action)}:{}) });
      return this.receipt(job, intentId)!;
    });}catch(cause){
      // Initialization/list/schema errors precede callTool. Once any journal
      // record exists, preserve it; a pending dispatch remains unknown.
      if(discoveryComplete||this.journal.load(job.tenant,job.id,intentId))throw cause;
      return this.rejectedBeforeCall(job,action,intentId,scopeHash,'discovery-failed');
    }
  }
}
