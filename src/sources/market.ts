import { erc20Abi, type Hex } from 'viem';
import type { Report } from '../analyze.js';
import { BLOCKS_PER_SEC, LAUNCH_TOPIC, PONS_FACTORY, launchOf } from '../launches.js';
import { homeClient as client, withBackoff } from './rpc.js';

/*
 * Market numbers for a post: market cap, FDV, 24h volume, liquidity, holders and when trading began.
 * A token on a DEX gets them from its DexScreener pair. A token still on its Pons bonding curve has
 * no pair, so they come from the chain: the curve's getReserves() gives the price (virtual ETH over
 * tokens left on the curve), its Trade events give the volume, and WETH's price turns ETH into USD.
 */

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
/** Pons curve Trade event: data = [tokenAmount, ethAmount, fee, …]. */
const TRADE_TOPIC = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';

export interface Market {
  venue: string;            // "Pons curve" or the DEX name
  marketCapUsd?: number;
  fdvUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  tradingSince?: number;    // ms
}

let eth: { usd: number; at: number } | undefined;
async function ethUsd(): Promise<number | undefined> {
  if (eth && Date.now() - eth.at < 5 * 60_000) return eth.usd;
  try {
    const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${WETH}`, { signal: AbortSignal.timeout(10_000) })).json() as { baseToken: { address: string }; priceUsd?: string; liquidity?: { usd?: number } }[];
    const best = pairs.filter(p => p.baseToken.address.toLowerCase() === WETH && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (best) eth = { usd: Number(best.priceUsd), at: Date.now() };
  } catch { /* keep the last price */ }
  return eth?.usd;
}

const curves = new Map<string, Hex | null>();
/** The token's Pons curve, from its launch event (topics = [sig, token, curve, deployer]). */
async function curveOf(token: string): Promise<Hex | undefined> {
  const key = token.toLowerCase();
  if (curves.has(key)) return curves.get(key) ?? undefined;
  const l = launchOf(key);
  if (!l) return undefined;
  const logs = await withBackoff(() => client.request({
    method: 'eth_getLogs',
    params: [{ address: PONS_FACTORY, topics: [LAUNCH_TOPIC, ('0x' + key.slice(2).padStart(64, '0')) as Hex], fromBlock: `0x${(BigInt(l.block) - 1n).toString(16)}`, toBlock: `0x${(BigInt(l.block) + 1n).toString(16)}` }],
  })).catch(() => []) as { topics: Hex[] }[];
  const curve = logs[0] ? ('0x' + logs[0].topics[2].slice(-40)) as Hex : null;
  curves.set(key, curve);
  if (curves.size > 5000) curves.delete(curves.keys().next().value!);
  return curve ?? undefined;
}

async function curveMarket(r: Report): Promise<Market | undefined> {
  const token = r.token.address;
  const curve = await curveOf(token);
  if (!curve) return undefined;
  const [reserves, usd, supply, held] = await Promise.all([
    client.request({ method: 'eth_call', params: [{ to: curve, data: '0x0902f1ac' }, 'latest'] }) as Promise<Hex>,
    ethUsd(),
    r.token.totalSupply !== undefined ? Promise.resolve(r.token.totalSupply) : client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }),
    client.getBalance({ address: curve }),
  ]);
  const [vEth, vTok] = (reserves.slice(2).match(/.{64}/g) ?? []).map(w => BigInt('0x' + w));
  if (!vEth || !vTok || !usd) return undefined;
  const dec = 10 ** (r.token.decimals ?? 18);
  const priceEth = Number(vEth) / 1e18 / (Number(vTok) / dec);
  const capUsd = priceEth * (Number(supply) / dec) * usd;

  // 24h volume from the curve's own trade log
  const latest = await client.getBlockNumber();
  const from = latest - BigInt(Math.round(24 * 3600 * BLOCKS_PER_SEC));
  const logs = await withBackoff(() => client.request({
    method: 'eth_getLogs', params: [{ address: curve, topics: [TRADE_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${latest.toString(16)}` }],
  })).catch(() => []) as { data: Hex }[];
  const volEth = logs.reduce((s, l) => s + Number(BigInt('0x' + l.data.slice(66, 130))) / 1e18, 0);

  return {
    venue: 'Pons curve', marketCapUsd: capUsd, fdvUsd: capUsd, volume24hUsd: volEth * usd,
    liquidityUsd: Number(held) / 1e18 * usd, holders: r.facts?.holders, tradingSince: launchOf(token)?.at,
  };
}

/** Market numbers for the report's token, or undefined when there's nothing reliable to show. */
export async function marketOf(r: Report): Promise<Market | undefined> {
  const pair = r.pairs?.[0];
  if (pair) {
    return {
      venue: pair.dexId ? pair.dexId.charAt(0).toUpperCase() + pair.dexId.slice(1) : 'DEX',
      marketCapUsd: pair.marketCap, fdvUsd: pair.fdv, volume24hUsd: pair.volume?.h24, liquidityUsd: pair.liquidity?.usd,
      holders: r.facts?.holders, tradingSince: launchOf(r.token.address)?.at ?? pair.pairCreatedAt,
    };
  }
  return curveMarket(r).catch(() => undefined);
}

export const usd = (n?: number) => n === undefined || !isFinite(n) ? '—'
  : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;

export function ago(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
