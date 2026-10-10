import {
  AccountRole, addSignersToInstruction, address, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction, type KeyPairSigner,
} from '@solana/kit';
import { encodeEscrowSettlementTerms, type EscrowSettlementTerms } from './escrowSettlement';
export { settlementAmountToBaseUnits } from './escrowSettlement';

export const PROGRAM_ADDRESS = address(import.meta.env?.VITE_AGENTOS_PROGRAM_ID ?? 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv');
export const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');
export const DEVNET_USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TOKEN_PROGRAM_ADDRESS = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const encoder = getAddressEncoder();
const utf8 = (value: string) => new TextEncoder().encode(value);

export type ActionName = 'api' | 'payment' | 'escrow';
export type AgentAddresses = { agent: Address; policy: Address; reputation: Address; vault: Address };

export function solToLamports(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a positive SOL amount.');
  return BigInt(Math.round(value * 1_000_000_000));
}

export function usdcToBaseUnits(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) throw new Error('Enter a USDC amount with up to 6 decimal places.');
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new Error('Enter a positive USDC amount.');
  return amount;
}

export function formatUsdcBaseUnits(value: string | bigint): string {
  const baseUnits = typeof value === 'bigint' ? value : BigInt(value);
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function deriveUsdcTokenAddress(owner: Address): Promise<Address> {
  const [tokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM_ADDRESS), encoder.encode(DEVNET_USDC_MINT)],
  });
  return tokenAddress;
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('Amount is outside the supported range.');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) throw new Error('Timestamp is outside the supported range.');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

async function discriminator(name: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', utf8(`global:${name}`));
  return new Uint8Array(hash).slice(0, 8);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function fixedName(value: string): Uint8Array {
  const encoded = utf8(value.trim());
  if (!encoded.length || encoded.length > 32) throw new Error('Agent name must contain 1–32 UTF-8 bytes.');
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
}

export async function deriveAgentAddresses(owner: Address, agentId: Uint8Array): Promise<AgentAddresses> {
  const ownerBytes = encoder.encode(owner);
  const [agent] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('agent'), ownerBytes, agentId] });
  const agentBytes = encoder.encode(agent);
  const [[policy], [reputation], [vault]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), agentBytes] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), agentBytes] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), agentBytes] }),
  ]);
  return { agent, policy, reputation, vault };
}

export async function buildInitializeAgent(owner: Address, name: string, dailyLimitSol: number, perTxLimitSol: number, dailyLimitUsdc: number, perTxLimitUsdc: number, allowed: ActionName[]) {
  const agentId = crypto.getRandomValues(new Uint8Array(32));
  const accounts = await deriveAgentAddresses(owner, agentId);
  const actionMask = (allowed.includes('payment') ? 1 : 0)
    | (allowed.includes('escrow') ? 2 | 8 : 0)
    | (allowed.includes('api') ? 4 : 0);
  const data = concat(
    await discriminator('initialize_agent'),
    agentId,
    fixedName(name),
    u64(solToLamports(dailyLimitSol)),
    u64(solToLamports(perTxLimitSol)),
    u64(usdcToBaseUnits(String(dailyLimitUsdc))),
    u64(usdcToBaseUnits(String(perTxLimitUsdc))),
    Uint8Array.of(actionMask),
  );
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: accounts.agent, role: AccountRole.WRITABLE },
      { address: accounts.policy, role: AccountRole.WRITABLE },
      { address: accounts.reputation, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data,
  };
  return { instruction, accounts, agentIdHex: Array.from(agentId, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export async function buildDeposit(owner: Address, agent: Address, vault: Address, amountSol: number): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: vault, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('deposit'), u64(solToLamports(amountSol))),
  };
}

function buildSystemTransfer(from: Address, to: Address, amountSol: number): Instruction {
  const lamports = solToLamports(amountSol);
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // SystemProgram::Transfer
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

export function buildFundSessionFeeReserve(owner: Address, sessionKey: Address, amountSol: number): Instruction {
  return buildSystemTransfer(owner, sessionKey, amountSol);
}

export function buildReturnSessionFeeReserve(sessionKey: Address, owner: Address, amountSol: number): Instruction {
  return buildSystemTransfer(sessionKey, owner, amountSol);
}

export async function buildDepositUsdc(owner: Address, agent: Address, amount: string): Promise<Instruction> {
  const [ownerTokenAccount, vaultTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(owner), deriveUsdcTokenAddress(agent),
  ]);
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: ownerTokenAccount, role: AccountRole.WRITABLE },
      { address: vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('deposit_usdc'), u64(usdcToBaseUnits(amount))),
  };
}

export async function buildWithdrawUsdc(owner: Address, agent: Address, amount: string): Promise<Instruction> {
  const [vaultTokenAccount, destinationTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(agent), deriveUsdcTokenAddress(owner),
  ]);
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: destinationTokenAccount, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('withdraw_usdc'), u64(usdcToBaseUnits(amount))),
  };
}

export async function buildUpdatePolicy(owner: Address, agent: Address, policy: Address, dailyLimitSol: number, perTxLimitSol: number, dailyLimitUsdc: number, perTxLimitUsdc: number, allowed: ActionName[], paused = false): Promise<Instruction> {
  const actionMask = (allowed.includes('payment') ? 1 : 0)
    | (allowed.includes('escrow') ? 2 | 8 : 0)
    | (allowed.includes('api') ? 4 : 0);
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
    ],
    data: concat(
      await discriminator('update_policy'),
      u64(solToLamports(dailyLimitSol)),
      u64(solToLamports(perTxLimitSol)),
      u64(usdcToBaseUnits(String(dailyLimitUsdc))),
      u64(usdcToBaseUnits(String(perTxLimitUsdc))),
      Uint8Array.of(actionMask, paused ? 1 : 0),
    ),
  };
}

export async function buildSetAgentStatus(owner: Address, agent: Address, paused: boolean): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
    ],
    // Anchor serializes Active as 0 and Paused as 1.
    data: concat(await discriminator('set_agent_status'), Uint8Array.of(paused ? 1 : 0)),
  };
}

