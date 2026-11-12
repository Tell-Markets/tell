// Holders of a token right now, from its full transfer log. Used for the $TELL migration airdrop.
//   npx tsx scripts/snapshot.ts <token> <fromBlock> [out.csv]
import { writeFileSync } from 'node:fs';
import { homeClient as client } from '../src/sources/rpc.js';
import type { Hex } from 'viem';

const [token, fromArg, out = 'snapshot.csv'] = process.argv.slice(2);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const latest = await client.getBlockNumber();
const bal = new Map<string, bigint>();
for (let from = BigInt(fromArg); from <= latest; from += 200_000n) {
  const to = from + 199_999n < latest ? from + 199_999n : latest;
  const logs = await client.request({ method: 'eth_getLogs', params: [{ address: token as Hex, topics: [TRANSFER], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as { topics: Hex[]; data: Hex }[];
  for (const l of logs) {
    const a = '0x' + l.topics[1].slice(-40), b = '0x' + l.topics[2].slice(-40), v = BigInt(l.data);
    bal.set(a, (bal.get(a) ?? 0n) - v); bal.set(b, (bal.get(b) ?? 0n) + v);
  }
}
const rows: { address: string; amount: bigint; kind: string }[] = [];
for (const [address, amount] of bal) {
  if (amount <= 0n || address === '0x0000000000000000000000000000000000000000') continue;
  const code = await client.getCode({ address: address as Hex });
  rows.push({ address, amount, kind: address.toLowerCase() === '0x000000000000000000000000000000000000dead' ? 'burned' : code && code !== '0x' ? 'contract' : 'wallet' });
}
rows.sort((x, y) => (y.amount > x.amount ? 1 : -1));
const fmt = (v: bigint) => (Number(v) / 1e18).toFixed(6);
writeFileSync(out, 'address,amount,kind\n' + rows.map(r => `${r.address},${fmt(r.amount)},${r.kind}`).join('\n') + '\n');
console.log(`block ${latest}: ${rows.length} holders → ${out}`);
for (const r of rows) console.log(r.address, fmt(r.amount), r.kind);
process.exit(0);
