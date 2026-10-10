import { startModelFixture } from '../tests/local/model-fixture.mts';
if (process.env.AGENTOS_CLUSTER !== 'localnet' || process.env.OPENAI_API_KEY !== 'local-test-fixture' || process.env.AGENTOS_LOCAL_MODEL_URL !== 'http://127.0.0.1:19789/v1/responses') throw new Error('Fixture Runtime must be started through the explicit local fixture launcher.');
const fixture = await startModelFixture();
// The fixture and Runtime share one process. Closing only the fixture leaves
// the Runtime listening with an unavailable model backend.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  fixture.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
});
try { await import('../apps/runtime/src/index.ts'); }
catch (cause) { fixture.server.close(); throw cause; }
