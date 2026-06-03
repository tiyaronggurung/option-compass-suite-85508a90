"""
OptionFlow AI Pro — Python signal ingestion example.

Usage:
    export SIGNAL_INGEST_SECRET="<the same value you saved in Lovable Cloud secrets>"
    python scripts/python_bot_example.py

Sends one test signal per ticker (SPY, QQQ, NVDA, TSLA) to the secured webhook.
The `signal_id` UUID makes inserts idempotent — replaying the same payload returns
{"ok": true, "deduped": true} instead of creating a duplicate row.
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import date, timedelta

import requests  # pip install requests

INGEST_URL = "https://rnufgxecvqvolnprtaha.supabase.co/functions/v1/ingest-signal"
SOURCE = "OptionFlow Engine v1"


def build_signal(ticker: str, price: float, strike: float) -> dict:
    expiry = (date.today() + timedelta(days=18)).isoformat()
    return {
        "signal_id": str(uuid.uuid4()),  # dedup key
        "source": SOURCE,
        "ticker": ticker,
        "direction": "CALL",
        "confidence": 87,
        "risk_level": "MEDIUM",
        "price": price,
        "contract_symbol": f"{ticker}250621C{int(strike * 1000):08d}",
        "dte": 18,
        "expiry": expiry,
        "strike": strike,
        "premium": 4.25,
        "reasons": [
            "Call sweep detected",
            "Volume above open interest",
            "Price reclaimed VWAP",
            "IV rising",
        ],
        "flow_metrics": {
            "call_premium": 2_100_000,
            "put_premium": 540_000,
            "volume_oi_ratio": 3.8,
        },
        "technical_metrics": {"rsi": 61, "macd": "bullish", "above_vwap": True},
        "catalyst_summary": f"{ticker} momentum and strong options activity",
        "macro_score": 0.72,
    }


def post_signal(payload: dict, secret: str) -> None:
    r = requests.post(
        INGEST_URL,
        json=payload,
        headers={
            "Content-Type": "application/json",
            "x-ingest-secret": secret,
        },
        timeout=15,
    )
    print(f"{payload['ticker']:5} -> {r.status_code} {r.text[:200]}")
    r.raise_for_status()


def main() -> int:
    secret = os.environ.get("SIGNAL_INGEST_SECRET")
    if not secret:
        print("ERROR: SIGNAL_INGEST_SECRET env var not set.", file=sys.stderr)
        return 1

    samples = [
        ("SPY", 548.10, 550),
        ("QQQ", 478.25, 480),
        ("NVDA", 128.45, 130),
        ("TSLA", 242.10, 245),
    ]
    for ticker, price, strike in samples:
        post_signal(build_signal(ticker, price, strike), secret)
    return 0


if __name__ == "__main__":
    sys.exit(main())
