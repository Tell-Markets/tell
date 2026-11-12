// Re-applies the current scoring rules (strict mode, holder floor) to every saved report, without
// re-running any checks. Run with the server stopped:  npx tsx scripts/rescore.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { strictChecks } from '../src/checks/strict.js';
import { score } from '../src/scoring.js';
import { knownAsset } from '../src/known.js';
import type { Check } from '../src/checks/types.js';

const dir = process.env.DATA_DIR ?? 'data';
const reportsPath = `${dir}/reports.json`, launchesPath = `${dir}/launches.json`;
const reports = JSON.parse(readFileSync(reportsPath, 'utf8')) as Record<string, { at: number; report: any }>;
const launches = existsSync(launchesPath) ? JSON.parse(readFileSync(launchesPath, 'utf8')) as Record<string, { at: number }> : {};

// same rug rate the live server uses, from the saved outcomes when there are enough
let rugPct: number | null = null;
const rugsPath = `${dir}/accuracy-rugs-v2.json`;
if (existsSync(rugsPath)) {
  const rows = Object.values(JSON.parse(readFileSync(rugsPath, 'utf8'))) as { peakHolders: number; rug: boolean }[];
  const got = rows.filter(r => r.peakHolders >= 10);
  if (got.length >= 100) rugPct = Math.round(got.filter(r => r.rug).length / got.length * 100);
}

let changed = 0;
const moves: Record<string, number> = {};
for (const [key, entry] of Object.entries(reports)) {
  const r = entry.report;
  if (!r?.checks || knownAsset(key)) continue;
  const before = r.score?.label;
  const checks: Check[] = r.checks.filter((c: Check) => !/^Unproven:/.test(c.title) && c.title !== 'No product and no buyers');
  const pooled = (r.pairs ?? []).map((p: any) => p.pairCreatedAt).filter(Boolean).sort((a: number, b: number) => a - b)[0];
  const t = launches[key]?.at ?? pooled;
  // age as of when the report was made, so a saved check isn't judged by today's clock
  const age = t ? entry.at - t : undefined;
  checks.push(...strictChecks(checks, age, rugPct));
  r.checks = checks;
  r.score = score(checks);
  if (r.score.label !== before) { changed++; moves[`${before} → ${r.score.label}`] = (moves[`${before} → ${r.score.label}`] ?? 0) + 1; }
}
writeFileSync(reportsPath, JSON.stringify(reports));
console.log(`rescored ${Object.keys(reports).length} reports, ${changed} changed level, rug rate ${rugPct}%`);
console.log(moves);