export async function buildWithdraw(owner: Address, agent: Address, vault: Address, destination: Address, amountSol: number): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: vault, role: AccountRole.WRITABLE },
      { address: destination, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('withdraw'), u64(solToLamports(amountSol))),
  };
}

export async function deriveSessionAddress(agent: Address, sessionKey: Address): Promise<Address> {
  const [session] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('session'), encoder.encode(agent), encoder.encode(sessionKey)],
  });
  return session;
}

export async function buildCreateSession(
  owner: Address,
  agent: Address,
  policy: Address,
  sessionKey: Address,
  expiresAt: bigint,
  maxPerTxSol: number,
  maxTotalSol: number,
  maxPerTxUsdc: number,
  maxTotalUsdc: number,
  allowed: ActionName[],
) {
  const session = await deriveSessionAddress(agent, sessionKey);
  const permissions = (allowed.includes('payment') ? 1 : 0)
    | (allowed.includes('escrow') ? 2 | 8 : 0)
    | (allowed.includes('api') ? 4 : 0);
  return {
    session,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: owner, role: AccountRole.WRITABLE_SIGNER },
        { address: agent, role: AccountRole.READONLY },
        { address: policy, role: AccountRole.READONLY },
        { address: sessionKey, role: AccountRole.READONLY },
        { address: session, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: concat(
        await discriminator('create_session'),
        i64(expiresAt),
        u64(solToLamports(maxPerTxSol)),
        u64(solToLamports(maxTotalSol)),
        u64(usdcToBaseUnits(String(maxPerTxUsdc))),
        u64(usdcToBaseUnits(String(maxTotalUsdc))),
        Uint8Array.of(permissions),
      ),
    } satisfies Instruction,
  };
}

export async function buildRevokeSession(owner: Address, agent: Address, sessionKey: Address) {
  const session = await deriveSessionAddress(agent, sessionKey);
  return {
    session,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: owner, role: AccountRole.READONLY_SIGNER },
        { address: agent, role: AccountRole.READONLY },
        { address: session, role: AccountRole.WRITABLE },
      ],
      data: await discriminator('revoke_session'),
    } satisfies Instruction,
  };
}

export async function deriveSkillAddress(provider: Address, skillId: Uint8Array): Promise<Address> {
  if (skillId.length !== 32) throw new Error('Skill ID must be exactly 32 bytes.');
  const [skill] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('skill'), encoder.encode(provider), skillId],
  });
  return skill;
}

export async function buildRegisterSkill(provider: Address, skillId: Uint8Array, endpointHash: Uint8Array, priceSol: number, priceUsdc: string) {
  if (skillId.length !== 32 || endpointHash.length !== 32) throw new Error('Skill ID and endpoint hash must each be 32 bytes.');
  const priceSolLamports = priceSol === 0 ? 0n : solToLamports(priceSol);
  const priceUsdcBaseUnits = optionalUsdcToBaseUnits(priceUsdc);
  if (priceSolLamports === 0n && priceUsdcBaseUnits === 0n) throw new Error('Set a positive price in SOL or USDC.');
  const skill = await deriveSkillAddress(provider, skillId);
  return {
    skill,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: provider, role: AccountRole.WRITABLE_SIGNER },
        { address: skill, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: concat(await discriminator('register_skill'), skillId, endpointHash, u64(priceSolLamports), u64(priceUsdcBaseUnits), Uint8Array.of(1)),
    } satisfies Instruction,
  };
}

export async function buildUpdateSkill(provider: Address, skill: Address, endpointHash: Uint8Array, priceSol: number, priceUsdc: string, active: boolean): Promise<Instruction> {
  if (endpointHash.length !== 32) throw new Error('Endpoint hash must be 32 bytes.');
  const priceSolLamports = priceSol === 0 ? 0n : solToLamports(priceSol);
  const priceUsdcBaseUnits = optionalUsdcToBaseUnits(priceUsdc);
  if (priceSolLamports === 0n && priceUsdcBaseUnits === 0n) throw new Error('Set a positive price in SOL or USDC.');
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: provider, role: AccountRole.READONLY_SIGNER },
      { address: skill, role: AccountRole.WRITABLE },
    ],
    data: concat(await discriminator('update_skill'), u64(priceSolLamports), u64(priceUsdcBaseUnits), Uint8Array.of(active ? 1 : 0), endpointHash),
  };
}

function optionalUsdcToBaseUnits(value: string): bigint {
  const normalized = value.trim();
  if (!normalized || /^0(?:\.0{1,6})?$/.test(normalized)) return 0n;
  return usdcToBaseUnits(normalized);
}

export async function buildExecutePayment(
  feePayer: Address,
  agent: Address,
  policy: Address,
  vault: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  recipient: Address,
  amountSol: number,
  inputHash: Uint8Array,
  outputHash: Uint8Array,
  executionId: bigint,
) {
  if (inputHash.length !== 32 || outputHash.length !== 32) throw new Error('Execution hashes must be 32 bytes each.');
  const [execution] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: recipient, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(
      await discriminator('execute_payment'),
      u64(solToLamports(amountSol)),
      inputHash,
      outputHash,
      u64(executionId),
    ),
  };
  return { execution, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildPaySkill(
  feePayer: Address,
  agent: Address,
  policy: Address,
  vault: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  skill: Address,
  provider: Address,
  expectedPrice: bigint,
  inputHash: Uint8Array,
  executionId: bigint,
) {
  if (inputHash.length !== 32) throw new Error('Skill request hash must be 32 bytes.');
  const [execution] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: skill, role: AccountRole.READONLY },
      { address: provider, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('pay_skill'), u64(expectedPrice), inputHash, u64(executionId)),
  };
  return { execution, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildPayUsdcSkill(
  feePayer: Address,
  agent: Address,
  policy: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  skill: Address,
  provider: Address,
  expectedPrice: bigint,
  inputHash: Uint8Array,
  executionId: bigint,
) {
  if (inputHash.length !== 32) throw new Error('Skill request hash must be 32 bytes.');
  const [[execution], [vaultTokenAccount, providerTokenAccount]] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: PROGRAM_ADDRESS,
      seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
    }),
    Promise.all([deriveUsdcTokenAddress(agent), deriveUsdcTokenAddress(provider)]),
  ]);
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: skill, role: AccountRole.READONLY },
      { address: provider, role: AccountRole.WRITABLE },
      { address: providerTokenAccount, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('pay_usdc_skill'), u64(expectedPrice), inputHash, u64(executionId)),
  };
  return { execution, vaultTokenAccount, providerTokenAccount, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildRecordSkillResult(
  feePayer: Address,
  agent: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  execution: Address,
  outputHash: Uint8Array,
): Promise<Instruction> {
  if (outputHash.length !== 32) throw new Error('Skill result hash must be 32 bytes.');
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: session, role: AccountRole.READONLY },
      { address: execution, role: AccountRole.WRITABLE },
    ],
    data: concat(await discriminator('record_skill_result'), outputHash),
  };
  return addSignersToInstruction([sessionSigner], instruction);
}

