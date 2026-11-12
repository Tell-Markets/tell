/*
 * GeckoTerminal's token info for Robinhood Chain. Used for one fact Tell can't read from a contract
 * alone: whether the token is a honeypot (buyers can't sell). Free API, 30 calls a minute, so
 * answers are cached and a failure just means "unknown".
 */

const BASE = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const cache = new Map<string, { at: number; honeypot: boolean | null }>();
const TTL = 30 * 60_000;

export async function honeypotOf(address: string): Promise<boolean | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.honeypot;
  let honeypot: boolean | null = null;
  try {
    const res = await fetch(`${BASE}/tokens/${key}/info`, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json() as { data?: { attributes?: { is_honeypot?: unknown } } };
      const v = j.data?.attributes?.is_honeypot;
      honeypot = typeof v === 'boolean' ? v : null;
    }
  } catch { /* unknown */ }
  cache.set(key, { at: Date.now(), honeypot });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return honeypot;
}
