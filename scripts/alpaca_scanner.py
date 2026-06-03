"""
Alpaca Signal Engine v1 — Phase 4B

Pulls recent bars for a watchlist from Alpaca's market data API, runs a small
demo-real signal model (RSI + VWAP/EMA trend + volume spike), scores
confidence, and posts qualifying signals to the secured Supabase
ingest-signal webhook.

Does NOT place orders. Paper-only base URL by default.

Env:
  ALPACA_API_KEY_ID
  ALPACA_API_SECRET_KEY
  ALPACA_BASE_URL          (default: https://paper-api.alpaca.markets)
  ALPACA_DATA_URL          (default: https://data.alpaca.markets)
  SIGNAL_INGEST_SECRET
  INGEST_URL               (default: https://rnufgxecvqvolnprtaha.supabase.co/functions/v1/ingest-signal)
  SCAN_TICKERS             (default: SPY,QQQ,NVDA,TSLA,AMD,AAPL,META,MSFT)
  MIN_CONFIDENCE           (default: 65)
  DRY_RUN                  (default: 0 — set to 1 to log without posting)
  SCAN_INTERVAL_SECONDS    (default: 0 — single pass; >0 loops)

Run:
  python scripts/alpaca_scanner.py
  DRY_RUN=1 python scripts/alpaca_scanner.py
  SCAN_INTERVAL_SECONDS=60 python scripts/alpaca_scanner.py
"""

from __future__ import annotations

import logging
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests

# ---------- config ----------

ALPACA_KEY = os.environ.get("ALPACA_API_KEY_ID", "")
ALPACA_SECRET = os.environ.get("ALPACA_API_SECRET_KEY", "")
ALPACA_BASE = os.environ.get("ALPACA_BASE_URL", "https://paper-api.alpaca.markets").rstrip("/")
ALPACA_DATA = os.environ.get("ALPACA_DATA_URL", "https://data.alpaca.markets").rstrip("/")

INGEST_URL = os.environ.get(
    "INGEST_URL",
    "https://rnufgxecvqvolnprtaha.supabase.co/functions/v1/ingest-signal",
)
INGEST_SECRET = os.environ.get("SIGNAL_INGEST_SECRET", "")

TICKERS = [t.strip().upper() for t in os.environ.get(
    "SCAN_TICKERS", "SPY,QQQ,NVDA,TSLA,AMD,AAPL,META,MSFT"
).split(",") if t.strip()]