export async function buildExecuteUsdcPayment(
  feePayer: Address,
  agent: Address,
  policy: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  recipient: Address,
  amount: string,
  inputHash: Uint8Array,
  outputHash: Uint8Array,
  executionId: bigint,
) {
  if (inputHash.length !== 32 || outputHash.length !== 32) throw new Error('Execution hashes must be 32 bytes each.');
  const [execution] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const [vaultTokenAccount, recipientTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(agent), deriveUsdcTokenAddress(recipient),
  ]);
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: recipient, role: AccountRole.READONLY },
      { address: recipientTokenAccount, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('execute_usdc_payment'), u64(usdcToBaseUnits(amount)), inputHash, outputHash, u64(executionId)),
  };
  return { execution, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildCreateEscrow(
  feePayer: Address,
  agent: Address,
  policy: Address,
  vault: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  workerAgent: Address,
  amountSol: number,
  taskId: bigint,
  deadline: bigint,
  taskHash: Uint8Array,
  executionId: bigint,
) {
  if (taskHash.length !== 32) throw new Error('Task hash must be 32 bytes.');
  const agentBytes = encoder.encode(agent);
  const [escrowDerivation, executionDerivation] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow'), agentBytes, u64(taskId)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('execution'), agentBytes, u64(executionId)] }),
  ]);
  const [escrow] = escrowDerivation;
  const [execution] = executionDerivation;
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(
      await discriminator('create_escrow'),
      u64(solToLamports(amountSol)),
      u64(taskId),
      i64(deadline),
      taskHash,
      u64(executionId),
    ),
  };
  return { escrow, execution, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildCreateUsdcEscrow(
  feePayer: Address,
  agent: Address,
  policy: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  workerAgent: Address,
  amount: string,
  taskId: bigint,
  deadline: bigint,
  taskHash: Uint8Array,
  executionId: bigint,
) {
  if (taskHash.length !== 32) throw new Error('Task hash must be 32 bytes.');
  const [escrow] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('escrow'), encoder.encode(agent), u64(taskId)],
  });
  const [execution] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const [vaultTokenAccount, escrowTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(agent), deriveUsdcTokenAddress(escrow),
  ]);
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.WRITABLE },
      { address: policy, role: AccountRole.WRITABLE },
      { address: session, role: AccountRole.WRITABLE },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: escrowTokenAccount, role: AccountRole.WRITABLE },
      { address: execution, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(
      await discriminator('create_usdc_escrow'), u64(usdcToBaseUnits(amount)), u64(taskId), i64(deadline), taskHash, u64(executionId),
    ),
  };
  return { escrow, escrowTokenAccount, execution, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildSubmitEscrowResult(owner: Address, workerAgent: Address, escrow: Address, resultHash: Uint8Array): Promise<Instruction> {
  if (resultHash.length !== 32) throw new Error('Result hash must be 32 bytes.');
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
    ],
    data: concat(await discriminator('submit_escrow_result'), resultHash),
  };
}

export async function deriveEscrowSettlementAddress(escrow: Address): Promise<Address> {
  const [settlement] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('escrow_settlement'), encoder.encode(escrow)],
  });
  return settlement;
}

export async function buildProposeEscrowSettlement(proposer: Address, employerAgent: Address, workerAgent: Address, escrow: Address, workerAmount: bigint) {
  const settlement = await deriveEscrowSettlementAddress(escrow);
  return {
    settlement,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: proposer, role: AccountRole.WRITABLE_SIGNER },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: workerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: settlement, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: concat(await discriminator('propose_escrow_settlement'), u64(workerAmount)),
    } satisfies Instruction,
  };
}

export async function buildAcceptEscrowSettlement(accepter: Address, employerAgent: Address, workerAgent: Address, escrow: Address, expected: EscrowSettlementTerms, executionId?: bigint, taskAddress?: Address) {
  const [settlement, [employerVault], [workerVault], [employerReputation], [workerReputation]] = await Promise.all([
    deriveEscrowSettlementAddress(escrow),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(employerAgent)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(workerAgent)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(employerAgent)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(workerAgent)] }),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)] });
  return {
    settlement, employerVault, workerVault,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: accepter, role: AccountRole.WRITABLE_SIGNER },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: workerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: settlement, role: AccountRole.WRITABLE },
        { address: employerVault, role: AccountRole.WRITABLE },
        { address: workerVault, role: AccountRole.WRITABLE },
        { address: employerReputation, role: AccountRole.WRITABLE },
        { address: workerReputation, role: AccountRole.WRITABLE },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: concat(await discriminator('accept_escrow_settlement_v2'), encodeEscrowSettlementTerms(expected)),
    } satisfies Instruction,
  };
}

