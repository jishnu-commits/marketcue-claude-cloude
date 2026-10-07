// fetch-nifty-options.mjs -- step 1 of the Algo backtests: download every expired NIFTY option
// Upstox still lists (a rolling ~2 years) plus NIFTY spot, as 1-minute candles, into algo/data/.
// Local only: nothing is written to Supabase, and algo/data/ is gitignored.
//
//   node algo/fetch-nifty-options.mjs            -> fetch everything missing (resumable)
//   node algo/fetch-nifty-options.mjs --probe    -> list expiries + count contracts, download nothing
//
// Monthly contracts (longer life, separate folder; weekly files untouched):
//   MONTHLY=1 LIFE_DAYS=40 BAND=0.07 OUT_NAME=nifty-monthly node algo/fetch-nifty-options.mjs
//
// SENSEX weekly options (BSE; Upstox key BSE_INDEX|SENSEX, output data/sensex/):
//   INDEX=SENSEX node algo/fetch-nifty-options.mjs [--probe]
// Contract keys (NSE_FO / BSE_FO) and strikes come straight from Upstox's contract list, so
// nothing else is index-specific.
//
// Retry contracts the manifest lists as failed, appending their candles to the expiry file:
//   [INDEX=SENSEX] node algo/fetch-nifty-options.mjs --retry-failed
//
// Token: put UPSTOX_TOKEN=... in algo/.env (gitignored) or export it.
//
// Layout written:
//   data/nifty/spot/YYYY-MM.csv.gz             ts,open,high,low,close
//   data/nifty/options/YYYY-MM-DD.csv.gz       ts,strike,type,open,high,low,close,volume  (one file per expiry)
//   data/nifty/manifest.json                   per-expiry contract counts, strike band, failures
//
// Strike band: strikes within +-BAND of NIFTY's low/high close over the contract's last LIFE_DAYS
// days -- wide enough for iron condor wings, small enough to stay within Upstox rate limits.
// A finished expiry file is never refetched; delete it to force a refetch.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const INDEXES = {
  NIFTY: { key: "NSE_INDEX|Nifty 50", out: "nifty" },
  SENSEX: { key: "BSE_INDEX|SENSEX", out: "sensex" },
};
const IDX = INDEXES[(process.env.INDEX || "NIFTY").toUpperCase()];
if (!IDX) { console.error(`Unknown INDEX=${process.env.INDEX}; use one of ${Object.keys(INDEXES).join(", ")}`); process.exit(1); }
const OUT = path.join(HERE, "data", process.env.OUT_NAME || IDX.out);
const BASE = "https://api.upstox.com";
const INDEX = IDX.key;
const BAND = Number(process.env.BAND || 0.06);           // +-6% around the spot range
const LIFE_DAYS = Number(process.env.LIFE_DAYS || 14);   // calendar days of candles up to expiry
const MONTHLY = process.env.MONTHLY === "1";             // only the last expiry of each month
const CHUNK_DAYS = 45;    // one candle request covers up to this many days (46 tested OK)
const GAP_MS = 950;       // ~63 req/min, under Upstox's 2000 per 30 min
const PROBE = process.argv.includes("--probe");
const RETRY = process.argv.includes("--retry-failed");

