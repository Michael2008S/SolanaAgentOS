/** @jsxImportSource ./i18n */
import React,{useEffect,useState} from 'react';
import { PROGRAM_ADDRESS } from './lib/agentOs';
import { WEB_NETWORK,NETWORK_LABEL } from './lib/chainNetwork';
import { backgroundApiUrl } from './lib/backgroundApi';
type Scope={agent:string;session:string;program:string;genesis:string;limits:{sol:string;usdc:string;maxCycles:number;maxModelRequests:number;tools:string[]}};
type Job={id:string;goal:string;state:string;cycle:number;spent:{sol:string;usdc:string};answer?:string};
type Notifications={configured:boolean;deliveries:{id:string;jobId:string;state:string;status:'pending'|'sent'|'failed';destinationChanged:boolean}[]};
const amount=(value:string,decimals:number)=>{const n=BigInt(value),scale=10n**BigInt(decimals);const fraction=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return (n/scale).toString()+(fraction?'.'+fraction:'');};
const states:Record<string,string>={planning:'Planning',executing:'Working',evaluating:'Checking results',completed:'Completed',needs_reconciliation:'Checking original payment',failed:'Stopped',cancelled:'Cancelled'};
async function api(path:string,token:string,body?:unknown,signal?:AbortSignal){
 const response=await fetch(backgroundApiUrl(path,import.meta.env.VITE_AUTONOMOUS_API_ORIGIN?.trim()||''),{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 const raw=await response.text();if(raw.length>2_000_000)throw new Error('Background response is too large.');const value=JSON.parse(raw);
 if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'Background service is unavailable.');return value;
}
export function HeadlessJobsPanel({agent,session}:{agent:string;session?:string}){
 const [inputToken,setInputToken]=useState(''),[connection,setConnection]=useState<{token:string;scope:Scope}|null>(null);
 const [answerChecks,setAnswerChecks]=useState('');
 const [goal,setGoal]=useState(''),[jobs,setJobs]=useState<Job[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [notifications,setNotifications]=useState<Notifications|null>(null);
 useEffect(()=>{
  if(!connection)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,cursor=0;
  async function refresh(){try{
   const value=await api('jobs',connection!.token,undefined,controller.signal);if(!controller.signal.aborted){setJobs(value.jobs);setError('');}
   const events=await api('events?after='+cursor,connection!.token,undefined,controller.signal);if(!controller.signal.aborted){cursor=events.cursor;const finished=events.events.filter((event:{state:string})=>['completed','failed','cancelled','needs_reconciliation'].includes(event.state)).at(-1);if(finished)setNotice(states[finished.state]??finished.state);}
   const deliveries=await api('notifications',connection!.token,undefined,controller.signal);if(!controller.signal.aborted)setNotifications(deliveries);
  }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Background status is unavailable.');}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void refresh(),10000);}}
  void refresh();return()=>{controller.abort();clearTimeout(timer);};
 },[connection]);
 async function connect(){setBusy(true);setError('');try{
  const token=inputToken.trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error('Enter the access token for your background service.');
  const scope=await api('scope',token) as Scope;
  if(scope.agent!==agent||scope.program!==PROGRAM_ADDRESS||scope.genesis!==WEB_NETWORK.genesisHash||scope.session!==session)throw new Error('The service must use this Agent, Session and network.');
  setConnection({token,scope});setInputToken('');setJobs([]);setNotice('');setNotifications(null);
 }catch(cause){setError(cause instanceof Error?cause.message:'Could not connect to background work.');}finally{setBusy(false);}}
 async function start(){if(!connection)return;setBusy(true);setError('');try{await api('jobs',connection.token,{goal,...(answerChecks.trim()?{acceptance:{answerIncludes:answerChecks.split('\n').map(value=>value.trim()).filter(Boolean),evidence:[]}}:{})});setGoal('');setAnswerChecks('');setJobs((await api('jobs',connection.token)).jobs);}catch(cause){setError(cause instanceof Error?cause.message:'Could not start background work.');}finally{setBusy(false);}}
 async function action(id:string,kind:'cancel'|'resume'){if(!connection)return;setBusy(true);setError('');try{await api('jobs/'+id+'/'+kind,connection.token,{});setNotice(kind==='cancel'?'Stopping after the current action':'Checking the original task');}catch(cause){setError(cause instanceof Error?cause.message:'Could not update background work.');}finally{setBusy(false);}}
 return <section className="panel" style={{padding:24,marginBottom:24}}>
  <div className="section-kicker">BACKGROUND WORK</div><h3>Continue after closing the browser</h3>
  <p>The service plans, checks its results and continues within your delegated limits. Reopening this page shows the same saved work.</p>
  {!connection?<form className="chain-form" onSubmit={event=>{event.preventDefault();void connect();}}>
   <label>Service access token<input type="password" autoComplete="off" value={inputToken} onChange={event=>setInputToken(event.target.value)} required/></label>
   <small>This is a service access token, never a wallet key or recovery phrase. It stays in this tab.</small>
   <button className="outline-button" disabled={busy||!session}>Connect to background work</button>
  </form>:<>
   <p>{NETWORK_LABEL} · {connection.scope.limits.tools.length} allowed tools · maximum {amount(connection.scope.limits.sol,9)} SOL / {amount(connection.scope.limits.usdc,6)} USDC per job.</p>
   <p>Up to {connection.scope.limits.maxCycles} planning rounds and {connection.scope.limits.maxModelRequests} model requests. Model and service calls may incur charges.</p>
   {notifications&&<div role="status"><p>{notifications.configured?'Result notifications are enabled for this service.':'Result notifications are not configured. Reopen this page to check saved work.'}</p>
    {notifications.deliveries.some(item=>item.status==='failed'||item.destinationChanged)&&<p>Some result notifications need attention. Your saved work is still available below.</p>}
    {notifications.deliveries.some(item=>item.status==='pending'&&!item.destinationChanged)&&<small>Result notifications are waiting for delivery.</small>}
   </div>}
   <form className="chain-form" onSubmit={event=>{event.preventDefault();void start();}}><label>Goal<textarea value={goal} onChange={event=>setGoal(event.target.value)} minLength={4} maxLength={3000} required /></label><label>Required answer phrases (optional)<textarea value={answerChecks} onChange={event=>setAnswerChecks(event.target.value)} maxLength={4000}/></label><small>One phrase per line, up to 20 phrases of 200 characters. These checks cover content, not factual accuracy.</small><button className="primary-button" disabled={busy}>Start background job</button></form>
   {notice&&<p role="status">{notice}</p>}
   {jobs.map(job=><article key={job.id} style={{padding:'16px 0',borderBottom:'1px solid var(--border)'}}><strong>{job.goal}</strong><p>{states[job.state]??job.state} · round {job.cycle} · {amount(job.spent.sol,9)} SOL / {amount(job.spent.usdc,6)} USDC reserved</p>
    {job.answer&&<p style={{whiteSpace:'pre-wrap'}}>{job.answer}</p>}
    {['planning','executing','evaluating','needs_reconciliation'].includes(job.state)&&<button className="outline-button" disabled={busy} onClick={()=>void action(job.id,'cancel')}>Stop future actions</button>}
    {job.state==='needs_reconciliation'&&<button className="outline-button" disabled={busy} onClick={()=>void action(job.id,'resume')}>Check original result</button>}
   </article>)}
   <button className="text-link" disabled={busy} onClick={()=>{setConnection(null);setInputToken('');setJobs([]);setNotice('');setError('');setNotifications(null);}}>Disconnect this page</button><small>Disconnecting this page does not cancel server jobs.</small>
  </>}
  {error&&<div className="inline-error" role="alert">{error}</div>}
 </section>;
}
