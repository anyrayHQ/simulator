"""
The task the agent has to actually finish.

A synthetic incident investigation, chosen for one property: the answer exists
in exactly one place, buried in bulky repetitive tool output. That is the shape
where eliding strategies have something to remove AND the shape where removing
the wrong thing costs the agent a turn — which is the tension the whole
experiment exists to measure.

Deterministic from a seed, so both arms investigate an identical world and a
difference in turns cannot come from a difference in the task.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

SEED = 20260924

# The answer. Deliberately not the loudest signal in the data: `session-cache`
# errors far more often and is harmless, so an agent that grabs the first error
# it sees gets it wrong and the grader catches that rather than rewarding speed.
CULPRIT_ORDER = "ord_88412"
CULPRIT_UPSTREAM = "payments-api"
CULPRIT_ERROR = "ECONNRESET"
RED_HERRING = "session-cache"

SERVICES = ["edge-router", "authz", "payments-api", "session-cache", "billing-sync"]
PODS = [f"checkout-{i}" for i in range(12)]


@dataclass(frozen=True)
class Task:
    question: str
    must_include: tuple[str, ...]
    logs: dict[str, str]

    def grade(self, answer: str) -> tuple[bool, list[str]]:
        """Substring survival, the same rule the per-request simulator uses:
        case- and whitespace-insensitive, nothing else normalised."""
        hay = " ".join(answer.lower().split())
        missing = [f for f in self.must_include if " ".join(f.lower().split()) not in hay]
        return (not missing), missing


def _line(rng: random.Random, i: int, svc: str) -> str:
    return (
        f"2026-09-21T{10 + i % 12:02d}:{i % 60:02d}:{rng.randrange(60):02d}.{rng.randrange(1000):03d}Z "
        f"INFO  checkout worker={i % 8} order=ord_{70000 + i} state=pending->authorized "
        f"latency_ms={150 + rng.randrange(200)} upstream={svc} pod={rng.choice(PODS)}"
    )


def build(lines_per_pod: int = 220, pods: int = 4) -> Task:
    rng = random.Random(SEED)
    logs: dict[str, str] = {}
    for p in range(pods):
        body = [_line(rng, i, rng.choice(SERVICES)) for i in range(lines_per_pod)]
        # The red herring is noisy and harmless, and appears everywhere.
        for _ in range(6):
            i = rng.randrange(len(body))
            body[i] = (
                f"2026-09-21T11:{rng.randrange(60):02d}:{rng.randrange(60):02d}Z WARN  checkout "
                f"upstream={RED_HERRING} evicted key=sess_{rng.randrange(9999)} (harmless)"
            )
        # The answer lives in ONE pod only, at the end.
        if p == pods - 1:
            body += [
                f"2026-09-21T23:43:38.902Z WARN  checkout worker=2 order={CULPRIT_ORDER} "
                f"upstream={CULPRIT_UPSTREAM} attempt=2 timeout",
                f"2026-09-21T23:43:47.918Z ERROR checkout worker=2 order={CULPRIT_ORDER} "
                f"upstream={CULPRIT_UPSTREAM} error={CULPRIT_ERROR} socket hang up",
                f"2026-09-21T23:43:47.920Z ERROR checkout worker=2 order={CULPRIT_ORDER} "
                f"state=pending->failed reason=upstream_unavailable",
            ]
        logs[f"checkout-pod-{p}"] = "\n".join(body)

    return Task(
        question=(
            "Checkout is failing for some orders. Read the logs from every pod and tell me: "
            "which order failed, which upstream service it failed against, and the exact error "
            "code. Use the read_logs tool once per pod. When you are certain, state all three "
            "in one sentence."
        ),
        must_include=(CULPRIT_ORDER, CULPRIT_UPSTREAM, CULPRIT_ERROR),
        logs=logs,
    )
