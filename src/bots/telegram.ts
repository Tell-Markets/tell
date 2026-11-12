import type { Report } from '../analyze.js';
import { resolveToken } from '../analyze.js';
import { summary } from '../api.js';
import { config } from '../config.js';
import { events } from '../events.js';
import { launchFeed } from '../launches.js';
import { elysiumLaunchOf } from '../elysium.js';
import { cachedReport } from '../reports.js';
import { fullCheck, quickCheck } from '../quick.js';
import { JsonStore } from '../store.js';
import { tokenCardWithLogo } from '../og.js';
import { onChain, pickChain } from '../sources/rpc.js';
import { ago, marketOf, usd, type Market } from '../sources/market.js';

/*
 * Telegram: a bot that answers /check 0x… (or any message with an address) and, when a channel is
 * set, posts each Pons launch that got real traction once its full check is done.
 */

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
/** Launches with fewer holders than this are not worth a channel post; keeps the feed readable. */
const MIN_HOLDERS = Number(process.env.TELEGRAM_MIN_HOLDERS) || 50;
/** Channel posts skip anything scored this risky or worse. */
const MAX_SCORE = Number(process.env.TELEGRAM_MAX_SCORE) || 80;
/** …and anything with a market cap under this. */
const MIN_CAP_USD = Number(process.env.TELEGRAM_MIN_CAP_USD) || 10_000;
/** Lower bar for Pons launches on Robinhood Chain. */
const PONS_MIN_HOLDERS = Number(process.env.TELEGRAM_PONS_MIN_HOLDERS) || 25;
const PONS_MIN_CAP_USD = Number(process.env.TELEGRAM_PONS_MIN_CAP_USD) || 5_000;
const posted = new JsonStore<number>('telegram-posted.json', 20_000);
const pending = new Set<string>();

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${API()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(70_000) });
  const data = await res.json() as { ok: boolean; result?: any; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const web = (u?: string) => { try { const x = new URL(u ?? ''); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : undefined; } catch { return undefined; } };

/** The token's own site and socials, from its DEX listing or its launch metadata. */
function tokenLinks(r: Report) {
  const info = r.pairs?.find(p => p.info)?.info;
  const socials = [...(info?.socials ?? []), ...(r.meta?.socials ?? [])];
  const pick = (re: RegExp) => web(socials.find(x => re.test(x.type) || re.test(x.url))?.url);
  return { site: web(info?.websites?.[0]?.url ?? r.meta?.website), x: pick(/twitter|x\.com/i), tg: pick(/telegram|t\.me/i) };
}

function linkLine(r: Report, report: string, map: string) {
  const l = tokenLinks(r);
  return [l.site && `<a href="${esc(l.site)}">Website</a>`, l.x && `<a href="${esc(l.x)}">X</a>`, l.tg && `<a href="${esc(l.tg)}">Telegram</a>`,
    `<a href="${report}">Report</a>`, `<a href="${map}">Map</a>`].filter(Boolean).join('  ·  ');
}

function marketBlock(m?: Market) {
  if (!m) return '';
  const when = m.tradingSince ? new Date(m.tradingSince) : undefined;
  const since = when ? `${when.toISOString().slice(11, 16)} UTC, ${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} (${ago(m.tradingSince!)})` : undefined;
  return [
    `MC <b>${usd(m.marketCapUsd)}</b>  ·  FDV ${usd(m.fdvUsd)}  ·  Vol 24h ${usd(m.volume24hUsd)}`,
    `Liquidity ${usd(m.liquidityUsd)}${m.holders !== undefined ? `  ·  ${m.holders.toLocaleString('en-US')} holders` : ''}`,
    `${since ? `Trading since ${since}  ·  ` : ''}${esc(m.venue)}`,
  ].join('\n');
}

export function card(r: Report, base: string, mode: 'quick' | 'full' = 'full', market?: Market) {
  const s = summary({ report: r, at: Date.now(), mode }, base);
  const sym = s.token.symbol ? `$${esc(s.token.symbol)}` : 'Token';
  // same order as the X share text: real red flags first, the ones most launches share last
  const generic = (t: string) => /^No DEX pool|^\d+ holders?$/i.test(t);
  const flags = [...s.flags].sort((a, b) => Number(generic(a.title)) - Number(generic(b.title)) || (a.severity === 'bad' ? -1 : 0) - (b.severity === 'bad' ? -1 : 0) || b.risk - a.risk)
    // plain arrows like the X posts; the serious ones in bold instead of coloured dots
    .slice(0, 4).map(f => f.severity === 'bad' ? `→ <b>${esc(f.title)}</b>` : `→ ${esc(f.title)}`).join('\n');
  const passed = s.passed.filter(p => p.group === 'contract').slice(0, 2).map(p => esc(p.title.charAt(0).toLowerCase() + p.title.slice(1)));
  return [
    `<b>${sym}</b>  ·  ${s.risk.score}/100 risk  ·  ${esc(s.risk.label)}${r.chain && r.chain !== 'robinhood' ? '  ·  Elysium' : ''}`,
    `<code>${s.token.address}</code>`,
    '',
    marketBlock(market),
    '',
    flags || '→ No red flags found',
    passed.length ? `✓ ${passed.join(', ').replace(/^./, c => c.toUpperCase())}` : '',
    '',
    `${linkLine(r, s.links.report, s.links.map)}${mode === 'quick' ? '\n<i>Quick check: contract and market. The full check runs in the background.</i>' : ''}`,
    '<i>Not financial advice. A score is not an endorsement: most launches rug.</i>',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

async function reply(chatId: number, text: string, replyTo?: number) {
  await call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    // in a group, answer the message that had the address, so the thread stays readable
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  }).catch(err => console.error(err.message));
}

/**
 * The card as a photo: the share image (with the token's logo) on top, the flags and links as the
 * caption. Falls back to a plain message if the image can't be made or the caption is too long.
 */
async function sendCard(chatId: number | string, r: Report, base: string, replyTo?: number) {
  const market = await marketOf(r).catch(() => undefined);
  const text = card(r, base, 'full', market);
  try {
    if (text.length > 1024) throw new Error('caption too long');
    const png = await tokenCardWithLogo(r);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), `tell-${(r.token.symbol || 'token').replace(/[^\w-]/g, '')}.png`);
    form.set('caption', text);
    form.set('parse_mode', 'HTML');
    if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    const res = await fetch(`${API()}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description);
  } catch (err) {
    console.error('telegram photo failed, sending text', (err as Error).message);
    await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) })
      .catch(e => console.error('telegram send failed', e.message));
  }
}

/** The same token pasted again in the same chat within this window gets no second card. */
const REPEAT_MS = 3 * 60_000;
const lastCard = new Map<string, number>();

async function onMessage(msg: { chat: { id: number; type?: string }; message_id?: number; text?: string; caption?: string }, base: string) {
  const t = (msg.text ?? msg.caption ?? '').trim();
  // in a group, answer the message that had the address
  const rid = msg.chat.type === 'private' ? undefined : msg.message_id;
  const say = (text: string) => reply(msg.chat.id, text, rid);
  if (/^\/(start|help)/.test(t)) {
    return say('Send a Robinhood Chain token address or DexScreener link, or use /check 0x…\n/launches — newest Pons launches with scores.\n\nTell reads the contract, holders, deployer, website and market and returns one risk score. Not financial advice.');
  }
  if (/^\/launches/.test(t)) {
    const rows = launchFeed().filter(l => l.score).slice(0, 10)
      .map(l => `<b>$${esc(l.symbol ?? '?')}</b>  ·  ${l.score!.value}/100  ·  <a href="${base}/t/${l.token}">report</a>`);
    return say(rows.length ? `<b>Latest checked Pons launches</b>\n${rows.join('\n')}` : 'No checked launches yet. Try again in a few minutes.');
  }
  if (!/0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64}|dexscreener\.com/.test(t)) {
    if (t.startsWith('/check')) return say('Usage: /check 0x… (token address or DexScreener link)');
    return;
  }
  const address = await resolveToken(t);
  if (!address) return rid ? undefined : say('No token found in that message.');
  // the whole check runs on the token's own chain (Robinhood Chain or Elysium)
  const chain = await pickChain(null, t, address);
  return onChain(chain, async () => {
  const key = `${msg.chat.id}:${address.toLowerCase()}`;
  if (Date.now() - (lastCard.get(key) ?? 0) < REPEAT_MS) return;
  lastCard.set(key, Date.now());
  if (lastCard.size > 5000) lastCard.delete(lastCard.keys().next().value!);
  // A fresh full report goes out at once. Otherwise no quick score: a contract-only check can
  // read "low risk" on a token the full check flags, which in a group chat reads as a green light.
  // Say it's checking, run the full check, then replace that message with the card.
  const a = await quickCheck(address).catch(() => undefined);
  // wallets get pasted in groups all the time ("send to 0x…"): only answer for actual tokens
  if (a && (a.report.token.totalSupply === undefined || a.report.token.symbol === undefined)) {
    lastCard.delete(key);
    return rid ? undefined : say("That address isn't a token on Robinhood Chain or Elysium (no symbol or supply). Send a token contract address.");
  }
  if (a?.mode === 'full') return sendCard(msg.chat.id, a.report, base, rid);
  const sym = a?.report.token.symbol ? `$${esc(a.report.token.symbol)}` : `<code>${address}</code>`;
  const wait = await call('sendMessage', {
    chat_id: msg.chat.id, text: `Checking ${sym}: contract, holders, deployer, website, market. About 15 seconds…`, parse_mode: 'HTML',
    ...(rid ? { reply_parameters: { message_id: rid, allow_sending_without_reply: true } } : {}),
  }).catch(() => undefined) as { message_id: number } | undefined;
  const full = await Promise.race([fullCheck(address), new Promise<undefined>(r => setTimeout(r, 120_000, undefined))]).catch(() => undefined);
  if (full) {
    // a text message can't turn into a photo, so the "checking" note goes and the card takes its place
    if (wait) await call('deleteMessage', { chat_id: msg.chat.id, message_id: wait.message_id }).catch(() => {});
    return sendCard(msg.chat.id, full.report, base, rid);
  }
  const text = `Could not finish the check on ${sym} right now. Try again in a minute, or open ${base}/t/${address}`;
  if (wait) return call('editMessageText', { chat_id: msg.chat.id, message_id: wait.message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => say(text));
  return say(text);
  });
}

export function startTelegram(base: string) {
  if (!config.telegramToken) return;
  let offset = 0;
  const loop = async () => {
    try {
      const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }) as { update_id: number; message?: any }[];
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message, base).catch(err => console.error('telegram message failed', err.message));
      }
      setTimeout(loop, 100);
    } catch (err) {
      console.error('telegram poll failed', (err as Error).message);
      setTimeout(loop, 10_000);
    }
  };
  loop();
  console.log('Telegram bot on');

  if (config.telegramChannel) {
    const channel = config.telegramChannel;
    // remembered per channel, so switching the feed to a new channel doesn't skip what the old one got
    const consider = async (r: Report) => {
      const token = r.token.address.toLowerCase();
      const key = `${channel.toLowerCase()}:${token}`;
      // Pons launches rarely reach Elysium-size numbers, so they get a lower bar
      const pons = r.chain !== 'elysium';
      const minHolders = pons ? PONS_MIN_HOLDERS : MIN_HOLDERS, minCap = pons ? PONS_MIN_CAP_USD : MIN_CAP_USD;
      if (posted.get(key) || pending.has(key) || (r.facts.holders ?? 0) < minHolders) return;
      // the feed is for launches worth a look: no high-risk scores, no critical flags, a real cap
      if (r.score.value >= MAX_SCORE || r.checks.some(c => c.critical) || r.degraded) return;
      // only fresh launches: Pons on Robinhood Chain, or an Elysium launch that trades
      // the feed is Robinhood Chain only: Pons launches. Elysium tokens can still be checked by CA
      const fresh = r.chain !== 'elysium' && launchFeed().some(l => l.token === token);
      if (!fresh) return;
      pending.add(key);
      try {
        const m = await marketOf(r);
        if ((m?.marketCapUsd ?? 0) < minCap) { console.log(`feed skip ${r.token.symbol}: cap ${Math.round(m?.marketCapUsd ?? 0)}`); return; } // may pass on a later check
        posted.set(key, Date.now());
        await sendCard(channel, r, base);
        console.log(`feed posted ${r.token.symbol}`);
      } catch (err) { console.error('telegram channel post failed', (err as Error).message); }
      finally { pending.delete(key); }
    };
    events.on('report', r => { consider(r); });
    // on start, catch up on the last day's launches that already pass, oldest first, a few seconds apart
    setTimeout(async () => {
      for (const l of [...launchFeed()].reverse()) {
        const c = cachedReport(l.token);
        if (!c) continue;
        await consider(c.report);
        await new Promise(r => setTimeout(r, 3000));
      }
    }, 60_000);
  }
}