export async function buildAcceptUsdcEscrowSettlement(accepter: Address, employerAgent: Address, workerAgent: Address, escrow: Address, expected: EscrowSettlementTerms, executionId?: bigint, taskAddress?: Address) {
  const [[settlement], escrowTokenAccount, workerTokenAccount, employerTokenAccount, [employerReputation], [workerReputation]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow_settlement'), encoder.encode(escrow)] }),
    deriveUsdcTokenAddress(escrow), deriveUsdcTokenAddress(workerAgent), deriveUsdcTokenAddress(employerAgent),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(employerAgent)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(workerAgent)] }),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)] });
  return {
    settlement, escrowTokenAccount, workerTokenAccount, employerTokenAccount,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: accepter, role: AccountRole.WRITABLE_SIGNER },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: workerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: settlement, role: AccountRole.WRITABLE },
        { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
        { address: escrowTokenAccount, role: AccountRole.WRITABLE },
        { address: workerTokenAccount, role: AccountRole.WRITABLE },
        { address: employerTokenAccount, role: AccountRole.WRITABLE },
        { address: employerReputation, role: AccountRole.WRITABLE },
        { address: workerReputation, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: concat(await discriminator('accept_usdc_escrow_settlement_v2'), encodeEscrowSettlementTerms(expected)),
    } satisfies Instruction,
  };
}

export async function buildRefundDisputedEscrow(caller: Address, employerAgent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [settlement, [employerVault]] = await Promise.all([
    deriveEscrowSettlementAddress(escrow),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(employerAgent)] }),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)] });
  return {
    settlement, employerVault,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: caller, role: AccountRole.WRITABLE_SIGNER },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: settlement, role: AccountRole.WRITABLE },
        { address: employerVault, role: AccountRole.WRITABLE },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: await discriminator('refund_disputed_escrow'),
    } satisfies Instruction,
  };
}

export async function buildRefundDisputedUsdcEscrow(caller: Address, employerAgent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [settlement, escrowTokenAccount, employerTokenAccount] = await Promise.all([
    deriveEscrowSettlementAddress(escrow), deriveUsdcTokenAddress(escrow), deriveUsdcTokenAddress(employerAgent),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)] });
  return {
    settlement, escrowTokenAccount, employerTokenAccount,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: caller, role: AccountRole.WRITABLE_SIGNER },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: settlement, role: AccountRole.WRITABLE },
        { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
        { address: escrowTokenAccount, role: AccountRole.WRITABLE },
        { address: employerTokenAccount, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: await discriminator('refund_disputed_usdc_escrow'),
    } satisfies Instruction,
  };
}

export async function buildCancelEscrow(owner: Address, employerAgent: Address, workerAgent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [employerVault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(employerAgent)] });
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: employerAgent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: employerVault, role: AccountRole.WRITABLE },
      { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
    ],
    data: await discriminator('cancel_escrow'),
  };
  return { employerVault, instruction };
}

export async function buildCancelUsdcEscrow(owner: Address, employerAgent: Address, workerAgent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [escrowTokenAccount, employerTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(escrow), deriveUsdcTokenAddress(employerAgent),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(employerAgent), u64(executionId)],
  });
  return {
    escrowTokenAccount,
    employerTokenAccount,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: owner, role: AccountRole.WRITABLE_SIGNER },
        { address: workerAgent, role: AccountRole.READONLY },
        { address: employerAgent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
        { address: escrowTokenAccount, role: AccountRole.WRITABLE },
        { address: employerTokenAccount, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: await discriminator('cancel_usdc_escrow'),
    },
  };
}

export async function buildReleaseEscrow(
  feePayer: Address,
  agent: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  escrow: Address,
  workerAgent: Address,
  executionId?: bigint, taskAddress?: Address,
) {
  const [[workerVault], [workerReputation]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(workerAgent)] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(workerAgent)] }),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: session, role: AccountRole.WRITABLE },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: workerVault, role: AccountRole.WRITABLE },
      { address: workerReputation, role: AccountRole.WRITABLE },
      { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
    ],
    data: await discriminator('release_escrow'),
  };
  return { workerVault, workerReputation, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildReleaseUsdcEscrow(
  feePayer: Address,
  agent: Address,
  session: Address,
  sessionSigner: KeyPairSigner,
  escrow: Address,
  workerAgent: Address,
  executionId?: bigint, taskAddress?: Address,
) {
  const [escrowTokenAccount, workerTokenAccount, [workerReputation]] = await Promise.all([
    deriveUsdcTokenAddress(escrow),
    deriveUsdcTokenAddress(workerAgent),
    getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(workerAgent)] }),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: sessionSigner.address, role: AccountRole.READONLY_SIGNER },
      { address: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: session, role: AccountRole.WRITABLE },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: workerAgent, role: AccountRole.READONLY },
      { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
      { address: escrowTokenAccount, role: AccountRole.WRITABLE },
      { address: workerTokenAccount, role: AccountRole.WRITABLE },
      { address: workerReputation, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
    ],
    data: await discriminator('release_usdc_escrow'),
  };
  return { escrowTokenAccount, workerTokenAccount, workerReputation, instruction: addSignersToInstruction([sessionSigner], instruction) };
}

export async function buildRefundExpiredEscrow(caller: Address, agent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [employerVault] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('vault'), encoder.encode(agent)],
  });
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: caller, role: AccountRole.READONLY_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: employerVault, role: AccountRole.WRITABLE },
      { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
    ],
    data: await discriminator('refund_expired_escrow'),
  };
  return { instruction, employerVault };
}

export async function buildRefundExpiredUsdcEscrow(caller: Address, agent: Address, escrow: Address, executionId?: bigint, taskAddress?: Address) {
  const [escrowTokenAccount, employerTokenAccount] = await Promise.all([
    deriveUsdcTokenAddress(escrow), deriveUsdcTokenAddress(agent),
  ]);
  const [execution] = executionId === undefined ? [undefined] : await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  return {
    escrowTokenAccount,
    employerTokenAccount,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: caller, role: AccountRole.WRITABLE_SIGNER },
        { address: agent, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: DEVNET_USDC_MINT, role: AccountRole.READONLY },
        { address: escrowTokenAccount, role: AccountRole.WRITABLE },
        { address: employerTokenAccount, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: execution ?? PROGRAM_ADDRESS, role: execution ? AccountRole.WRITABLE : AccountRole.READONLY },
        ...await taskEscrowAccounts(escrow, taskAddress),
      ],
      data: await discriminator('refund_expired_usdc_escrow'),
    } satisfies Instruction,
  };
}

