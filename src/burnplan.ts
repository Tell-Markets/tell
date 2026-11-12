/*
 * The public $TELL burn schedule: 1M TELL a day from the deployer wallet, 11 days in a row at
 * 18:00 UTC. Each slot is marked done by the matching burn found on-chain (a transfer of at least
 * ~1M from anywhere to 0x…dEaD after the schedule began), in order, so nothing here is self-reported.
 */

const DAY = 24 * 3600_000;

export const BURN_PLAN = {
  /** The $TELL contract this schedule was for; it ends if Tell moves to a new contract. */
  token: '0xc13630c6b85fd1767b484acf38b50314e08a59fc',
  wallet: '0x53087a32c9992740edae2a478c0295316c25762e',
  perBurn: 1_000_000,
  count: 11,
  hourUtc: 18,
  start: Date.UTC(2026, 10, 12, 18), // Nov 12, 2026, 18:00 UTC
};

export interface Slot { n: number; due: number; status: 'done' | 'today' | 'upcoming' | 'late'; tx?: string; at?: number; amount?: number }

export function burnSchedule(burns: { tx: string; amount: number; at: number }[], now = Date.now()) {
  const p = BURN_PLAN;
  const eligible = burns.filter(b => b.amount >= p.perBurn * 0.99 && b.at >= p.start - 20 * 3600_000).sort((a, b) => a.at - b.at);
  const slots: Slot[] = [];
  for (let i = 0; i < p.count; i++) {
    const due = p.start + i * DAY;
    const b = eligible[i];
    const status: Slot['status'] = b ? 'done' : now > due + 12 * 3600_000 ? 'late' : Math.abs(now - due) < 12 * 3600_000 ? 'today' : 'upcoming';
    slots.push({ n: i + 1, due, status, ...(b ? { tx: b.tx, at: b.at, amount: b.amount } : {}) });
  }
  const done = slots.filter(s => s.status === 'done').length;
  return { ...p, done, slots };
}
