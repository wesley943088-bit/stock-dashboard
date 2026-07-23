from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_SYMBOLS = ["MU"]
YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval=1d"


def normalize_symbols(symbols: list[Any]) -> list[str]:
    normalized = []
    seen = set()
    for symbol in symbols:
        value = str(symbol).strip().upper()
        if value and value not in seen:
            normalized.append(value)
            seen.add(value)
    return normalized


def load_watchlist(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"symbols": DEFAULT_SYMBOLS, "privateCompanies": []}

    payload = json.loads(path.read_text(encoding="utf-8"))
    normalized = normalize_symbols(payload.get("symbols", []))
    if not normalized:
        raise ValueError(f"No symbols configured in {path}")
    return {
        "symbols": normalized,
        "privateCompanies": payload.get("privateCompanies", []),
    }


def fetch_yahoo_chart(symbol: str, range_value: str) -> dict[str, Any]:
    url = YAHOO_CHART_URL.format(symbol=symbol, range=range_value)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 stock-dashboard/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    error = payload.get("chart", {}).get("error")
    if error:
        raise RuntimeError(f"Yahoo chart error for {symbol}: {error}")
    return payload["chart"]["result"][0]


def chart_to_frame(result: dict[str, Any]) -> pd.DataFrame:
    quote = result["indicators"]["quote"][0]
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(result["timestamp"], unit="s", utc=True)
            .tz_convert("US/Eastern")
            .date,
            "open": quote["open"],
            "high": quote["high"],
            "low": quote["low"],
            "close": quote["close"],
            "volume": quote["volume"],
        }
    ).dropna()
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    low_n = df["low"].rolling(9).min()
    high_n = df["high"].rolling(9).max()
    rsv = (df["close"] - low_n) / (high_n - low_n) * 100

    df["k"] = rsv.rolling(3).mean()
    df["d"] = df["k"].rolling(3).mean()
    df["k_change"] = df["k"].diff()
    df["d_change"] = df["d"].diff()
    df["volume_ma5"] = df["volume"].rolling(5).mean()
    df["volume_change_pct"] = (df["volume"] - df["volume_ma5"]) / df["volume_ma5"] * 100
    return df


def finite_or_none(value: Any) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if pd.isna(value):
        return None
    if isinstance(value, float):
        return round(value, 4)
    return int(value) if isinstance(value, int) else value


def serialize_rows(df: pd.DataFrame, limit: int) -> list[dict[str, Any]]:
    rows = []
    for row in df.tail(limit).to_dict(orient="records"):
        rows.append(
            {
                "date": row["date"].strftime("%Y-%m-%d"),
                "open": finite_or_none(row["open"]),
                "high": finite_or_none(row["high"]),
                "low": finite_or_none(row["low"]),
                "close": finite_or_none(row["close"]),
                "volume": finite_or_none(row["volume"]),
                "k": finite_or_none(row["k"]),
                "d": finite_or_none(row["d"]),
                "kChange": finite_or_none(row["k_change"]),
                "dChange": finite_or_none(row["d_change"]),
                "volumeMA5": finite_or_none(row["volume_ma5"]),
                "volumeChangePct": finite_or_none(row["volume_change_pct"]),
            }
        )
    return rows


def build_symbol_payload(symbol: str, range_value: str, limit: int) -> dict[str, Any]:
    result = fetch_yahoo_chart(symbol, range_value)
    meta = result.get("meta", {})
    rows = serialize_rows(add_indicators(chart_to_frame(result)), limit)
    return {
        "symbol": symbol,
        "name": meta.get("shortName") or meta.get("longName") or symbol,
        "currency": meta.get("currency", "USD"),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch stock daily data and KD indicators.")
    parser.add_argument("--watchlist", type=Path, default=Path("scripts/watchlist.json"))
    parser.add_argument("--output", type=Path, default=Path("docs/data/market-data.json"))
    parser.add_argument("--range", default="6mo")
    parser.add_argument("--limit", type=int, default=90)
    args = parser.parse_args()

    watchlist = load_watchlist(args.watchlist)
    symbols = watchlist["symbols"]
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Yahoo Finance chart API",
        "indicator": {
            "kd": "Slow stochastic: 9-day RSV, 3-day K SMA, 3-day D SMA",
            "volumeChangePct": "Current volume vs 5-day average volume",
        },
        "privateCompanies": watchlist["privateCompanies"],
        "symbols": {},
        "errors": {},
    }

    for symbol in symbols:
        try:
            payload["symbols"][symbol] = build_symbol_payload(symbol, args.range, args.limit)
            time.sleep(0.5)
        except (urllib.error.URLError, RuntimeError, KeyError, IndexError, ValueError) as exc:
            payload["errors"][symbol] = str(exc)
            print(f"[warn] {symbol}: {exc}", file=sys.stderr)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {args.output} with {len(payload['symbols'])} symbols")
    return 0 if payload["symbols"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