export function toSol(lamports: bigint | number): number {
  return Number(lamports) / 1_000_000_000;
}

export async function deriveExecutionAddress(agent: Address, executionId: bigint): Promise<Address> {
  const [execution] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('execution'), encoder.encode(agent), u64(executionId)],
  });
  return execution;
}

export type TaskStatus = 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'waiting';

export async function deriveTaskAddress(agent: Address, taskId: bigint): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task'), encoder.encode(agent), u64(taskId)] }))[0];
}

export async function deriveTaskCompletionAddress(task: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_completion'), encoder.encode(task)] }))[0];
}

function completionHash(hash: Uint8Array) {
  if (hash.length !== 32 || !hash.some(byte => byte !== 0)) throw new Error('Completion requires a nonzero SHA-256 commitment.');
}

export async function buildGrantTaskCompletion(owner: Address, agent: Address, session: Address, taskId: bigint, planHash: Uint8Array, expectedActions: bigint, expiresAt: bigint, startTask = false) {
  completionHash(planHash);
  if (expectedActions <= 0n) throw new Error('Authorize the exact positive number of planned on-chain actions.');
  const task = await deriveTaskAddress(agent, taskId), permit = await deriveTaskCompletionAddress(task);
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(agent)] });
  return { task, permit, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [{ address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: agent, role: AccountRole.READONLY }, { address: policy, role: AccountRole.READONLY }, { address: session, role: AccountRole.READONLY }, { address: task, role: AccountRole.WRITABLE }, { address: permit, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }],
    data: concat(await discriminator('grant_task_completion'), planHash, u64(expectedActions), i64(expiresAt), Uint8Array.of(startTask ? 1 : 0)),
  } satisfies Instruction };
}

export async function buildRevokeTaskCompletion(owner: Address, agent: Address, taskId: bigint) {
  const task = await deriveTaskAddress(agent, taskId), permit = await deriveTaskCompletionAddress(task);
  return { task, permit, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }, { address: agent, role: AccountRole.READONLY }, { address: task, role: AccountRole.READONLY }, { address: permit, role: AccountRole.WRITABLE }],
    data: await discriminator('revoke_task_completion'),
  } satisfies Instruction };
}

export async function buildCompleteSessionTask(input: { agent: Address; session: Address; sessionSigner: KeyPairSigner; taskId: bigint; planHash: Uint8Array; resultHash: Uint8Array; spentSol: bigint; spentUsdc: bigint }) {
  completionHash(input.planHash); completionHash(input.resultHash);
  const task = await deriveTaskAddress(input.agent, input.taskId), permit = await deriveTaskCompletionAddress(task);
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.agent)] });
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [{ address: input.sessionSigner.address, role: AccountRole.READONLY_SIGNER }, { address: input.agent, role: AccountRole.READONLY }, { address: policy, role: AccountRole.READONLY }, { address: input.session, role: AccountRole.READONLY }, { address: task, role: AccountRole.WRITABLE }, { address: permit, role: AccountRole.WRITABLE }],
    data: concat(await discriminator('complete_session_task'), input.planHash, input.resultHash, u64(input.spentSol), u64(input.spentUsdc)),
  };
  return { task, permit, instruction: addSignersToInstruction([input.sessionSigner], instruction) };
}

export async function buildCreateTask(owner: Address, agent: Address, session: Address, taskId: bigint, taskHash: Uint8Array, maxSolLamports: bigint, maxUsdcBaseUnits: bigint, deadline: bigint) {
  if (taskHash.length !== 32 || !taskHash.some((byte) => byte !== 0)) throw new Error('Task needs a nonzero SHA-256 commitment.');
  if (maxSolLamports < 0n || maxUsdcBaseUnits < 0n || maxSolLamports + maxUsdcBaseUnits === 0n) throw new Error('Set a positive task budget for at least one asset.');
  const task = await deriveTaskAddress(agent, taskId);
  return { task, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: agent, role: AccountRole.READONLY },
      { address: session, role: AccountRole.WRITABLE },
      { address: task, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat(await discriminator('create_task'), u64(taskId), taskHash, u64(maxSolLamports), u64(maxUsdcBaseUnits), i64(deadline)),
  } satisfies Instruction };
}

export async function buildSetTaskStatus(owner: Address, agent: Address, taskId: bigint, status: TaskStatus, resultHash?: Uint8Array) {
  const index = ['ready', 'running', 'paused', 'completed', 'failed', 'cancelled', 'waiting'].indexOf(status);
  if (index < 0 || (status === 'completed' ? !resultHash || resultHash.length !== 32 || !resultHash.some((byte) => byte !== 0) : resultHash !== undefined)) throw new Error('Only completion accepts a nonzero result SHA-256.');
  const task = await deriveTaskAddress(agent, taskId);
  return { task, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }, { address: agent, role: AccountRole.READONLY }, { address: task, role: AccountRole.WRITABLE }],
    data: concat(await discriminator('set_task_status'), Uint8Array.of(index, resultHash ? 1 : 0), ...(resultHash ? [resultHash] : [])),
  } satisfies Instruction };
}

export async function buildReplaceTaskSession(owner: Address, agent: Address, taskId: bigint, session: Address) {
  const task = await deriveTaskAddress(agent, taskId);
  return { task, instruction: {
    programAddress: PROGRAM_ADDRESS,
    accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }, { address: agent, role: AccountRole.READONLY }, { address: task, role: AccountRole.WRITABLE }, { address: session, role: AccountRole.WRITABLE }],
    data: await discriminator('replace_task_session'),
  } satisfies Instruction };
}

