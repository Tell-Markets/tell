import { getAddress, isAddress, zeroAddress } from 'viem';
import { checkContract, readToken } from './checks/contract.js';
import { checkDeployer, type DeployerFacts } from './checks/deployer.js';
import { checkHolders } from './checks/holders.js';
import { checkMarket, checkSocials } from './checks/market.js';
import { aiReview } from './ai/review.js';
import { aiChecks, checkSite } from './checks/website.js';
import { checkPromises } from './checks/promises.js';
import { fetchTransfers } from './sources/logs.js';
import { fetchSite } from './sources/website.js';
import { launchMeta, type LaunchMeta } from './sources/launch.js';
import { background, client, currentChain, withBackoff, type ChainKey } from './sources/rpc.js';

/** Background checks only spend an AI call on launches with at least this many holders. */
const AI_MIN_HOLDERS = Number(process.env.AI_MIN_HOLDERS) || 10;
import type { Check, TokenInfo } from './checks/types.js';
import { getPair, getTokenPairs, type DexPair } from './sources/dexscreener.js';
import { buildFlow, type FlowGraph } from './flow.js';
import { config } from './config.js';
import { knownAsset, stockImpostor, tellIdentity } from './known.js';
import { score, type Score } from './scoring.js';
import { strictChecks } from './checks/strict.js';
import { honeypotOf } from './sources/gecko.js';
import { launchOf } from './launches.js';
import { overallRugPct } from './accuracy.js';

export interface Report {
  /** Which chain the token lives on; absent on older Robinhood Chain reports. */
  chain?: ChainKey;
  token: TokenInfo;
  pairs: DexPair[];
  checks: Check[];
  facts: Facts;
  score: Score;
  verdict: string;
  /** True when the verdict was written by the AI rather than assembled from the checks. */
  aiVerdict: boolean;
  /** Image, description and links the token was launched with. */
  meta?: LaunchMeta;
  /** Token map for the app. Large, so /api/check leaves it out unless asked. */
  flow?: FlowGraph;
  /** The map covers only the latest transfers of a very busy token. */
  flowPartial?: boolean;
  /** Some data failed to load (usually RPC rate limits); kept only briefly. */
  degraded?: boolean;
  ms: number;
}

export interface Facts {
  holders?: number;
  deployer?: string;
  launches?: number;
  /** Share of supply sent to the zero or dead address after the mint, in percent. */
  burnedPct?: number;
}

/**
 * Finds the token address in whatever the user sent: a bare address, a DexScreener link
 * (pair address or 32-byte Uniswap v4 pool id), or any URL that contains an address.
 */
export async function resolveToken(input: string): Promise<`0x${string}` | undefined> {
  const addr = input.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/)?.[0];
  const poolId = input.match(/0x[a-fA-F0-9]{64}/)?.[0];

  if (poolId) {
    const pair = await getPair(poolId).catch(() => undefined);
    if (pair) return getAddress(pair.baseToken.address);
  }
  if (addr && isAddress(addr)) {
    // A DexScreener v2/v3 link carries the pair address, not the token.
    if (input.includes('dexscreener.com')) {
      const pair = await getPair(addr).catch(() => undefined);
      if (pair) return getAddress(pair.baseToken.address);
    }
    return getAddress(addr);
  }
  return undefined;
}

/** Time since the token launched on Pons, or since its oldest pool opened; undefined if unknown. */
export function tokenAge(address: string, pairs: DexPair[]): number | undefined {
  const launched = launchOf(address)?.at;
  const pooled = pairs.map(p => p.pairCreatedAt).filter((t): t is number => !!t).sort((a, b) => a - b)[0];
  const t = launched ?? pooled;
  return t ? Date.now() - t : undefined;
}

