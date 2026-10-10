import * as z from 'zod/v4';
const tool=z.string().regex(/^mcp:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.-]{1,64}$/);
export const mcpDiscoveryStatusSchema=z.object({server:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),state:z.enum(['not-checked','available','partial','unavailable']),availableTools:z.array(tool).max(50),missingTools:z.array(tool).max(50),checkedAt:z.iso.datetime().nullable()}).strict().refine(value=>{
 const all=[...value.availableTools,...value.missingTools];
 return all.length>=1&&all.length<=50&&new Set(all).size===all.length&&all.every(tool=>tool.startsWith('mcp:'+value.server+':'))
  &&(value.state==='not-checked')===(value.checkedAt===null)
  &&(value.state==='available'?value.availableTools.length>0&&value.missingTools.length===0:value.state==='partial'?value.missingTools.length>0:value.availableTools.length===0&&value.missingTools.length>0);
},'Discovery state must match its fixed server and tool identities.');
export type McpDiscoveryStatus=z.infer<typeof mcpDiscoveryStatusSchema>;
export const mcpDiscoverySnapshotSchema=z.array(mcpDiscoveryStatusSchema).max(20).refine(values=>new Set(values.map(value=>value.server)).size===values.length,'Duplicate discovery servers.');