export async function buildTaskPayment(input: { feePayer: Address; agent: Address; session: Address; sessionSigner: KeyPairSigner; taskId: bigint; executionId: bigint; actionId: bigint; recipient: Address; asset: 'SOL' | 'USDC'; amountAtomic: bigint; inputHash: Uint8Array; outputHash: Uint8Array }) {
  if (input.amountAtomic <= 0n || input.inputHash.length !== 32 || input.outputHash.length !== 32) throw new Error('Provide a positive exact atomic amount and two SHA-256 hashes.');
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.agent)] });
  const task = await deriveTaskAddress(input.agent, input.taskId);
  const execution = await deriveExecutionAddress(input.agent, input.executionId);
  const [taskAction] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_action'), encoder.encode(task), u64(input.actionId)] });
  const base = [
    { address: input.sessionSigner.address, role: AccountRole.READONLY_SIGNER },
    { address: input.feePayer, role: AccountRole.WRITABLE_SIGNER },
    { address: input.agent, role: AccountRole.WRITABLE },
    { address: policy, role: AccountRole.WRITABLE },
    { address: input.session, role: AccountRole.WRITABLE },
  ];
  let assetAccounts: { address: Address; role: AccountRole }[];
  if (input.asset === 'SOL') {
    const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(input.agent)] });
    assetAccounts = [{ address: vault, role: AccountRole.WRITABLE }, { address: input.recipient, role: AccountRole.WRITABLE }, { address: execution, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }];
  } else if (input.asset === 'USDC') {
    const [vaultTokenAccount, recipientTokenAccount] = await Promise.all([deriveUsdcTokenAddress(input.agent), deriveUsdcTokenAddress(input.recipient)]);
    assetAccounts = [{ address: DEVNET_USDC_MINT, role: AccountRole.READONLY }, { address: vaultTokenAccount, role: AccountRole.WRITABLE }, { address: input.recipient, role: AccountRole.READONLY }, { address: recipientTokenAccount, role: AccountRole.WRITABLE }, { address: execution, role: AccountRole.WRITABLE }, { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY }, { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }];
  } else throw new Error('Unsupported task payment asset.');
  const instruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [...base, ...assetAccounts, { address: task, role: AccountRole.WRITABLE }, { address: taskAction, role: AccountRole.WRITABLE }],
    data: concat(await discriminator(input.asset === 'SOL' ? 'execute_task_payment' : 'execute_task_usdc_payment'), u64(input.amountAtomic), input.inputHash, input.outputHash, u64(input.executionId), u64(input.actionId)),
  };
  return { task, execution, taskAction, instruction: addSignersToInstruction([input.sessionSigner], instruction) };
}

export async function deriveEscrowAddress(agent: Address, taskId: bigint): Promise<Address> {
  const [escrow] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [utf8('escrow'), encoder.encode(agent), u64(taskId)],
  });
  return escrow;
}

export async function deriveEscrowEvidenceAddress(escrow: Address): Promise<Address> {
  const [evidence] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow_evidence'), encoder.encode(escrow)] });
  return evidence;
}

export async function buildSubmitEscrowResultWithSources(owner: Address, workerAgent: Address, escrow: Address, resultHash: Uint8Array, sources: { execution: string; contentHash: string }[]): Promise<Instruction> {
  if (resultHash.length !== 32 || sources.length < 1 || sources.length > 3 || new Set(sources.map((source) => source.execution)).size !== sources.length) throw new Error('Provide a result hash and one to three distinct Skill sources.');
  const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, sources.length, true);
  const encoded = sources.map((source) => {
    if (!/^[a-f0-9]{64}$/.test(source.contentHash)) throw new Error('Skill source hash is invalid.');
    return concat(new Uint8Array(encoder.encode(address(source.execution))), Uint8Array.from(source.contentHash.match(/../g)!.map((pair) => parseInt(pair, 16))));
  });
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: workerAgent, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE }, { address: await deriveEscrowEvidenceAddress(escrow), role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...sources.map((source) => ({ address: address(source.execution), role: AccountRole.READONLY })),
    ],
    data: concat(await discriminator('submit_escrow_result_with_sources'), resultHash, count, ...encoded),
  };
}


export async function buildPayTaskSkill(input: { feePayer: Address; agent: Address; session: Address; sessionSigner: KeyPairSigner; taskId: bigint; actionId: bigint; executionId: bigint; skill: Address; provider: Address; asset: 'SOL' | 'USDC'; expectedPrice: bigint; inputHash: Uint8Array }) {
  if (input.expectedPrice <= 0n || input.inputHash.length !== 32) throw new Error('Provide a positive exact atomic Skill price and request SHA-256.');
  const task = await deriveTaskAddress(input.agent, input.taskId);
  const [taskAction] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_action'), encoder.encode(task), u64(input.actionId)] });
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.agent)] });
  let payment: Awaited<ReturnType<typeof buildPaySkill>>;
  if (input.asset === 'SOL') {
    const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(input.agent)] });
    payment = await buildPaySkill(input.feePayer, input.agent, policy, vault, input.session, input.sessionSigner, input.skill, input.provider, input.expectedPrice, input.inputHash, input.executionId);
  } else if (input.asset === 'USDC') {
    payment = await buildPayUsdcSkill(input.feePayer, input.agent, policy, input.session, input.sessionSigner, input.skill, input.provider, input.expectedPrice, input.inputHash, input.executionId);
  } else throw new Error('Unsupported task Skill asset.');
  const instruction: Instruction = {
    ...payment.instruction,
    accounts: [...payment.instruction.accounts!, { address: task, role: AccountRole.WRITABLE }, { address: taskAction, role: AccountRole.WRITABLE }],
    data: concat(await discriminator(input.asset === 'SOL' ? 'pay_task_skill' : 'pay_task_usdc_skill'), u64(input.expectedPrice), input.inputHash, u64(input.executionId), u64(input.actionId)),
  };
  return { task, taskAction, execution: payment.execution, instruction: addSignersToInstruction([input.sessionSigner], instruction) };
}

export async function buildRecordTaskSkillResult(input: { feePayer: Address; agent: Address; session: Address; sessionSigner: KeyPairSigner; taskId: bigint; actionId: bigint; execution: Address; outputHash: Uint8Array }): Promise<Instruction> {
  if (input.outputHash.length !== 32 || !input.outputHash.some((byte) => byte !== 0)) throw new Error('Provide a nonzero result SHA-256.');
  const task = await deriveTaskAddress(input.agent, input.taskId);
  const [taskAction] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_action'), encoder.encode(task), u64(input.actionId)] });
  const base = await buildRecordSkillResult(input.feePayer, input.agent, input.session, input.sessionSigner, input.execution, input.outputHash);
  return addSignersToInstruction([input.sessionSigner], {
    ...base,
    accounts: [...base.accounts!, { address: task, role: AccountRole.WRITABLE }, { address: taskAction, role: AccountRole.READONLY }],
    data: concat(await discriminator('record_task_skill_result'), input.outputHash),
  });
}