export async function analyze(address: `0x${string}`): Promise<Report> {
  const started = Date.now();
  let [token, pairs] = await Promise.all([
    readToken(address),
    getTokenPairs(address).catch(() => [] as DexPair[]),
  ]);
  // a busy RPC can drop these reads; one more try before calling it "not a standard token"
  if (token.symbol === undefined || token.totalSupply === undefined) {
    await new Promise(r => setTimeout(r, 1500));
    token = await readToken(address);
  }
  const ownPairs = pairs.filter(p => p.baseToken.address.toLowerCase() === address.toLowerCase());

  // The site usually comes from the DEX listing; tokens still on a bonding curve only have the
  // link they were launched with, which we learn from the launch transaction.
  const listedSite = ownPairs.find(p => p.info?.websites?.length)?.info?.websites?.[0]?.url;
  const [contractChecks, onchain, listed] = await Promise.all([
    checkContract(token),
    checkOnchain(token, ownPairs),
    listedSite ? fetchSite(listedSite) : Promise.resolve(undefined),
  ]);
  const meta = onchain.meta;
  const site = listed ?? (meta?.website ? await fetchSite(meta.website) : undefined);
  const checks = [
    ...contractChecks,
    ...onchain.checks,
    ...checkMarket(ownPairs),
    ...checkSocials(ownPairs, meta),
    ...checkSite(token, site),
  ];

  // honeypot: can a buyer sell? (GeckoTerminal's simulation; Robinhood Chain only, unknown = no finding)
  if (currentChain().key === 'robinhood' && ownPairs.length && !knownAsset(address)) {
    const hp = await honeypotOf(address);
    if (hp === true) checks.unshift({ group: 'contract', status: 'bad', title: "Honeypot: buyers can't sell", detail: 'flagged by GeckoTerminal\'s sell simulation', risk: 100, critical: true });
    else if (hp === false) checks.push({ group: 'contract', status: 'ok', title: 'Not a honeypot: selling works', risk: 0 });
  }
  applyIdentity(token, checks);
  checks.push(...await checkPromises(token, site, onchain.burnedPct));

  // The AI reads the site and sees every other finding, so it runs last.
  // AI costs money per call: background checks of launches nobody holds skip it (rules still run);
  // anything a person asks for, or a launch with real holders, still gets the full read
  const worthAi = !background.getStore() || (onchain.facts.holders ?? 0) >= AI_MIN_HOLDERS;
  const review = worthAi ? await aiReview(token, checks, site, meta?.description) : undefined;
  if (worthAi) checks.push(...aiChecks(review, site, checks));
  else checks.push({ group: 'website', status: 'info', title: 'AI read of the site: skipped for now', detail: 'the token has almost no holders; check it on tell.markets for the full read', risk: 0 });
  if (!knownAsset(address)) checks.push(...strictChecks(checks, tokenAge(address, ownPairs), overallRugPct(), currentChain().name));

  return {
    chain: currentChain().key, token, pairs: ownPairs, checks, facts: onchain.facts, flow: onchain.flow, flowPartial: onchain.flowPartial, meta,
    score: score(checks), verdict: review?.verdict || verdict(checks), aiVerdict: Boolean(review?.verdict),
    // a token we couldn't read or whose history failed to load: show it, but don't trust it for long
    degraded: onchain.degraded || token.symbol === undefined || token.totalSupply === undefined,
    ms: Date.now() - started,
  };
}

/**
 * Known assets and Tell's own token. Stablecoins, WETH and stock tokens keep owner powers by
 * design, so they aren't scored like a memecoin; anything posing as $TELL is flagged.
 */
