import { readResponseTextLimited } from './http-limits.js';
import { reserveModelRequest } from './model-budget.js';
import { redactModelError, recordModelDiagnostic } from './model-diagnostics.js';
const endpoint = 'https://api.deepseek.com/chat/completions';
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export class DeepseekResponseError extends Error {
 constructor(readonly diagnostics: { modelMatched: boolean; singleChoice: boolean; finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'; assistantRole: boolean; hasText: boolean; hasToolCalls: boolean }) {
  super(`DeepSeek returned an incomplete or unsupported response (model matched: ${diagnostics.modelMatched}; finish: ${diagnostics.finishReason}; text present: ${diagnostics.hasText}).`);
  this.name = 'DeepseekResponseError';
 }
}

/** Only text/JSON requests are translated; web-search tools are never faked. */
export function deepseekChatBody(value: unknown) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model request.');
 const request = value as Record<string, any>;
 if (!['deepseek-flash', 'deepseek-v4-pro'].includes(request.model) || !Array.isArray(request.input) || !request.input.length || request.tools || request.tool_choice || request.stream || request.previous_response_id) throw new Error('Unsupported DeepSeek model request.');
 const messages: Message[] = request.input.map((row: unknown) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid model message.');
  const message = row as Message;
  if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('Only text model messages are supported.');
  return { role: message.role, content: message.content };
 });
 const maxTokens = request.max_output_tokens;
 if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2500) throw new Error('DeepSeek output must be limited to 2,500 tokens.');
 const format = request.text?.format;
 if (format) {
  if (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object') throw new Error('Unsupported model output format.');
  messages.unshift({ role: 'system', content: `Return one JSON object conforming to this JSON schema, without extra fields. Do not wrap the JSON in a Markdown code fence or put any text outside it. Markdown inside JSON string values is allowed when requested. The application validates it independently: ${JSON.stringify(format.schema)}` });
 }
 return { model: request.model, messages, max_tokens: maxTokens, thinking: { type: 'disabled' }, stream: false, ...(format ? { response_format: { type: 'json_object' } } : {}) };
}

export async function fetchDeepseekResponse(init: RequestInit): Promise<Response> {
 if (init.method !== 'POST' || typeof init.body !== 'string') throw new Error('DeepSeek requires a bounded POST request.');
 const body = deepseekChatBody(JSON.parse(init.body));
 const key = process.env.DEEPSEEK_API_KEY?.trim();
 if (!key || key === 'local-test-fixture') throw new Error('Configure a separate DEEPSEEK_API_KEY.');
 await reserveModelRequest(endpoint, body.model, body.max_tokens);
 let response: Response;
 try { response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: init.signal ?? AbortSignal.timeout(45000) }); }
 catch(error) { const name=error instanceof Error && ['TimeoutError','AbortError','TypeError'].includes(error.name)?error.name:'TransportError';await recordModelDiagnostic({phase:'transport',message:name});throw new Error('DeepSeek transport failed ('+name+').'); }
 if (!response.ok) {
  let detail: unknown;
  try { const error=JSON.parse(await readResponseTextLimited(response,16000,'Upstream error exceeded 16 KB.'));detail=error?.error?.message; } catch { detail='Upstream error body unavailable.'; }
  const message=`DeepSeek returned HTTP ${response.status}: ${redactModelError(detail)}`;
  await recordModelDiagnostic({phase:'http',status:response.status,message});
  throw new Error(message);
 }
 let payload: any;
 try { payload = JSON.parse(await readResponseTextLimited(response, 1_000_000, 'DeepSeek response exceeded 1 MB.')); }
 catch { throw new Error('DeepSeek returned malformed JSON or an oversized response.'); }
 if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('DeepSeek returned a malformed response object.');
 const choice = payload.choices?.[0], message = choice?.message;
 if (payload.model !== body.model || !Array.isArray(payload.choices) || payload.choices.length !== 1 || choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || message.tool_calls?.length) {
  throw new DeepseekResponseError({ modelMatched: payload.model === body.model, singleChoice: Array.isArray(payload.choices) && payload.choices.length === 1, finishReason: ['stop', 'length', 'tool_calls', 'content_filter'].includes(choice?.finish_reason) ? choice.finish_reason : 'other', assistantRole: message?.role === 'assistant', hasText: typeof message?.content === 'string' && Boolean(message.content.trim()), hasToolCalls: Boolean(message?.tool_calls?.length) });
 }
 return new Response(JSON.stringify({ status: 'completed', model: payload.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] }], usage: payload.usage }), { headers: { 'content-type': 'application/json' } });
}