function loadToken() {
  if (process.env.UPSTOX_TOKEN) return process.env.UPSTOX_TOKEN.trim();
  const f = path.join(HERE, ".env");
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf8").match(/^UPSTOX_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  }
  console.error("No UPSTOX_TOKEN: add it to algo/.env");
  process.exit(1);
}
const TOKEN = loadToken();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(p, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (i + 1)); continue; }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} ${p} ${JSON.stringify(j).slice(0, 200)}`);
    return j.data;
  }
  throw new Error(`gave up ${p}`);
}

const enc = encodeURIComponent;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function writeGz(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, zlib.gzipSync(header + "\n" + rows.join("\n") + "\n"));
  fs.renameSync(tmp, file); // atomic: a half-written expiry never looks finished
}

// Spot: daily closes (for the strike band) and 1-minute candles month by month.
async function spot(fromDate) {
  const daily = await get(`/v3/historical-candle/${enc(INDEX)}/days/1/${ymd(new Date())}/${fromDate}`);
  const closes = new Map(daily.candles.map((c) => [c[0].slice(0, 10), c[4]]));
  if (PROBE) return closes;
  for (let m = new Date(fromDate.slice(0, 7) + "-01T00:00:00Z"); m <= new Date(); m.setUTCMonth(m.getUTCMonth() + 1)) {
    const mon = ymd(m).slice(0, 7);
    const file = path.join(OUT, "spot", `${mon}.csv.gz`);
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
    const current = end >= new Date();
    if (fs.existsSync(file) && !current) continue;
    const d = await get(`/v3/historical-candle/${enc(INDEX)}/minutes/1/${ymd(current ? new Date() : end)}/${mon}-01`);
    const rows = d.candles.slice().reverse().map((c) => [c[0], c[1], c[2], c[3], c[4]].join(","));
    writeGz(file, "ts,open,high,low,close", rows);
    console.log(`spot ${mon}: ${rows.length} candles`);
  }
  return closes;
}

// Refetch contracts listed under manifest[exp].failed and append their candles to the expiry file.
async function retryFailed() {
  const mfFile = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(mfFile) ? JSON.parse(fs.readFileSync(mfFile, "utf8")) : {};
  for (const [exp, m] of Object.entries(manifest).sort()) {
    if (!m.failed?.length) continue;
    const file = path.join(OUT, "options", `${exp}.csv.gz`);
    const want = new Set(m.failed.map((f) => f.split(":")[0]));
    const contracts = (await get(`/v2/expired-instruments/option/contract?instrument_key=${enc(INDEX)}&expiry_date=${exp}`))
      .filter((c) => want.has(c.trading_symbol));
    const windows = [];
    for (let to = exp; to >= m.from; to = addDays(to, -CHUNK_DAYS)) {
      const f = addDays(to, -CHUNK_DAYS + 1);
      windows.push([to, f < m.from ? m.from : f]);
    }
    const rows = [], failed = [];
    for (const c of contracts) {
      try {
        const got = [];
        for (const [to, f] of windows.slice().reverse()) {
          const d = await get(`/v2/expired-instruments/historical-candle/${enc(c.instrument_key)}/1minute/${to}/${f}`);
          for (const k of d.candles.slice().reverse())
            got.push([k[0], c.strike_price, c.instrument_type, k[1], k[2], k[3], k[4], k[5]].join(","));
        }
        rows.push(...got);
      } catch (e) { failed.push(`${c.trading_symbol}: ${String(e).slice(0, 120)}`); }
    }
    for (const s of want) if (!contracts.some((c) => c.trading_symbol === s)) failed.push(`${s}: not in contract list`);
    const old = zlib.gunzipSync(fs.readFileSync(file)).toString().trimEnd().split("\n");
    writeGz(file, old[0], [...old.slice(1), ...rows]);
    manifest[exp] = { ...m, rows: m.rows + rows.length, failed };
    fs.writeFileSync(mfFile, JSON.stringify(manifest, null, 1));
    console.log(`retry ${exp}: ${want.size - failed.length}/${want.size} recovered, +${rows.length} candles`);
  }
}

async function main() {
  if (RETRY) return retryFailed();
  let expiries = (await get(`/v2/expired-instruments/expiries?instrument_key=${enc(INDEX)}`)).sort();
  if (MONTHLY) expiries = expiries.filter((e, i) => expiries[i + 1]?.slice(0, 7) !== e.slice(0, 7));
  console.log(`${expiries.length} expiries: ${expiries[0]} -> ${expiries.at(-1)}`);
  const closes = await spot(addDays(expiries[0], -LIFE_DAYS - 5));

  const mfFile = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(mfFile) ? JSON.parse(fs.readFileSync(mfFile, "utf8")) : {};
  let total = 0;

  for (const [i, exp] of expiries.entries()) {
    const file = path.join(OUT, "options", `${exp}.csv.gz`);
    if (!PROBE && fs.existsSync(file)) continue;
    const from = addDays(exp, -LIFE_DAYS);
    const life = [...closes].filter(([d]) => d >= from && d <= exp).map(([, c]) => c);
    if (!life.length) { console.log(`${exp}: no spot closes, skipped`); continue; }
    const lo = Math.min(...life) * (1 - BAND), hi = Math.max(...life) * (1 + BAND);

    const contracts = (await get(`/v2/expired-instruments/option/contract?instrument_key=${enc(INDEX)}&expiry_date=${exp}`))
      .filter((c) => c.strike_price >= lo && c.strike_price <= hi);
    const windows = [];
    for (let to = exp; to >= from; to = addDays(to, -CHUNK_DAYS)) {
      const f = addDays(to, -CHUNK_DAYS + 1);
      windows.push([to, f < from ? from : f]);
    }
    total += contracts.length * windows.length;
    if (PROBE) { console.log(`${exp}: ${contracts.length} contracts in ${Math.round(lo)}-${Math.round(hi)}`); continue; }

    const rows = [], failed = [];
    for (const c of contracts) {
      try {
        for (const [to, f] of windows.slice().reverse()) {
          const d = await get(`/v2/expired-instruments/historical-candle/${enc(c.instrument_key)}/1minute/${to}/${f}`);
          for (const k of d.candles.slice().reverse())
            rows.push([k[0], c.strike_price, c.instrument_type, k[1], k[2], k[3], k[4], k[5]].join(","));
        }
      } catch (e) { failed.push(`${c.trading_symbol}: ${String(e).slice(0, 120)}`); }
    }
    writeGz(file, "ts,strike,type,open,high,low,close,volume", rows);
    manifest[exp] = { contracts: contracts.length, rows: rows.length, band: [Math.round(lo), Math.round(hi)],
      lot: contracts[0]?.lot_size, from, failed };
    fs.writeFileSync(mfFile, JSON.stringify(manifest, null, 1));
    console.log(`[${i + 1}/${expiries.length}] ${exp}: ${contracts.length} contracts, ${rows.length} candles${failed.length ? `, ${failed.length} FAILED` : ""}`);
  }
  if (PROBE) console.log(`total ${total} requests ~ ${Math.round((total * GAP_MS) / 3.6e6 * 10) / 10} h at current pacing`);
}

main().catch((e) => { console.error(e); process.exit(1); });
