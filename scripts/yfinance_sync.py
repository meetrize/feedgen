#!/usr/bin/env python3
"""补源：用 yfinance 拉取核心全球指数等，stdout 输出 JSON 数组。

依赖：pip install yfinance
失败时输出 []，不抛到非零退出（由调用方决定是否忽略）。
"""

from __future__ import annotations

import json
import sys

# 一期核心指数；symbol 为 yfinance ticker
CORE = [
    {
        "symbol": "^DJI",
        "chart_symbol": "DJI",
        "name": "道琼斯",
        "name_en": "Dow Jones Industrial Average",
        "market": "index",
        "exchange": "US",
        "asset_type": "index",
        "aliases": ["道指", "道琼斯", "Dow", "DJIA"],
    },
    {
        "symbol": "^IXIC",
        "chart_symbol": "IXIC",
        "name": "纳斯达克",
        "name_en": "NASDAQ Composite",
        "market": "index",
        "exchange": "US",
        "asset_type": "index",
        "aliases": ["纳指", "纳斯达克", "Nasdaq"],
    },
    {
        "symbol": "^GSPC",
        "chart_symbol": "SPX",
        "name": "标普500",
        "name_en": "S&P 500",
        "market": "index",
        "exchange": "US",
        "asset_type": "index",
        "aliases": ["标普", "标普500", "S&P500", "SPX"],
    },
    {
        "symbol": "^HSI",
        "chart_symbol": "hkHSI",
        "name": "恒生指数",
        "name_en": "Hang Seng Index",
        "market": "index",
        "exchange": "HK",
        "asset_type": "index",
        "aliases": ["恒指", "恒生指数", "HSI"],
    },
    {
        "symbol": "^N225",
        "chart_symbol": "N225",
        "name": "日经225",
        "name_en": "Nikkei 225",
        "market": "index",
        "exchange": "JP",
        "asset_type": "index",
        "aliases": ["日经", "日经225", "Nikkei"],
    },
]


def main() -> int:
    try:
        import yfinance as yf  # type: ignore
    except ImportError:
        print("[]")
        print("yfinance not installed; pip install yfinance", file=sys.stderr)
        return 0

    out = []
    for row in CORE:
        item = dict(row)
        try:
            t = yf.Ticker(row["symbol"])
            info = getattr(t, "info", None) or {}
            short = info.get("shortName") or info.get("longName")
            if short and not item.get("name_en"):
                item["name_en"] = short
            elif short and item.get("name_en") != short:
                aliases = list(item.get("aliases") or [])
                if short not in aliases:
                    aliases.append(short)
                item["aliases"] = aliases
        except Exception as exc:  # noqa: BLE001
            print(f"warn {row['symbol']}: {exc}", file=sys.stderr)
        out.append(item)

    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