export async function deriveTaskEscrowAddress(escrow: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_escrow'), encoder.encode(escrow)] }))[0];
}

async function taskEscrowAccounts(escrow: Address, task?: Address) {
  return task ? [{ address: await deriveTaskEscrowAddress(escrow), role: AccountRole.WRITABLE }, { address: task, role: AccountRole.WRITABLE }] : [{ address: PROGRAM_ADDRESS, role: AccountRole.READONLY }, { address: PROGRAM_ADDRESS, role: AccountRole.READONLY }];
}

export async function buildCreateTaskEscrow(input: { feePayer: Address; agent: Address; session: Address; sessionSigner: KeyPairSigner; taskId: bigint; actionId: bigint; escrowId: bigint; executionId: bigint; workerAgent: Address; asset: 'SOL' | 'USDC'; amountAtomic: bigint; deadline: bigint; taskHash: Uint8Array }) {
  if (input.amountAtomic <= 0n || input.taskHash.length !== 32 || !input.taskHash.some((byte) => byte !== 0)) throw new Error('Provide a positive exact atomic Escrow amount and task SHA-256.');
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.agent)] });
  const task = await deriveTaskAddress(input.agent, input.taskId);
  const [taskAction] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_action'), encoder.encode(task), u64(input.actionId)] });
  let base: Awaited<ReturnType<typeof buildCreateEscrow>>;
  if (input.asset === 'SOL') {
    const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(input.agent)] });
    // The base builder supplies only account metas. The exact amount is encoded below.
    base = await buildCreateEscrow(input.feePayer, input.agent, policy, vault, input.session, input.sessionSigner, input.workerAgent, 0.001, input.escrowId, input.deadline, input.taskHash, input.executionId);
  } else if (input.asset === 'USDC') {
    base = await buildCreateUsdcEscrow(input.feePayer, input.agent, policy, input.session, input.sessionSigner, input.workerAgent, formatUsdcBaseUnits(input.amountAtomic), input.escrowId, input.deadline, input.taskHash, input.executionId);
  } else throw new Error('Unsupported Task Escrow asset.');
  const taskLink = await deriveTaskEscrowAddress(base.escrow);
  return { task, taskAction, taskLink, escrow: base.escrow, execution: base.execution, instruction: addSignersToInstruction([input.sessionSigner], {
    ...base.instruction,
    accounts: [...base.instruction.accounts!, { address: task, role: AccountRole.WRITABLE }, { address: taskAction, role: AccountRole.WRITABLE }, { address: taskLink, role: AccountRole.WRITABLE }],
    data: concat(await discriminator(input.asset === 'SOL' ? 'create_task_escrow' : 'create_task_usdc_escrow'), u64(input.amountAtomic), u64(input.escrowId), i64(input.deadline), input.taskHash, u64(input.executionId), u64(input.actionId)),
  }) };
}

export async function deriveWorkerDeliveryAddress(escrow: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('worker_delivery'), encoder.encode(escrow)] }))[0];
}
export async function buildGrantWorkerDelivery(owner: Address, workerAgent: Address, session: Address, escrow: Address, expiresAt: bigint): Promise<Instruction> {
  const policy = (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(workerAgent)] }))[0];
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: workerAgent, role: AccountRole.READONLY },
    { address: policy, role: AccountRole.READONLY }, { address: session, role: AccountRole.READONLY },
    { address: escrow, role: AccountRole.READONLY }, { address: await deriveWorkerDeliveryAddress(escrow), role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ], data: concat(await discriminator('grant_worker_delivery'), i64(expiresAt)) };
}
export async function buildRevokeWorkerDelivery(owner: Address, workerAgent: Address, escrow: Address): Promise<Instruction> {
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: owner, role: AccountRole.READONLY_SIGNER }, { address: workerAgent, role: AccountRole.READONLY },
    { address: await deriveWorkerDeliveryAddress(escrow), role: AccountRole.WRITABLE },
  ], data: await discriminator('revoke_worker_delivery') };
}
export async function buildSubmitSessionEscrowResult(input: { feePayer: Address; workerAgent: Address; session: Address; sessionSigner: KeyPairSigner; escrow: Address; resultHash: Uint8Array; sources: { execution: string; contentHash: string }[] }): Promise<Instruction> {
  if (input.resultHash.length !== 32 || input.resultHash.every((byte) => byte === 0) || input.sources.length > 3 || new Set(input.sources.map((source) => source.execution)).size !== input.sources.length) throw new Error('Provide a nonzero result hash and at most three distinct sources.');
  const policy = (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.workerAgent)] }))[0];
  const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, input.sources.length, true);
  const encoded = input.sources.map((source) => {
    if (!/^[a-f0-9]{64}$/.test(source.contentHash)) throw new Error('Invalid source hash.');
    return concat(new Uint8Array(encoder.encode(address(source.execution))), Uint8Array.from(source.contentHash.match(/../g)!.map((pair) => parseInt(pair, 16))));
  });
  const instruction: Instruction = { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: input.sessionSigner.address, role: AccountRole.READONLY_SIGNER }, { address: input.feePayer, role: AccountRole.WRITABLE_SIGNER },
    { address: input.workerAgent, role: AccountRole.READONLY }, { address: policy, role: AccountRole.READONLY },
    { address: input.session, role: AccountRole.READONLY }, { address: input.escrow, role: AccountRole.WRITABLE },
    { address: await deriveWorkerDeliveryAddress(input.escrow), role: AccountRole.WRITABLE },
    { address: input.sources.length ? await deriveEscrowEvidenceAddress(input.escrow) : PROGRAM_ADDRESS, role: input.sources.length ? AccountRole.WRITABLE : AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ...input.sources.map((source) => ({ address: address(source.execution), role: AccountRole.READONLY })),
  ], data: concat(await discriminator('submit_session_escrow_result'), input.resultHash, count, ...encoded) };
  return addSignersToInstruction([input.sessionSigner], instruction);
}


