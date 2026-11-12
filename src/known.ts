import { createRequire } from 'node:module';
import { config } from './config.js';

/** Official tokenized stocks on Robinhood Chain ("<Company> • Robinhood Token"), by address. */
export const STOCK_TOKENS = createRequire(import.meta.url)('./stock-tokens.json') as { sym: string; name: string; address: string }[];

// Established assets that legitimately keep owner powers (minting, pausing, upgrades). Matched
// by address only: names are free to copy, so "• Robinhood Token" in a name proves nothing.
export const KNOWN_ASSETS: Record<string, string> = {
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'Wrapped Ether',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'Global Dollar (USDG) stablecoin',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'Robinhood stock token: SPY',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'Robinhood stock token: NVDA',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'Robinhood stock token: TSLA',
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': 'Robinhood stock token: AAPL',
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': 'Robinhood stock token: SPCX',
};

for (const st of STOCK_TOKENS) KNOWN_ASSETS[st.address] ??= `Robinhood stock token: ${st.sym}`;

export const knownAsset = (address: string) => KNOWN_ASSETS[address.toLowerCase()];

const STOCK_BY_SYM = new Map(STOCK_TOKENS.map(st => [st.sym, st]));
/**
 * A token that takes the ticker of an official Robinhood stock token (or calls itself a "Robinhood
 * Token") without being one. Buyers searching "NVDA" on a launchpad can land on it by mistake.
 */
export function stockImpostor(address: string, name?: string, symbol?: string): { sym: string; address: string } | undefined {
  if (KNOWN_ASSETS[address.toLowerCase()]) return undefined;
  const sym = (symbol ?? '').trim().toUpperCase().replace(/^\$/, '');
  const hit = STOCK_BY_SYM.get(sym);
  if (hit) return { sym: hit.sym, address: hit.address };
  if (/robinhood\s*token/i.test(name ?? '')) {
    const byName = STOCK_TOKENS.find(st => (name ?? '').toLowerCase().includes(st.name.toLowerCase()));
    return byName ? { sym: byName.sym, address: byName.address } : { sym: 'a stock', address: '' };
  }
  return undefined;
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Anyone can launch a token called TELL on Pons. The only real one is the address in TELL_TOKEN;
 * every other token that borrows the name is flagged, and before launch they are all fakes.
 */
export function tellIdentity(address: string, name?: string, symbol?: string): 'official' | 'previous' | 'impostor' | undefined {
  if (config.tellToken && address.toLowerCase() === config.tellToken) return 'official';
  if (config.tellPrevious.includes(address.toLowerCase())) return 'previous';
  const sym = norm(symbol), nm = norm(name);
  const borrows = sym === 'tell' || sym === 'tellmarkets' || nm === 'tell' || nm === 'telltoken' || nm.includes('tellmarkets');
  return borrows ? 'impostor' : undefined;
}
