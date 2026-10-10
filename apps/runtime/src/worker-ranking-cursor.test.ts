import test from 'node:test';
import assert from 'node:assert/strict';
import { workerRankingCursor,nextWorkerRankingCursor,workerRankingPolicy } from './worker-ranking-cursor.js';
const now=1791602000,snapshot='a'.repeat(64);
test('Worker ranking pages keep their original decay time across requests and restart',()=>{
 const first=workerRankingCursor(undefined,now),cursor=nextWorkerRankingCursor(snapshot,first.evaluatedAt,50);
 const second=workerRankingCursor(cursor,now+60);assert.deepEqual(second,{evaluatedAt:now,offset:50,snapshot});
 const later=workerRankingCursor(nextWorkerRankingCursor(snapshot,second.evaluatedAt,100),now+899);assert.equal(later.evaluatedAt,now);assert.equal(later.offset,100);assert.equal(workerRankingPolicy.method,'independent-judge-v2');
 assert.equal(workerRankingCursor(undefined,now+900).evaluatedAt,now+900);
});
test('Expired, future, old policy and malformed Worker cursors cannot alter scoring time',()=>{
 const cursor=nextWorkerRankingCursor(snapshot,now,50);
 assert.throws(()=>workerRankingCursor(cursor,now+900),/expired/);assert.throws(()=>workerRankingCursor(cursor,now-1),/invalid/);
 for(const invalid of [`${snapshot}:50`,cursor.replace('wr2','wr1'),cursor.replace(':50',':51'),cursor.replace(':50',':0'),cursor.replace(':50',':050'),cursor+':50',cursor.replace(String(now),'9999999999999')])assert.throws(()=>workerRankingCursor(invalid,now));
 for(const offset of [0,1,51,20000,NaN])assert.throws(()=>nextWorkerRankingCursor(snapshot,now,offset));
});
