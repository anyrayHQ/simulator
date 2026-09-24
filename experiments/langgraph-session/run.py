#!/usr/bin/env python3
"""
Run the paired session experiment.

  ./.venv/bin/python run.py --episodes 5

Alternates arms episode by episode so a provider having a slow ten minutes
lands on both, not on whichever ran second. Writes results.json as it goes:
these are real agent sessions on your bill, and a crash on episode 9 should
not discard the eight already paid for.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

import agent
import arms as arms_mod
import task as task_mod

HERE = Path(__file__).parent
RATES = HERE.parent.parent / "rates.json"


def load_env(path: Path) -> None:
    """Read .env without a dependency. Real environment wins."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def rate_for(model: str):
    if not RATES.exists():
        return None
    data = json.loads(RATES.read_text())
    models = data.get("models", {})
    if model in models:
        return models[model], data
    bare = model.split("[")[0]
    return (models.get(bare), data) if models.get(bare) else (None, data)


def cost_usd(model: str, input_tokens: int, output_tokens: int, cached: int) -> float | None:
    got = rate_for(model)
    if not got or not got[0]:
        return None
    rate, data = got
    per_in = rate["input"] / 1_000_000
    read_mult = rate.get("cacheReadMultiplier", data.get("cache", {}).get("readMultiplier", 0.1))
    uncached = max(0, input_tokens - cached)
    return uncached * per_in + cached * per_in * read_mult + output_tokens * rate["output"] / 1_000_000


def summarize(rows: list[dict], model: str) -> dict:
    out = {}
    for name in sorted({r["arm"] for r in rows}):
        ok = [r for r in rows if r["arm"] == name and not r["error"]]
        if not ok:
            out[name] = {"episodes": 0}
            continue
        costs = [cost_usd(model, r["input_tokens"], r["output_tokens"], r["cached_tokens"]) for r in ok]
        costs = [c for c in costs if c is not None]
        out[name] = {
            "episodes": len(ok),
            "passed": sum(1 for r in ok if r["passed"]),
            "turns_mean": round(statistics.mean(r["turns"] for r in ok), 2),
            "tool_calls_mean": round(statistics.mean(r["tool_calls"] for r in ok), 2),
            "input_tokens_mean": round(statistics.mean(r["input_tokens"] for r in ok)),
            "cached_tokens_mean": round(statistics.mean(r["cached_tokens"] for r in ok)),
            "cost_usd_mean": round(statistics.mean(costs), 5) if costs else None,
            "strategies": sorted({s for r in ok for s in r["strategies"]}),
        }
    return out


def render(summary: dict, episodes: int) -> str:
    L = ["", "PER-SESSION RESULT", ""]
    d, a = summary.get("direct", {}), summary.get("anyray", {})
    if not d.get("episodes") or not a.get("episodes"):
        return "\n".join(L + ["  not enough completed episodes on both arms to compare"])
    L.append(f"  {'':22}{'direct':>12}{'anyray':>12}")
    for label, key, fmt in [
        ("episodes completed", "episodes", "{}"),
        ("task passed", "passed", "{}"),
        ("turns / session", "turns_mean", "{}"),
        ("tool calls / session", "tool_calls_mean", "{}"),
        ("input tokens / session", "input_tokens_mean", "{:,}"),
        ("cached / session", "cached_tokens_mean", "{:,}"),
        ("cost / session", "cost_usd_mean", "${}"),
    ]:
        dv, av = d.get(key), a.get(key)
        L.append(f"  {label:22}{fmt.format(dv) if dv is not None else '—':>12}{fmt.format(av) if av is not None else '—':>12}")
    if d.get("cost_usd_mean") and a.get("cost_usd_mean"):
        delta = (1 - a["cost_usd_mean"] / d["cost_usd_mean"]) * 100
        L += ["", f"  Cost per session: {delta:+.1f}% with Anyray."]
        tdelta = a["turns_mean"] - d["turns_mean"]
        L.append(
            f"  Turns per session: {tdelta:+.2f}. This is the number a per-request bench cannot see — "
            "a live agent reacts to what changed, and extra turns can eat a per-call saving."
        )
    if a.get("strategies"):
        L.append(f"  Strategies that fired: {', '.join(a['strategies'])}")
    L += ["", f"  {episodes} episode(s) per arm is a SMALL SAMPLE. Read a small difference as noise."]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=3, help="episodes per arm")
    ap.add_argument("--out", default="results.json")
    ap.add_argument("--max-turns", type=int, default=40)
    ap.add_argument("--dry-run", action="store_true", help="check config and the task, call nothing")
    args = ap.parse_args()

    load_env(HERE / ".env")
    try:
        the_arms = arms_mod.build_arms()
    except arms_mod.RoutingError as e:
        print(f"{e}\n", file=sys.stderr)
        return 1

    t = task_mod.build()
    if args.dry_run:
        print(f"task: {len(t.logs)} pods, {sum(len(v) for v in t.logs.values()):,} log chars")
        print(f"must include: {', '.join(t.must_include)}")
        for a in the_arms:
            print(f"arm {a.name:8} -> {a.base_url}  model={a.model}  through_gateway={a.through_gateway}")
        return 0

    print(f"{args.episodes} episode(s) x {len(the_arms)} arm(s). Each is a full agent session on YOUR bill.")
    print(f"Arms: {', '.join(f'{a.name} -> {a.base_url}' for a in the_arms)}\n")

    rows: list[dict] = []
    out_path = HERE / args.out
    for i in range(args.episodes):
        # Alternate, so a slow patch at the provider lands on both arms.
        ordered = the_arms if i % 2 == 0 else list(reversed(the_arms))
        for a in ordered:
            ep = agent.run_episode(a, t, i, max_turns=args.max_turns)
            rows.append(ep.as_dict())
            flag = "ok " if ep.passed else ("ERR" if ep.error else "FAIL")
            print(
                f"  [{flag}] {a.name:7} ep{i}  turns={ep.turns:<3} tools={ep.tool_calls:<3} "
                f"in={ep.input_tokens:<8,} cached={ep.cached_tokens:<8,} {ep.wall_s}s"
                + (f"  {ep.error}" if ep.error else "")
            )
            out_path.write_text(json.dumps({
                "model": the_arms[0].model, "episodes_requested": args.episodes,
                "complete": False, "rows": rows,
                "summary": summarize(rows, the_arms[0].model),
            }, indent=2) + "\n")

    summary = summarize(rows, the_arms[0].model)
    out_path.write_text(json.dumps({
        "model": the_arms[0].model, "episodes_requested": args.episodes,
        "complete": True, "rows": rows, "summary": summary,
    }, indent=2) + "\n")
    print(render(summary, args.episodes))
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
