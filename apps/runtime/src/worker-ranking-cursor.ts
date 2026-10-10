import { WORKER_REPUTATION_METHOD } from './worker-reputation.js';
const version='wr2',lifetime=15*60,pageSize=50;
export class WorkerRankingCursorError extends Error {}
export function workerRankingCursor(cursor:string|undefined,now=Math.floor(Date.now()/1000)){
 if(!Number.isSafeInteger(now)||now<=0)throw new Error('Invalid Worker evaluation time.');
 if(cursor===undefined)return {evaluatedAt:now,offset:0,snapshot:undefined};
 const match=/^wr2:([a-f0-9]{64}):([1-9][0-9]{0,11}):([1-9][0-9]{0,4})$/.exec(cursor);
 if(!match)throw new WorkerRankingCursorError('Worker ranking cursor is invalid or uses an older scoring method; restart the search.');
 const evaluatedAt=Number(match[2]),offset=Number(match[3]);
 if(evaluatedAt>now||now-evaluatedAt>=lifetime||offset%pageSize)throw new WorkerRankingCursorError('Worker ranking cursor is expired or invalid; restart the search.');
 return {evaluatedAt,offset,snapshot:match[1]};
}
export function nextWorkerRankingCursor(snapshot:string,evaluatedAt:number,offset:number){
 if(!/^[a-f0-9]{64}$/.test(snapshot)||!Number.isSafeInteger(evaluatedAt)||evaluatedAt<=0||!Number.isSafeInteger(offset)||offset<=0||offset>=20000||offset%pageSize)throw new Error('Invalid Worker ranking checkpoint.');
 return `${version}:${snapshot}:${evaluatedAt}:${offset}`;
}
export const workerRankingPolicy={method:WORKER_REPUTATION_METHOD,cursorLifetimeSeconds:lifetime,positiveJudgeDailyLimit:1,positiveJudgeThirtyDayLimit:3};