export type JudgeVerdict = 'pass' | 'fail' | 'needs_review';
export type JudgeTerms = { judgeAgent: Address; session: Address; expiresAt: bigint; taskHash: Uint8Array };
export async function deriveJudgeMandateAddress(escrow: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow_judge'), encoder.encode(escrow)] }))[0];
}
export async function deriveJudgeDecisionAddress(escrow: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow_decision'), encoder.encode(escrow)] }))[0];
}
const judgeHash = (hash: Uint8Array) => { if (hash.length !== 32 || !hash.some((byte) => byte !== 0)) throw new Error('Provide a nonzero SHA-256 commitment.'); return hash; };
export async function buildProposeEscrowJudge(owner: Address, employer: Address, worker: Address, escrow: Address, judge: Address, session: Address, expiresAt: bigint): Promise<Instruction> {
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(judge)] });
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: employer, role: AccountRole.READONLY },
    { address: worker, role: AccountRole.READONLY }, { address: escrow, role: AccountRole.READONLY },
    { address: judge, role: AccountRole.READONLY }, { address: policy, role: AccountRole.READONLY }, { address: session, role: AccountRole.READONLY },
    { address: await deriveJudgeMandateAddress(escrow), role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ], data: concat(await discriminator('propose_escrow_judge'), i64(expiresAt)) };
}
export async function buildAcceptEscrowJudge(owner: Address, worker: Address, escrow: Address, expected: JudgeTerms): Promise<Instruction> {
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: owner, role: AccountRole.READONLY_SIGNER }, { address: worker, role: AccountRole.READONLY },
    { address: escrow, role: AccountRole.READONLY }, { address: await deriveJudgeMandateAddress(escrow), role: AccountRole.WRITABLE },
  ], data: concat(await discriminator('accept_escrow_judge'), new Uint8Array(encoder.encode(expected.judgeAgent)), new Uint8Array(encoder.encode(expected.session)), i64(expected.expiresAt), judgeHash(expected.taskHash)) };
}
export async function buildDeclineEscrowJudge(owner: Address, employer: Address, worker: Address, escrow: Address): Promise<Instruction> {
  return { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: owner, role: AccountRole.READONLY_SIGNER }, { address: employer, role: AccountRole.READONLY },
    { address: worker, role: AccountRole.READONLY }, { address: await deriveJudgeMandateAddress(escrow), role: AccountRole.WRITABLE },
  ], data: await discriminator('decline_escrow_judge') };
}
export async function buildRecordEscrowJudgment(input: { feePayer: Address; judge: Address; session: Address; signer: KeyPairSigner; escrow: Address; verdict: JudgeVerdict; taskHash: Uint8Array; resultHash: Uint8Array; judgmentHash: Uint8Array }): Promise<Instruction> {
  const verdict = ['pass', 'fail', 'needs_review'].indexOf(input.verdict);
  if (verdict < 0) throw new Error('Unknown Judge verdict.');
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encoder.encode(input.judge)] });
  return addSignersToInstruction([input.signer], { programAddress: PROGRAM_ADDRESS, accounts: [
    { address: input.signer.address, role: AccountRole.READONLY_SIGNER }, { address: input.feePayer, role: AccountRole.WRITABLE_SIGNER },
    { address: input.judge, role: AccountRole.READONLY }, { address: policy, role: AccountRole.READONLY },
    { address: input.session, role: AccountRole.READONLY }, { address: input.escrow, role: AccountRole.READONLY },
    { address: await deriveJudgeMandateAddress(input.escrow), role: AccountRole.WRITABLE },
    { address: await deriveJudgeDecisionAddress(input.escrow), role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ], data: concat(await discriminator('record_escrow_judgment'), new Uint8Array([verdict]), judgeHash(input.taskHash), judgeHash(input.resultHash), judgeHash(input.judgmentHash)) });
}
export async function buildSettleJudgedEscrow(input: { caller: Address; employer: Address; worker: Address; escrow: Address; asset: 'SOL' | 'USDC'; execution?: Address; task?: Address }): Promise<Instruction> {
  const [reputation] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('reputation'), encoder.encode(input.worker)] });
  const common = [
    { address: input.caller, role: AccountRole.WRITABLE_SIGNER }, { address: input.employer, role: AccountRole.READONLY },
    { address: input.worker, role: AccountRole.READONLY }, { address: input.escrow, role: AccountRole.WRITABLE },
    { address: await deriveJudgeMandateAddress(input.escrow), role: AccountRole.READONLY }, { address: await deriveJudgeDecisionAddress(input.escrow), role: AccountRole.WRITABLE },
  ];
  const tail = [{ address: input.execution ?? PROGRAM_ADDRESS, role: input.execution ? AccountRole.WRITABLE : AccountRole.READONLY }, ...await taskEscrowAccounts(input.escrow, input.task)];
  if (input.asset === 'SOL') {
    const [employerVault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(input.employer)] });
    const [workerVault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encoder.encode(input.worker)] });
    return { programAddress: PROGRAM_ADDRESS, accounts: [...common, { address: employerVault, role: AccountRole.WRITABLE }, { address: workerVault, role: AccountRole.WRITABLE }, { address: reputation, role: AccountRole.WRITABLE }, ...tail], data: await discriminator('settle_judged_escrow') };
  }
  if (input.asset !== 'USDC') throw new Error('Unsupported Judge settlement asset.');
  return { programAddress: PROGRAM_ADDRESS, accounts: [...common,
    { address: DEVNET_USDC_MINT, role: AccountRole.READONLY }, { address: await deriveUsdcTokenAddress(input.escrow), role: AccountRole.WRITABLE },
    { address: await deriveUsdcTokenAddress(input.employer), role: AccountRole.WRITABLE }, { address: await deriveUsdcTokenAddress(input.worker), role: AccountRole.WRITABLE },
    { address: reputation, role: AccountRole.WRITABLE }, { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, ...tail,
  ], data: await discriminator('settle_judged_usdc_escrow') };
}
