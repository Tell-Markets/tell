import type { Hex } from 'viem';
import { getReport, cachedReport, isChecking } from './reports.js';
import { background, clientFor, onChain, withBackoff } from './sources/rpc.js';
import { JsonStore } from './store.js';

/*
 * Elysium launches. Elysium (Hyperliquid's L2) sees around a thousand token launches an hour across
 * several launchpads, far too many to fully check. So:
 *   1. every minute, read the new tokens' first mint from the chain: whoever receives the first
 *      mint is the launchpad that made it (Montra, Clanker, Ascend…); ElysPump is read from its
 *      own event. One log query per minute, gentle on the public RPC.
 *   2. every few minutes, ask DexScreener which of the last hours' launches actually trade.
 *   3. only those with real liquidity and trades get a full Tell check and show in the feed.
 */

const c = clientFor('elysium');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
const SEC_PER_BLOCK = 0.143;

/** Who receives a new token's first mint, by launchpad. Found by reading each launchpad's launches. */
const BY_MINT_RECIPIENT: Record<string, string> = {
  '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec': 'Montra',
  '0x3ea9581a32a396f69b177b65b91149cf887beacc': 'Clanker',
  '0xe0def4221b9840a610d4e7d55812a79a6431a8ec': 'Ascend',
  '0xa9f082af704a8b2e0087cca2edb41e3ebf665e42': 'Pump.fun clones',
};
const ELYSPUMP = '0x1f5bac6876767627999d07eede887024fae0284a';
const ELYSPUMP_EVENT = '0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017'; // token in topic 2

export interface ElysiumLaunch {
  token: string;
  launchpad: string;
  block: string;
  at: number;
  /** Set once DexScreener has shown the token trading with real money. */
  traded?: { at: number; liquidityUsd?: number; marketCapUsd?: number; txns24h?: number; symbol?: string; name?: string; image?: string };
  lastLook?: number;
}

const store = new JsonStore<ElysiumLaunch>('elysium-launches.json', 40_000);
let lastBlock = 0n;

async function poll() {
  const latest = await withBackoff(() => c.getBlockNumber());
  const now = Date.now();
  if (!lastBlock) lastBlock = latest - BigInt(Math.round(3 * 3600 / SEC_PER_BLOCK)); // first run: last 3 hours
  for (let from = lastBlock + 1n; from <= latest; from += 10_000n) {
    const to = from + 9_999n < latest ? from + 9_999n : latest;
    const range = { fromBlock: `0x${from.toString(16)}` as Hex, toBlock: `0x${to.toString(16)}` as Hex };
    const [mints, pumps] = await Promise.all([
      withBackoff(() => c.request({ method: 'eth_getLogs', params: [{ topics: [TRANSFER, ZERO], ...range }] })) as Promise<{ address: string; topics: string[]; data: string; blockNumber: string }[]>,
      withBackoff(() => c.request({ method: 'eth_getLogs', params: [{ address: ELYSPUMP, topics: [ELYSPUMP_EVENT], ...range }] })) as Promise<{ topics: string[]; blockNumber: string }[]>,
    ]);
    const add = (token: string, launchpad: string, block: string) => {
      const key = token.toLowerCase();
      if (store.get(key)) return;
      store.set(key, { token: key, launchpad, block: BigInt(block).toString(), at: now - Number(latest - BigInt(block)) * SEC_PER_BLOCK * 1000 });
    };
    for (const m of mints) {
      if (m.topics.length !== 3 || m.data?.length !== 66) continue; // ERC-20 only
      const pad = BY_MINT_RECIPIENT['0x' + m.topics[2].slice(-40)];
      if (pad) add(m.address, pad, m.blockNumber);
    }
    for (const p of pumps) add('0x' + p.topics[2].slice(-40), 'ElysPump', p.blockNumber);
    lastBlock = to;
  }
}

