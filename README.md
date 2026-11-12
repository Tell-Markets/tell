<div align="center">

<img src=".github/banner.png" alt="Tell" width="100%">

# Tell

**Read the tell before you buy.**

Risk checks for token launches on Robinhood Chain.<br>
Contract, holders, deployer, website and market — one score, every reason shown.

[Website](https://tell.markets) · [API docs](https://tell.markets/docs) · [Proof ledger](https://tell.markets/proof) · [Accuracy](https://tell.markets/accuracy) · [Roadmap](https://tell.markets/roadmap) · [X](https://x.com/tell_markets) · [Telegram](https://t.me/tell_marketsrh)

</div>

---

## What it does

Paste a token address. In about ten seconds Tell reads the chain and the project's own site, and returns a **0–100 risk score** with every finding behind it. No black box: each point of risk comes from a check you can read.

| | |
|---|---|
| **Contract** | Owner powers: mint, pause, blacklist, changeable taxes, proxies, trade caps |
| **Holders** | Top wallets, linked-wallet clusters funded from one source, snipers from the first blocks |
| **Deployer** | What the creator holds, what they sold, their past launches and how those ended |
| **Website** | Is there a real product, does the site name this contract, or is it a TikTok, a Telegram link, an image |
| **Promises** | What the site claims against what the chain shows: burns that never happened, "audits", staking with no contract |
| **Market** | Liquidity, pool age, sell pressure, on the DEX or on the Pons bonding curve |

An AI pass reads the site with all the on-chain findings in front of it and writes a plain-language verdict. Site text is treated as untrusted input.

### Strict by default

Tell's own outcome data says **92% of Pons launches that got buyers were rugged within three days**. So:

- nothing younger than three days scores below **60 (caution)** — it has to survive first;
- a deployer who dumped their bag, a site promoting a different token, or a placeholder link with almost no holders is **80+ (high risk)** on its own;
- a token almost nobody holds is never "low risk".

A score is not an endorsement. [How the scores hold up →](https://tell.markets/accuracy)

## For agents

Tell is built to be called by trading bots before they buy.

**MCP** (Streamable HTTP) — add to any MCP client:

```json
{ "mcpServers": { "tell": { "type": "http", "url": "https://tell.markets/mcp" } } }
```

Tools: `check_token` · `compare_tokens` · `recent_launches` · `verdict_proof` · `pricing`

**HTTP**

```bash
curl "https://tell.markets/api/v1/check?token=0x…&mode=quick"
```

| Endpoint | |
|---|---|
| `GET /api/v1/check?token=0x…&mode=quick\|full` | risk check of one token |
| `GET /api/v1/compare?a=0x…&b=0x…` | two tokens side by side |
| `GET /api/v1/launches` | Pons launches of the last 24h with scores |
| `GET /api/v1/proof/0x…` | recorded verdicts for a token, with Merkle proofs |
| `GET /api/v1/accuracy` | how tokens fared days later, by the score Tell gave them |

**Payments: x402.** Quick checks are free. Full checks are a few free a day, then **0.03 USDG** each over [x402](https://www.x402.org/) on Robinhood Chain: the API answers `402` with what to pay, the agent signs an EIP-3009 transfer, Tell runs the check and settles. No account, no key, no gas for the agent.

## Proof ledger

Every verdict is hashed (`keccak256(token, score, verdict, checks, time)`), and every hour the batch becomes one Merkle root written on-chain from Tell's wallet. Any verdict can be proven against its root; none can be edited after the fact. [See the ledger →](https://tell.markets/proof)

## Telegram

- **[@tellmarkets_bot](https://t.me/tellmarkets_bot)** — add it to a group; anyone drops a CA, it replies with the score, the top red flags, market numbers and the token's own links.
- **[@tell_launches_rh](https://t.me/tell_launches_rh)** — Pons launches that pass a bar, posted with the numbers.

## Run it

```bash
git clone https://github.com/Tell-Markets/tell && cd tell
npm install
cp .env.example .env      # an RPC URL is enough to start
npm run check -- 0x…      # one check in the terminal
npm start                 # API + MCP on :3000
```

Or with Docker: `docker build -t tell . && docker run -p 3000:3000 --env-file .env -v tell-data:/app/data tell`

This repository is the engine: checks, scoring, API, MCP, x402, the proof ledger and the bots. The tell.markets website is not included.

## Layout

```
src/
  analyze.ts        one full check: reads, runs every check, scores
  checks/           contract · holders · deployer · website · promises · market · strict
  scoring.ts        risk points, critical flags and floors → 0–100
  ai/review.ts      the site read and the verdict
  sources/          RPC (Robinhood Chain, Elysium), DexScreener, Pons launch data, site fetcher
  launches.ts       Pons launch watcher
  accuracy.ts       outcome tracking: did the token survive, was it rugged
  proof.ts          hourly Merkle roots on-chain
  x402.ts           pay-per-check for agents
  api.ts · mcp.ts   HTTP and MCP surfaces
  bots/             Telegram
```

---

<div align="center">

**$TELL** · `0xc13630c6b85fd1767b484acf38b50314e08a59fc` · [Robinhood Chain](https://robin.etherscan.io/token/0xc13630c6b85fd1767b484acf38b50314e08a59fc)

Tell describes what it finds. It can be wrong, and it is not financial advice.

</div>
