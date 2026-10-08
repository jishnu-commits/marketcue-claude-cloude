# SENSEX option data (Upstox, 1-min, ~2 years)

Data-only branch. SENSEX weekly options (BSE), 1-minute candles from Upstox's expired-instruments API,
fetched with `algo/fetch-nifty-options.mjs` (INDEX=SENSEX, BAND=0.06, LIFE_DAYS=14).

- Expiries: 104 of 104 listed, 2024-10-04 -> 2026-10-01 (one file each in `sensex/options/`)
- Contracts: 24,776; option candles: 48,866,535
- Failed contracts: 0; empty expiries: 0
- Spot: 26 monthly files of 1-min SENSEX candles, 2024-09 -> 2026-10 (`sensex/spot/`)
- Lot size: 10 (earlier expiries), 20 (later)
- Size: 418 MB

Get it locally:

    git clone --branch sensex-data --depth 1 https://github.com/jishnu-commits/marketcue-claude-cloude sensex-tmp
    cp -r sensex-tmp/sensex /path/to/marketcue/algo/data/
