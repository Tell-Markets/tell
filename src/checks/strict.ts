import type { Check } from './types.js';

/*
 * Strict mode. Most Pons launches that get buyers are rugged within three days (Tell's own
 * outcome data, /accuracy), so a young token is never called low risk: it has to survive first.
 * And the signs that most often come before a rug are scored as high risk on their own.
 */

const H = 3600_000;
export const PROVEN_AFTER_MS = 72 * H;

/** ageMs: time since launch (or since its pool opened); undefined when unknown, treated as young. */
export function strictChecks(checks: Check[], ageMs: number | undefined, rugPct: number | null, chainName = 'Robinhood Chain'): Check[] {
  const out: Check[] = [];
  const has = (re: RegExp) => checks.some(c => c.status !== 'ok' && re.test(c.title));

  // 1. Nothing young is low risk. The floor lifts once the token has lasted three days.
  if (ageMs === undefined || ageMs < PROVEN_AFTER_MS) {
    const age = ageMs === undefined ? 'age unknown' : ageMs < H ? `${Math.max(1, Math.round(ageMs / 60_000))}m old` : `${Math.round(ageMs / H)}h old`;
    out.push({
      group: 'market', status: 'warn', title: `Unproven: ${age}`,
      detail: chainName === 'Robinhood Chain'
        ? `${rugPct ?? 90}% of Pons launches that got buyers were rugged within 3 days; scores stay at caution or higher until a token has lasted that long`
        : `${chainName} is brand new and Tell has no survival data there yet; nothing scores below caution until it has lasted 3 days`,
      risk: 0, floor: 60,
    });
  }

  // 2. Signs that usually come right before (or are) a rug: high risk on their own.
  const hard: [RegExp, string][] = [
    [/^Deployer sold their whole bag/, 'the deployer already cashed out'],
    [/different token|another token|pitches .*token|promotes a different/i, 'the site belongs to another project'],
    [/^Fake \$TELL/, 'it impersonates $TELL'],
  ];
  for (const [re, why] of hard) {
    const c = checks.find(x => x.status !== 'ok' && re.test(x.title));
    if (c) { c.critical = true; c.status = 'bad'; c.detail = c.detail ? `${c.detail} · ${why}` : why; }
  }
  if (has(/^No real website/) && has(/^Only \d+ holders?$/)) {
    out.push({ group: 'website', status: 'bad', title: 'No product and no buyers', detail: 'a placeholder link and almost no holders', risk: 0, critical: true });
  }
  return out;
}
