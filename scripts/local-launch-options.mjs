import { address } from '@solana/kit';

// Never inherit Worker opt-in from the ambient environment. Local fixture
// discovery requires an explicit list and model mode for this launch. This
// launcher never owns a Session signer or submits a delivery transaction.
export function localLaunchOptions(args) {
  const [target, ...flags] = args;
  if (!['runtime', 'web'].includes(target)) throw new Error('Use runtime or web.');
  if (flags.some(flag => !['--model-fixture', '--real-model'].includes(flag) && !flag.startsWith('--workers='))) throw new Error('Unknown local environment option.');
  if (flags.filter(flag => flag === '--model-fixture').length > 1) throw new Error('Duplicate model fixture option.');
  const fixtureMode = flags.includes('--model-fixture');
  const realModel = flags.includes('--real-model');
  if (flags.filter(flag => flag === '--real-model').length > 1 || fixtureMode && realModel) throw new Error('Choose exactly one explicit model mode.');
  if (fixtureMode && target !== 'runtime') throw new Error('Model fixture mode applies only to the local Runtime.');
  if (realModel && target !== 'runtime') throw new Error('Real model mode applies only to the local Runtime.');
  const workerFlags = flags.filter(flag => flag.startsWith('--workers='));
  if (workerFlags.length > 1) throw new Error('Specify the Worker list once.');
  if (workerFlags.length && (target !== 'runtime' || !fixtureMode && !realModel)) throw new Error('Local Worker discovery requires an explicit Runtime model mode.');
  const workers = workerFlags.length ? workerFlags[0].slice('--workers='.length).split(',') : [];
  if (workerFlags.length && (!workers.length || workers.length > 3 || new Set(workers).size !== workers.length)) throw new Error('Specify one to three distinct Worker Agent addresses.');
  for (const worker of workers) address(worker);
  return { target, fixtureMode, realModel, workers };
}

/** Only explicit real mode may use a credential. Never inherit a fixture URL. */
export function localModelEnvironment(options, inherited = {}, fileValues = {}) {
  if (options.fixtureMode) return { OPENAI_API_KEY: 'local-test-fixture', OPENAI_MODEL: 'local-test-fixture', AGENTOS_LOCAL_MODEL_URL: 'http://127.0.0.1:19789/v1/responses', AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '' };
  if (!options.realModel) return { OPENAI_API_KEY: '', AGENTOS_LOCAL_MODEL_URL: '', AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '' };
  // Treat the file's model and credential as one configuration. Never combine
  // a DeepSeek model with the unrelated ambient OpenAI credential.
  const configured = fileValues.OPENAI_MODEL?.trim().startsWith('deepseek-') ? fileValues : inherited;
  if (configured.OPENAI_MODEL?.trim().startsWith('deepseek-')) {
    const key = (configured.DEEPSEEK_API_KEY ?? configured.OPENAI_API_KEY ?? '').trim();
    const model = configured.OPENAI_MODEL.trim();
    if (!key || key === 'local-test-fixture' || !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) throw new Error('Configure a real DeepSeek key and supported model.');
    return { OPENAI_API_KEY: key, DEEPSEEK_API_KEY: key, OPENAI_MODEL: model, AGENTOS_MODEL_PROVIDER: 'deepseek', AGENTOS_LOCAL_MODEL_URL: '' };
  }
  const key = (inherited.OPENAI_API_KEY ?? fileValues.OPENAI_API_KEY ?? '').trim();
  if (!key || key === 'local-test-fixture') throw new Error('Explicit real model mode requires a real OPENAI_API_KEY in the environment or apps/runtime/.env.');
  const model = (inherited.OPENAI_MODEL ?? fileValues.OPENAI_MODEL ?? 'gpt-6-astra').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new Error('Configure a valid OPENAI_MODEL for real model mode.');
  return { OPENAI_API_KEY: key, OPENAI_MODEL: model, AGENTOS_MODEL_PROVIDER: 'openai', DEEPSEEK_API_KEY: '', AGENTOS_LOCAL_MODEL_URL: '' };
}
