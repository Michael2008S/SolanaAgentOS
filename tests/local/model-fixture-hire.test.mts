import test from 'node:test';
import assert from 'node:assert/strict';
import { startModelFixture } from './model-fixture.mts';
test('local hire fixture requires explicit terms and a registered Worker', async () => {
  const fixture = await startModelFixture(0);
  const worker = '2Hmhe2nTxv12hrVoH3rp5HaPzYJX9ZCchin53JdwTqQR';
  try {
    const request = (task: string, registeredAgents = [{address:worker}]) => fetch(fixture.url, { method:'POST', headers:{authorization:'Bearer local-test-fixture'}, body:JSON.stringify({text:{format:{name:'agentos_task_plan'}},input:[{role:'user',content:JSON.stringify({task,registeredAgents,registeredSkills:[]})}]}) });
    const response = await request(`LOCAL TEST HIRE ${worker} for 0.01 SOL within 1h`);
    assert.equal(response.status,200);
    const body = await response.json();
    const action = JSON.parse(body.output[0].content[0].text).actions[0];
    assert.equal(action.kind,'hire');assert.equal(action.workerAgent,worker);assert.equal(action.amount,0.01);assert.equal(action.asset,'SOL');assert.equal(action.durationHours,1);
    assert.equal((await request(`LOCAL TEST HIRE ${worker} for 0.01 SOL within 1h`,[])).status,500);
    assert.equal((await request(`LOCAL TEST HIRE ${worker} for 0 SOL within 1h`)).status,500);
    assert.equal((await request(`LOCAL TEST HIRE ${worker} for 0.01 SOL`)).status,500);
  } finally { await new Promise<void>(resolve => fixture.server.close(()=>resolve())); }
});
