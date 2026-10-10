import test from 'node:test';
import assert from 'node:assert/strict';
import { localLaunchOptions, localModelEnvironment } from '../../scripts/local-launch-options.mjs';
const worker = '2Hmhe2nTxv12hrVoH3rp5HaPzYJX9ZCchin53JdwTqQR';
const other = 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
test('local launch defaults never opt into Worker discovery', () => {
  assert.deepEqual(localLaunchOptions(['runtime']), { target: 'runtime', fixtureMode: false, realModel: false, workers: [] });
  assert.deepEqual(localLaunchOptions(['runtime', '--model-fixture']), { target: 'runtime', fixtureMode: true, realModel: false, workers: [] });
});
test('explicit fixture launch accepts distinct public Worker addresses', () => {
  assert.deepEqual(localLaunchOptions(['runtime', '--model-fixture', `--workers=${worker},${other}`]).workers, [worker, other]);
});
test('Worker discovery cannot enable a real model or a web signer', () => {
  for (const args of [['runtime', `--workers=${worker}`], ['web', `--workers=${worker}`], ['web', '--model-fixture', `--workers=${worker}`]]) assert.throws(() => localLaunchOptions(args));
});
test('local launch rejects malformed, repeated and excessive options', () => {
  for (const flags of [['--workers='], ['--workers=not-an-address'], [`--workers=${worker},${worker}`], [`--workers=${worker}`, `--workers=${other}`], [`--workers=${worker},${other},11111111111111111111111111111111,Vote111111111111111111111111111111111111111`], ['--model-fixture'], ['--unknown']]) assert.throws(() => localLaunchOptions(['runtime', '--model-fixture', ...flags]));
});
test('real models require a separate explicit Runtime opt-in', () => {
  assert.equal(localLaunchOptions(['runtime', '--real-model']).realModel, true);
  assert.deepEqual(localLaunchOptions(['runtime', '--real-model', `--workers=${worker}`]).workers, [worker]);
  for (const args of [['web', '--real-model'], ['runtime', '--real-model', '--model-fixture'], ['runtime', '--real-model', '--real-model']]) assert.throws(() => localLaunchOptions(args));
});
test('offline and fixture modes never forward a real credential or inherited transport', () => {
  const inherited = { OPENAI_API_KEY: 'test-credential', AGENTOS_LOCAL_MODEL_URL: 'https://example.com/collect' };
  assert.deepEqual(localModelEnvironment(localLaunchOptions(['runtime']), inherited), { OPENAI_API_KEY: '', AGENTOS_LOCAL_MODEL_URL: '', AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '' });
  assert.deepEqual(localModelEnvironment(localLaunchOptions(['runtime', '--model-fixture']), inherited), { OPENAI_API_KEY: 'local-test-fixture', OPENAI_MODEL: 'local-test-fixture', AGENTOS_LOCAL_MODEL_URL: 'http://127.0.0.1:19789/v1/responses', AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '' });
});
test('real mode rejects missing credentials and always clears fixture transport', () => {
  const options = localLaunchOptions(['runtime', '--real-model']);
  for (const values of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: 'local-test-fixture' }]) assert.throws(() => localModelEnvironment(options, values));
  assert.deepEqual(localModelEnvironment(options, { OPENAI_API_KEY: 'test-credential', OPENAI_MODEL: 'test-model', AGENTOS_LOCAL_MODEL_URL: 'http://127.0.0.1:19789/v1/responses' }), { OPENAI_API_KEY: 'test-credential', OPENAI_MODEL: 'test-model', AGENTOS_LOCAL_MODEL_URL: '', AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '' });
  assert.equal(localModelEnvironment(options, {}, { OPENAI_API_KEY: 'test-file-credential', OPENAI_MODEL: 'test-file-model' }).OPENAI_MODEL, 'test-file-model');
  assert.throws(() => localModelEnvironment(options, { OPENAI_API_KEY: 'test-credential', OPENAI_MODEL: 'invalid/model' }));
});
test('DeepSeek file configuration cannot borrow ambient OpenAI credentials', () => {
 const options = localLaunchOptions(['runtime', '--real-model']);
 const value = localModelEnvironment(options, { OPENAI_API_KEY: 'ambient-openai-key', OPENAI_MODEL: 'openai-model' }, { OPENAI_API_KEY: 'file-deepseek-key', OPENAI_MODEL: 'deepseek-flash' });
 assert.equal(value.DEEPSEEK_API_KEY, 'file-deepseek-key'); assert.equal(value.OPENAI_API_KEY, 'file-deepseek-key'); assert.equal(value.AGENTOS_MODEL_PROVIDER, 'deepseek');
 assert.throws(() => localModelEnvironment(options, { OPENAI_API_KEY: 'ambient-openai-key' }, { OPENAI_MODEL: 'deepseek-flash' }));
});