/** Ask DexScreener which recent launches trade; the ones with real money get a full check. */
async function scan() {
  const now = Date.now();
  const due = store.values()
    .filter(l => now - l.at < 6 * 3600_000 && now - l.at > 5 * 60_000 && !l.traded && now - (l.lastLook ?? 0) > 10 * 60_000)
    .sort((a, b) => b.at - a.at)
    .slice(0, 30 * 40);
  for (let i = 0; i < due.length; i += 30) {
    const batch = due.slice(i, i + 30);
    const pairs = await fetch(`https://api.dexscreener.com/tokens/v1/elysium/${batch.map(l => l.token).join(',')}`, { signal: AbortSignal.timeout(15_000) })
      .then(r => r.ok ? r.json() : []).catch(() => []) as any[];
    for (const l of batch) {
      const mine = pairs.filter(p => p.baseToken?.address?.toLowerCase() === l.token).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const p = mine[0];
      const tx = (p?.txns?.h24?.buys ?? 0) + (p?.txns?.h24?.sells ?? 0);
      const traded = p && (p.liquidity?.usd ?? 0) >= 3_000 && tx >= 20;
      // ElysPump's event fires on trades too, so an old token can look new: a pool that opened well
      // before we first saw the token means it isn't a launch; date it by the pool so it drops out
      const pooled = mine.map(x => x.pairCreatedAt).filter(Boolean).sort((a, b) => a - b)[0];
      const at = pooled && pooled < l.at - 6 * 3600_000 ? pooled : l.at;
      store.set(l.token, {
        ...l, at, lastLook: now,
        ...(traded ? { traded: { at: now, liquidityUsd: p.liquidity?.usd, marketCapUsd: p.marketCap ?? p.fdv, txns24h: tx, symbol: p.baseToken?.symbol, name: p.baseToken?.name, image: p.info?.imageUrl } } : {}),
      });
    }
    await new Promise(r => setTimeout(r, 1500)); // well under DexScreener's 300 a minute
  }
}

/** Full checks for traded launches, one at a time, newest first. */
async function work() {
  const next = store.values()
    .filter(l => l.traded && Date.now() - l.at < 24 * 3600_000)
    .filter(l => onChain('elysium', () => { const r = cachedReport(l.token); return !isChecking(l.token) && (!r || Date.now() - r.at > 3600_000); }))
    .sort((a, b) => b.at - a.at)[0];
  if (!next) return;
  await onChain('elysium', () => getReport(next.token as Hex, { maxAge: 3600_000 })).catch(err => console.error('elysium check failed', next.token, err?.message ?? err));
}

export function startElysiumWatcher() {
  const every = (fn: () => Promise<void>, ms: number, first: number, label: string) => {
    const run = async () => {
      try { await background.run(true, () => onChain('elysium', fn)); } catch (err) { console.error(`elysium ${label} failed`, (err as Error).message); }
      setTimeout(run, ms);
    };
    setTimeout(run, first);
  };
  every(poll, 60_000, 2_000, 'poll');
  every(scan, 5 * 60_000, 30_000, 'scan');
  every(work, 5_000, 60_000, 'check');
  console.log('Elysium launch watcher on');
}

/** Last day on Elysium: counts by launchpad, and the launches that trade, with their checks. */
export function elysiumFeed() {
  const day = Date.now() - 24 * 3600_000;
  const recent = store.values().filter(l => l.at > day);
  const byPad: Record<string, number> = {};
  for (const l of recent) byPad[l.launchpad] = (byPad[l.launchpad] ?? 0) + 1;
  const traded = recent.filter(l => l.traded).sort((a, b) => b.at - a.at).map(l => onChain('elysium', () => {
    const cr = cachedReport(l.token);
    const r = cr?.report;
    return {
      token: l.token, chain: 'elysium', launchpad: l.launchpad, at: l.at,
      symbol: r?.token.symbol ?? l.traded?.symbol, name: r?.token.name ?? l.traded?.name,
      image: r?.pairs?.[0]?.info?.imageUrl || l.traded?.image,
      checking: isChecking(l.token), checkedAt: cr?.at, score: r?.score, verdict: r?.verdict,
      holders: r?.facts?.holders, liquidity: r?.pairs?.[0]?.liquidity?.usd ?? l.traded?.liquidityUsd, marketCap: r?.pairs?.[0]?.marketCap ?? l.traded?.marketCapUsd,
    };
  }));
  return { launches24h: recent.length, byLaunchpad: byPad, tradedCount: traded.length, traded };
}

/** For channel posts: is this an Elysium launch from the last day? */
export const elysiumLaunchOf = (token: string) => store.get(token.toLowerCase());
