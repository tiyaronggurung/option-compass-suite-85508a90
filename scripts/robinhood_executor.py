"""
Option Compass Suite — Robinhood Executor
==========================================
Polls your Supabase for approved signals from auto-entry-engine
and executes real option orders on Robinhood with approval confirmation.

Settings:
  - Execution Mode : APPROVAL (confirms each trade before placing)
  - Trading Mode   : LIVE (real Robinhood account)
  - Min Confidence : 65%

NEVER modifies your existing Supabase functions or signal logic.
Reads signals only. Writes execution results to robinhood_executions table.

Env vars required:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  ROBINHOOD_EMAIL
  ROBINHOOD_PASSWORD

Run:
  POLL_INTERVAL_SECONDS=60 python scripts/robinhood_executor.py
"""
from __future__ import annotations

import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import robin_stocks.robinhood as rh
except ImportError:
    print("ERROR: robin_stocks not installed. Run: pip install robin_stocks")
    sys.exit(1)

try:
    from supabase import create_client, Client
except ImportError:
    print("ERROR: supabase not installed. Run: pip install supabase")
    sys.exit(1)

SUPABASE_URL       = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY       = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ROBINHOOD_EMAIL    = os.environ.get("ROBINHOOD_EMAIL", "")
ROBINHOOD_PASSWORD = os.environ.get("ROBINHOOD_PASSWORD", "")
MIN_CONFIDENCE     = int(os.environ.get("MIN_CONFIDENCE", "65"))
POLL_INTERVAL      = int(os.environ.get("POLL_INTERVAL_SECONDS", "0"))
DRY_RUN            = os.environ.get("DRY_RUN", "0") == "1"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("robinhood-executor")


def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def login_robinhood() -> bool:
    log.info("Logging into Robinhood as %s ...", ROBINHOOD_EMAIL)
    try:
        rh.login(
            username=ROBINHOOD_EMAIL,
            password=ROBINHOOD_PASSWORD,
            expiresIn=86400,
            store_session=True,
        )
        log.info("Robinhood login successful.")
        return True
    except Exception as e:
        log.error("Robinhood login failed: %s", e)
        return False


def fetch_pending_signals(sb: Client) -> list[dict[str, Any]]:
    try:
        executed = sb.table("robinhood_executions").select("signal_id").execute()
        executed_ids = {r["signal_id"] for r in (executed.data or [])}

        fired = (
            sb.table("auto_entry_log")
            .select("signal_id, ticker, paper_trade_id, created_at")
            .eq("status", "fired")
            .order("created_at", desc=False)
            .execute()
        )
        fired_rows = fired.data or []
        if not fired_rows:
            return []

        pending_signal_ids = [
            r["signal_id"]
            for r in fired_rows
            if r["signal_id"] not in executed_ids and r["signal_id"]
        ]
        if not pending_signal_ids:
            return []

        signals_resp = (
            sb.table("signals")
            .select("*")
            .in_("id", pending_signal_ids)
            .gte("confidence", MIN_CONFIDENCE)
            .execute()
        )
        signals = signals_resp.data or []

        valid = []
        for s in signals:
            if all([
                s.get("strike"),
                s.get("expiry"),
                s.get("premium") or s.get("entry_premium"),
                s.get("direction"),
                s.get("ticker"),
            ]):
                valid.append(s)
            else:
                log.info(
                    "[%s] Signal %s skipped — missing option fields",
                    s.get("ticker"), s.get("id")
                )
        return valid
    except Exception as e:
        log.error("Error fetching signals: %s", e)
        return []


def confirm_trade(signal: dict[str, Any]) -> bool:
    ticker     = signal.get("ticker", "?")
    direction  = signal.get("direction", "?").upper()
    strike     = signal.get("strike")
    expiry     = signal.get("expiry")
    premium    = signal.get("premium") or signal.get("entry_premium")
    confidence = signal.get("confidence")
    reasons    = signal.get("reasons") or []
    risk       = signal.get("risk_level", "?")
    opt_type   = "PUT" if "PUT" in direction else "CALL"

    print("\n" + "=" * 55)
    print(f"  NEW SIGNAL — APPROVAL REQUIRED")
    print("=" * 55)
    print(f"  Ticker     : {ticker}")
    print(f"  Direction  : {opt_type}")
    print(f"  Strike     : ${strike}")
    print(f"  Expiry     : {expiry}")
    print(f"  Premium    : ${premium}")
    print(f"  Confidence : {confidence}%")
    print(f"  Risk Level : {risk}")
    if reasons:
        print(f"  Reasons    :")
        for r in reasons:
            print(f"             - {r}")
    print("=" * 55)

    while True:
        answer = input("  Execute this trade? [Y/N]: ").strip().upper()
        if answer == "Y":
            return True
        elif answer == "N":
            log.info("[%s] Trade declined by user.", ticker)
            return False
        else:
            print("  Please enter Y or N.")


