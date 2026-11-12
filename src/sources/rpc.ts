import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicClient, defineChain, http } from 'viem';
import { config } from '../config.js';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

/*
 * Chains Tell checks tokens on. Robinhood Chain is home: the Pons launch feed, the proof ledger,
 * x402 and $TELL live there. Other chains get on-demand checks. A check runs inside `chainCtx`,
 * so every RPC read (through `client`) and every DexScreener lookup goes to that check's chain
 * without threading a parameter through every function.
 */
export type ChainKey = 'robinhood' | 'elysium';
export interface ChainInfo { key: ChainKey; id: number; name: string; native: string; dex: string; explorer: string; rpc: string }
export const CHAINS: Record<ChainKey, ChainInfo> = {
  robinhood: { key: 'robinhood', id: 4663, name: 'Robinhood Chain', native: 'ETH', dex: 'robinhood', explorer: 'https://robin.etherscan.io', rpc: config.rpcUrl },
  elysium: { key: 'elysium', id: 99901, name: 'Elysium', native: 'HYPE', dex: 'elysium', explorer: 'https://elyscan.live', rpc: process.env.ELYSIUM_RPC_URL || 'https://rpc.elysium.kinetiq.xyz' },
};
export const chainCtx = new AsyncLocalStorage<ChainKey>();
export const currentChain = (): ChainInfo => CHAINS[chainCtx.getStore() ?? 'robinhood'];
export const isChainKey = (s: unknown): s is ChainKey => typeof s === 'string' && s in CHAINS;
/** Runs fn with every read pointed at that chain. */
export const onChain = <T>(key: ChainKey, fn: () => T): T => chainCtx.run(key, fn);

/*
 * One gate for every RPC request the server makes. The public RPC answers bursts with 429, and a
 * check that loses those races ends up with half its data, so requests are spaced out here
 * instead of hoping retries catch up. Work started by the background launch feed runs in the
 * `background` context and always waits behind checks a person asked for.
 */
export const background = new AsyncLocalStorage<boolean>();
const MAX_INFLIGHT = 4;
const MIN_GAP_MS = 45;
const queues: { fg: (() => void)[]; bg: (() => void)[] } = { fg: [], bg: [] };
let inflight = 0;
let lastStart = 0;
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    while (inflight < MAX_INFLIGHT && (queues.fg.length || queues.bg.length)) {
      const wait = lastStart + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(step, wait); return; }
      lastStart = Date.now();
      inflight++;
      (queues.fg.shift() ?? queues.bg.shift())!();
    }
    pumping = false;
  };
  step();
}

const gatedFetch: typeof fetch = async (input, init) => {
  await new Promise<void>(go => { (background.getStore() ? queues.bg : queues.fg).push(go); pump(); });
  try {
    return await fetch(input, init);
  } finally {
    inflight--;
    pump();
  }
};

/** True while any person-initiated RPC work is waiting or running. */
export const foregroundBusy = () => queues.fg.length > 0;

const makeClient = (c: ChainInfo) => createPublicClient({
  chain: c.key === 'robinhood' ? robinhoodChain : defineChain({ id: c.id, name: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } }),
  // batch: many small calls (getCode for top holders etc.) go out as one HTTP request
  transport: http(c.rpc, { retryCount: 2, timeout: 25_000, batch: { batchSize: 50, wait: 10 }, fetchFn: gatedFetch }),
});
const clients = { robinhood: makeClient(CHAINS.robinhood), elysium: makeClient(CHAINS.elysium) };
/** Robinhood Chain, always: for the ledger, x402, the launch feed and $TELL. */
export const homeClient = clients.robinhood;
export const clientFor = (key: ChainKey) => clients[key];
/** The client for whichever chain the current check runs on (Robinhood Chain outside a check). */
export const client: typeof homeClient = new Proxy(homeClient, {
  get: (_t, prop) => {
    const c = clients[chainCtx.getStore() ?? 'robinhood'] as any;
    const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  },
});

/** The chain to check on: an explicit ?chain=, a DexScreener link's chain, or wherever the contract exists. */
export async function pickChain(asked: string | null | undefined, input: string, address: `0x${string}`): Promise<ChainKey> {
  if (isChainKey(asked)) return asked;
  const fromLink = input.match(/dexscreener\.com\/([a-z0-9-]+)\//i)?.[1]?.toLowerCase();
  const byLink = Object.values(CHAINS).find(c => c.dex === fromLink);
  if (byLink) return byLink.key;
  return (await detectChain(address)) ?? 'robinhood';
}

/** Which chain a token lives on: the one where the address has contract code (home first). */
export async function detectChain(address: `0x${string}`): Promise<ChainKey | undefined> {
  for (const key of ['robinhood', 'elysium'] as ChainKey[]) {
    const code = await clients[key].getCode({ address }).catch(() => undefined);
    if (code && code !== '0x') return key;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const errText = (e: any) => String(e?.details ?? e?.shortMessage ?? e?.message ?? e);
export const isRateLimit = (e: unknown) => /too many requests|429|rate limit/i.test(errText(e));

/** Retries rate-limit errors with backoff; anything else is thrown to the caller. */
export async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < 8 && isRateLimit(e)) {
        await sleep(Math.min(400 * 2 ** attempt, 8000) + Math.random() * 300);
        continue;
      }
      throw e;
    }
  }
}