export function applyIdentity(token: TokenInfo, checks: Check[]) {
  const known = knownAsset(token.address);
  if (known) {
    for (const c of checks) {
      if (c.group !== 'contract' || c.status === 'ok') continue;
      c.status = 'info'; c.risk = 0; c.critical = false;
      c.detail = 'expected for this asset';
    }
    checks.unshift({ group: 'contract', status: 'ok', title: `Recognized asset: ${known}`, risk: 0 });
  }

  // Kinetiq has said Elysium has no token: anything on Elysium named after the chain borrows its name
  const norm = (x?: string) => (x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (currentChain().key === 'elysium' && [norm(token.symbol), norm(token.name)].some(n => n === 'elysium' || n === 'ely' || n === 'elysiumtoken' || n === 'kinetiqelysium')) {
    checks.unshift({
      group: 'contract', status: 'bad', title: 'Uses the Elysium name: Elysium has no token',
      detail: 'Kinetiq says there is no Elysium token and no points program, so this one is not official', risk: 80, critical: true,
    });
  }

  // Robinhood Chain's own stock tokens are the most copied tickers there
  const stock = currentChain().key === 'robinhood' ? stockImpostor(token.address, token.name, token.symbol) : undefined;
  if (stock) {
    const what = stock.sym === 'a stock' ? 'name' : `$${stock.sym} ticker`;
    checks.unshift({
      group: 'contract', status: 'bad', title: `Borrows the ${what} of an official Robinhood stock token`,
      detail: stock.address ? `the real ${stock.sym} token is ${stock.address.slice(0, 6)}…${stock.address.slice(-4)}; this one is not it` : 'it calls itself a Robinhood Token but is not one of the official stock tokens',
      risk: 80, critical: true,
    });
  }

  const tell = tellIdentity(token.address, token.name, token.symbol);
  if (tell === 'official') {
    checks.unshift({ group: 'contract', status: 'ok', title: 'Official $TELL token', detail: 'the address published on tell.markets', risk: 0 });
  } else if (tell === 'previous') {
    checks.unshift({
      group: 'contract', status: 'warn', title: 'Old $TELL contract: replaced',
      detail: config.tellToken ? `Tell moved to a new contract, ${config.tellToken.slice(0, 6)}…${config.tellToken.slice(-4)}, published on tell.markets. This one is no longer supported.` : 'Tell moved to a new contract, published on tell.markets.',
      risk: 60, floor: 80,
    });
  } else if (tell === 'impostor') {
    checks.unshift({
      group: 'contract', status: 'bad', title: 'Fake $TELL: not the official token',
      detail: config.tellToken
        ? `the only official $TELL is ${config.tellToken.slice(0, 6)}…${config.tellToken.slice(-4)}, published on tell.markets`
        : 'Tell has not launched a token yet; anything called TELL is an impersonation',
      risk: 80, critical: true,
    });
  }
}

const BURN_ADDRESSES = new Set([zeroAddress, '0x000000000000000000000000000000000000dead']);

/** Holders and deployer both come from the token's full transfer history. */
async function checkOnchain(token: TokenInfo, pairs: DexPair[]): Promise<{ checks: Check[]; facts: Facts; flow?: FlowGraph; flowPartial?: boolean; meta?: LaunchMeta; degraded?: boolean; burnedPct?: number }> {
  try {
    const { transfers, complete } = await fetchTransfers(token.address);
    if (!complete) {
      // Busy token: holder and deployer checks need the full history, but the latest transfers
      // still make a useful map of where the supply is moving now.
      const recent = await checkHolders(token, transfers).catch(() => undefined);
      return {
        checks: [{ group: 'holders', status: 'info', title: 'Busy token: holder checks skipped', detail: 'more than 40k transfers; the map shows the latest ones', risk: 0 }],
        facts: {},
        flow: recent ? buildFlow(token, transfers, recent.facts, undefined, pairs) : undefined,
        flowPartial: true,
      };
    }
    const mint = transfers.find(t => t.from === zeroAddress);
    const metaP = mint
      ? withBackoff(() => client.getTransaction({ hash: mint.tx })).then(tx => launchMeta(tx.input)).catch(() => undefined)
      : Promise.resolve(undefined);
    const holdersP = checkHolders(token, transfers);
    const [holders, deployer] = await Promise.all([
      holdersP,
      checkDeployer(token, transfers, holdersP.then(h => h.facts)).catch(err => {
        console.error('deployer check failed', err);
        return { checks: [] as Check[], facts: {} as DeployerFacts };
      }),
    ]);
    // tokens sent to the zero or dead address after the mint: what a "we burn" promise can be checked against
    let burned = 0n;
    for (const t of transfers) if (t.from !== zeroAddress && BURN_ADDRESSES.has(t.to.toLowerCase())) burned += t.value;
    const burnedPct = token.totalSupply ? Number((burned * 1_000_000n) / token.totalSupply) / 10_000 : undefined;
    return {
      checks: [...holders.checks, ...deployer.checks],
      facts: { holders: holders.facts.holders, deployer: deployer.facts.address, launches: deployer.facts.launches, burnedPct },
      flow: buildFlow(token, transfers, holders.facts, deployer.facts.address, pairs),
      meta: await metaP,
      burnedPct,
    };
  } catch (err) {
    console.error('on-chain checks failed', (err as Error)?.message ?? err);
    return {
      checks: [{ group: 'holders', status: 'info', title: 'Holder data is unavailable right now', detail: 'the network was busy; check again in a minute', risk: 0 }],
      facts: {}, degraded: true,
    };
  }
}

/** Rule-based one-liner until the AI verdict lands: the two worst findings, or an all-clear. */
export function verdict(checks: Check[]): string {
  const rank = { bad: 0, warn: 1, info: 2, ok: 3 } as const;
  const worst = checks
    .filter(c => c.status === 'bad' || c.status === 'warn')
    .sort((a, b) => rank[a.status] - rank[b.status] || b.risk - a.risk)
    .slice(0, 2)
    .map(c => c.title);
  if (!worst.length) return 'No obvious red flags in the contract, holders, deployer or market.';
  return worst.join('. ') + '.';
}
