import type { AutonomousReceipt } from './autonomous-loop.js';
/** Explicit status for new receipts; recognize original authenticated MCP
 * error envelopes in older checkpoints without rewriting their payload/hash. */
export function autonomousReceiptOutcome(receipt:AutonomousReceipt):'success'|'error'{
 if(receipt.outcome==='error')return 'error';
 if(receipt.id.startsWith('mcp:')){
  try{const value=JSON.parse(receipt.output);if(value?.assurance==='authenticated-mcp-response'&&typeof value.source==='string'&&value.source.startsWith('mcp:')&&value.result?.isError===true)return 'error';}catch{/* Older non-MCP envelopes remain unchanged. */}
 }
 return 'success';
}
