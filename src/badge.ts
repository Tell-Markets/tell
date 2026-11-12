/*
 * Embeddable risk badge: /api/v1/badge/0x….svg (".svg" optional, ?chain=elysium for Elysium tokens).
 * Shows the last score on file. A token with no score yet gets a quick check in the background and a
 * grey "not checked" badge until it lands, so embedding a badge never makes a page wait.
 */
import { cachedReport } from './reports.js';
import { quickCheck } from './quick.js';

const COLORS = { low: '#3fb950', medium: '#d29922', caution: '#f0883e', high: '#f85149', none: '#6e7681' };
const pending = new Set<string>();

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// rough width of 11px sans text; good enough for a pill
const textW = (s: string) => Math.ceil([...s].reduce((w, c) => w + (/[A-Z0-9]/.test(c) ? 7.4 : c === ' ' || c === '·' ? 3.6 : 6.4), 0));

export function badgeSvg(address: `0x${string}`): { svg: string; scored: boolean } {
  const hit = cachedReport(address);
  let right: string, color: string;
  if (hit) {
    const v = hit.report.score.value;
    const lvl = v >= 80 ? 'high' : v >= 60 ? 'caution' : v >= 30 ? 'medium' : 'low';
    right = `${v} · ${lvl === 'high' ? 'HIGH RISK' : lvl.toUpperCase()}`;
    color = COLORS[lvl];
  } else {
    right = 'not checked';
    color = COLORS.none;
    const key = address.toLowerCase();
    if (!pending.has(key) && pending.size < 50) {
      pending.add(key);
      quickCheck(address).catch(() => {}).finally(() => pending.delete(key));
    }
  }
  const left = 'Tell risk';
  const lw = textW(left) + 20, rw = textW(right) + 20, w = lw + rw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`${left}: ${right}`)}">
<title>${esc(`${left}: ${right} (tell.markets)`)}</title>
<clipPath id="r"><rect width="${w}" height="20" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#0d1117"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>
<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14" font-weight="bold">${esc(right)}</text>
</g></svg>`;
  return { svg, scored: Boolean(hit) };
}