MIN_CONFIDENCE = int(os.environ.get("MIN_CONFIDENCE", "65"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL_SECONDS", "0"))
SOURCE = "Alpaca Signal Engine v1"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("alpaca-scanner")

# ---------- alpaca data ----------

def _alpaca_headers() -> dict[str, str]:
    return {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
    }


def fetch_bars(symbol: str, minutes: int = 120) -> list[dict[str, Any]]:
    """Fetch recent 1-minute bars. IEX feed (free tier). Returns oldest→newest."""
    end = datetime.now(timezone.utc) - timedelta(minutes=16)  # IEX 15-min delay
    start = end - timedelta(minutes=minutes + 60)
    url = f"{ALPACA_DATA}/v2/stocks/{symbol}/bars"
    params = {
        "timeframe": "1Min",
        "start": start.isoformat().replace("+00:00", "Z"),
        "end": end.isoformat().replace("+00:00", "Z"),
        "limit": 1000,
        "feed": "iex",
        "adjustment": "raw",
    }
    r = requests.get(url, headers=_alpaca_headers(), params=params, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"bars HTTP {r.status_code}: {r.text[:200]}")
    return r.json().get("bars") or []


def fetch_latest_quote(symbol: str) -> Optional[float]:
    url = f"{ALPACA_DATA}/v2/stocks/{symbol}/trades/latest"
    r = requests.get(url, headers=_alpaca_headers(), params={"feed": "iex"}, timeout=10)
    if r.status_code != 200:
        return None
    t = r.json().get("trade") or {}
    p = t.get("p")
    return float(p) if p is not None else None


# ---------- indicators ----------

def rsi(closes: list[float], period: int = 14) -> Optional[float]:
    if len(closes) < period + 1:
        return None
    gains, losses = 0.0, 0.0
    for i in range(-period, 0):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gains += diff
        else:
            losses -= diff
    if losses == 0:
        return 100.0
    rs = (gains / period) / (losses / period)
    return 100 - (100 / (1 + rs))


def ema(values: list[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    k = 2 / (period + 1)
    e = sum(values[:period]) / period
    for v in values[period:]:
        e = v * k + e * (1 - k)
    return e


def vwap(bars: list[dict[str, Any]]) -> Optional[float]:
    if not bars:
        return None
    pv, vol = 0.0, 0.0
    for b in bars:
        typical = (b["h"] + b["l"] + b["c"]) / 3
        pv += typical * b["v"]
        vol += b["v"]
    return pv / vol if vol else None


# ---------- signal model ----------

@dataclass
class SignalCandidate:
    ticker: str
    direction: str            # "BULLISH" | "BEARISH"
    confidence: int
    price: float
    reasons: list[str]
    rsi_val: float
    above_vwap: bool
    vol_ratio: float


def evaluate(symbol: str, bars: list[dict[str, Any]]) -> Optional[SignalCandidate]:
    if len(bars) < 30:
        return None

    closes = [b["c"] for b in bars]
    vols = [b["v"] for b in bars]
    price = closes[-1]

    rsi_val = rsi(closes, 14)
    ema9 = ema(closes, 9)
    ema21 = ema(closes, 21)
    v = vwap(bars[-60:] if len(bars) >= 60 else bars)
    if rsi_val is None or ema9 is None or ema21 is None or v is None:
        return None

    avg_vol = sum(vols[-30:-1]) / max(len(vols[-30:-1]), 1)
    last_vol = vols[-1]
    vol_ratio = (last_vol / avg_vol) if avg_vol > 0 else 1.0
    above_vwap = price > v

    bull_score = 0
    bear_score = 0
    reasons: list[str] = []

    # Trend
    if ema9 > ema21:
        bull_score += 20
        reasons.append("EMA9 > EMA21 (uptrend)")
    elif ema9 < ema21:
        bear_score += 20
        reasons.append("EMA9 < EMA21 (downtrend)")

    # VWAP
    if above_vwap:
        bull_score += 15
        reasons.append("Price above VWAP")
    else:
        bear_score += 15
        reasons.append("Price below VWAP")

    # RSI
    if rsi_val >= 60:
        bull_score += 20
        reasons.append(f"RSI strong ({rsi_val:.0f})")
    elif rsi_val <= 40:
        bear_score += 20
        reasons.append(f"RSI weak ({rsi_val:.0f})")
    elif 50 <= rsi_val < 60:
        bull_score += 8
    elif 40 < rsi_val < 50:
        bear_score += 8

    # Volume spike
    if vol_ratio >= 2.0:
        boost = 25 if vol_ratio >= 3 else 15
        reasons.append(f"Volume spike {vol_ratio:.1f}x avg")
        if above_vwap and ema9 > ema21:
            bull_score += boost
        elif (not above_vwap) and ema9 < ema21:
            bear_score += boost
        else:
            bull_score += boost // 2
            bear_score += boost // 2

    if bull_score >= bear_score:
        direction = "BULLISH"
        confidence = min(99, bull_score)
    else:
        direction = "BEARISH"
        confidence = min(99, bear_score)

    return SignalCandidate(
        ticker=symbol,
        direction=direction,
        confidence=confidence,
        price=round(price, 2),
        reasons=reasons,
        rsi_val=round(rsi_val, 1),
        above_vwap=above_vwap,
        vol_ratio=round(vol_ratio, 2),
    )


# ---------- ingest ----------

def build_payload(c: SignalCandidate) -> dict[str, Any]:
    risk = "LOW" if c.confidence >= 85 else "MEDIUM" if c.confidence >= 70 else "HIGH"
    return {
        "signal_id": str(uuid.uuid4()),
        "source": SOURCE,
        "ticker": c.ticker,
        "direction": c.direction,
        "confidence": int(c.confidence),
        "risk_level": risk,
        "price": c.price,
        "reasons": c.reasons,
        "flow_metrics": {
            "volume_ratio": c.vol_ratio,
        },
        "technical_metrics": {
            "rsi": c.rsi_val,
            "above_vwap": c.above_vwap,
        },
        "catalyst_summary": f"Alpaca scanner: {c.direction.lower()} setup on {c.ticker}",
        "macro_score": None,
    }


def post_signal(payload: dict[str, Any]) -> tuple[int, str]:
    headers = {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET,
    }
    r = requests.post(INGEST_URL, json=payload, headers=headers, timeout=15)
    return r.status_code, r.text[:300]


# ---------- main loop ----------

def preflight() -> bool:
    missing = []
    if not ALPACA_KEY: missing.append("ALPACA_API_KEY_ID")
    if not ALPACA_SECRET: missing.append("ALPACA_API_SECRET_KEY")
    if not INGEST_SECRET and not DRY_RUN: missing.append("SIGNAL_INGEST_SECRET")
    if missing:
        log.error("Missing env: %s", ", ".join(missing))
        return False
    log.info("Mode: %s | Tickers: %s | min_conf=%d | base=%s",
             "DRY-RUN" if DRY_RUN else "LIVE-POST", ",".join(TICKERS), MIN_CONFIDENCE, ALPACA_BASE)
    return True


def scan_once() -> None:
    generated = posted = skipped = errored = 0
    for sym in TICKERS:
        try:
            bars = fetch_bars(sym, minutes=120)
            if not bars:
                log.info("[%s] no bars (market closed or no IEX data)", sym)
                skipped += 1
                continue
            cand = evaluate(sym, bars)
            if cand is None:
                log.info("[%s] insufficient data", sym)
                skipped += 1
                continue
            generated += 1
            if cand.confidence < MIN_CONFIDENCE:
                log.info("[%s] %s conf=%d < %d — skipped (%s)",
                         sym, cand.direction, cand.confidence, MIN_CONFIDENCE,
                         "; ".join(cand.reasons))
                skipped += 1
                continue

            payload = build_payload(cand)
            if DRY_RUN:
                log.info("[%s] DRY-RUN %s conf=%d price=%.2f reasons=%s signal_id=%s",
                         sym, cand.direction, cand.confidence, cand.price,
                         cand.reasons, payload["signal_id"])
                continue

            status, body = post_signal(payload)
            if 200 <= status < 300:
                posted += 1
                log.info("[%s] POSTED %s conf=%d → HTTP %d %s",
                         sym, cand.direction, cand.confidence, status, body)
            else:
                errored += 1
                log.error("[%s] post failed HTTP %d %s", sym, status, body)
        except Exception as e:  # noqa: BLE001
            errored += 1
            log.error("[%s] error: %s", sym, e)

    log.info("Scan complete: generated=%d posted=%d skipped=%d errored=%d",
             generated, posted, skipped, errored)


def main() -> int:
    if not preflight():
        return 1
    if SCAN_INTERVAL <= 0:
        scan_once()
        return 0
    log.info("Looping every %ds. Ctrl+C to stop.", SCAN_INTERVAL)
    while True:
        try:
            scan_once()
        except KeyboardInterrupt:
            log.info("Stopped by user.")
            return 0
        except Exception as e:  # noqa: BLE001
            log.error("Loop error: %s", e)
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
