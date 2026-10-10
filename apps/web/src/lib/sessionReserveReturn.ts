/** A System account must end empty or retain its rent-exempt minimum. */
export function sessionReserveReturn(balance: bigint, fee: bigint, rent: bigint, requested?: bigint): { amount: bigint; remaining: bigint } {
  if (balance < 0n || fee < 0n || rent < 0n || fee > 10_000n) throw new Error('Invalid reserve or network fee above 0.00001 SOL.');
  const amount = requested ?? balance - fee;
  if (amount <= 0n || amount + fee > balance) throw new Error('The reserve cannot cover the return and its quoted fee.');
  const remaining = balance - amount - fee;
  if (remaining !== 0n && remaining < rent) throw new Error('Partial return would leave an account below its rent minimum. Select return all, or leave a rent-exempt balance.');
  return { amount, remaining };
}