def get_option_market_data(ticker: str, expiry: str, strike: float, opt_type: str) -> Optional[dict]:
    try:
        chain = rh.options.get_option_market_data(
            inputSymbols=ticker,
            expirationDate=expiry,
            strikePrice=str(strike),
            optionType=opt_type.lower(),
        )
        if chain and len(chain) > 0 and len(chain[0]) > 0:
            return chain[0][0]
    except Exception as e:
        log.error("[%s] Failed to fetch option market data: %s", ticker, e)
    return None


def execute_option_order(signal: dict[str, Any]) -> Optional[dict]:
    ticker    = signal.get("ticker", "")
    direction = signal.get("direction", "").upper()
    strike    = float(signal.get("strike", 0))
    expiry    = str(signal.get("expiry", ""))
    premium   = float(signal.get("premium") or signal.get("entry_premium") or 0)
    opt_type  = "put" if "PUT" in direction else "call"

    if DRY_RUN:
        log.info("[%s] DRY_RUN — would buy 1x %s %s $%s @ ~$%.2f",
                 ticker, opt_type.upper(), expiry, strike, premium)
        return {
            "dry_run": True,
            "ticker": ticker,
            "strike": strike,
            "expiry": expiry,
            "opt_type": opt_type,
            "limit_price": premium,
        }

    market = get_option_market_data(ticker, expiry, strike, opt_type)
    ask = None
    if market:
        try:
            ask = float(market.get("ask_price") or 0)
        except Exception:
            ask = None

    limit_price = round(ask if ask and ask > 0 else premium, 2)

    log.info("[%s] Placing BUY 1x %s %s $%s @ limit $%.2f",
             ticker, opt_type.upper(), expiry, strike, limit_price)

    try:
        result = rh.orders.order_buy_option_limit(
            positionEffect="open",
            creditOrDebit="debit",
            price=limit_price,
            symbol=ticker,
            quantity=1,
            expirationDate=expiry,
            strike=strike,
            optionType=opt_type,
            timeInForce="gfd",
        )
        log.info("[%s] Order submitted: %s", ticker, result.get("id") if isinstance(result, dict) else result)
        return result
    except Exception as e:
        log.error("[%s] Order placement failed: %s", ticker, e)
        return {"error": str(e)}


def record_execution(sb: Client, signal: dict[str, Any], result: Optional[dict], approved: bool) -> None:
    try:
        row = {
            "id": str(uuid.uuid4()),
            "signal_id": signal.get("id"),
            "ticker": signal.get("ticker"),
            "direction": signal.get("direction"),
            "strike": signal.get("strike"),
            "expiry": signal.get("expiry"),
            "premium": signal.get("premium") or signal.get("entry_premium"),
            "confidence": signal.get("confidence"),
            "approved": approved,
            "executed_at": datetime.now(timezone.utc).isoformat(),
            "broker_response": result,
            "dry_run": DRY_RUN,
        }
        sb.table("robinhood_executions").insert(row).execute()
    except Exception as e:
        log.error("Failed to record execution for signal %s: %s", signal.get("id"), e)


def scan_once(sb: Client) -> None:
    signals = fetch_pending_signals(sb)
    if not signals:
        log.info("No pending signals meeting criteria.")
        return
    log.info("Found %d pending signal(s).", len(signals))
    for sig in signals:
        approved = confirm_trade(sig)
        if not approved:
            record_execution(sb, sig, {"declined": True}, approved=False)
            continue
        result = execute_option_order(sig)
        record_execution(sb, sig, result, approved=True)


def main() -> int:
    missing = [k for k, v in {
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_KEY,
        "ROBINHOOD_EMAIL": ROBINHOOD_EMAIL,
        "ROBINHOOD_PASSWORD": ROBINHOOD_PASSWORD,
    }.items() if not v]
    if missing:
        log.error("Missing required env vars: %s", ", ".join(missing))
        return 1

    if not DRY_RUN and not login_robinhood():
        return 1

    sb = get_supabase()

    if POLL_INTERVAL <= 0:
        scan_once(sb)
        return 0

    log.info("Starting poll loop every %ds. Press Ctrl+C to stop.", POLL_INTERVAL)
    while True:
        try:
            scan_once(sb)
        except KeyboardInterrupt:
            log.info("Stopped by user.")
            return 0
        except Exception as e:
            log.error("Unexpected error in scan loop: %s", e)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
