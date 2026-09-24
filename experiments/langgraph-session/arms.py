"""
Where a run sends its traffic, and the guard that keeps the arms honest.

Two arms:
  direct  — straight to the provider. Nothing of ours in the path.
  anyray  — through the gateway, the ordinary request, optimization on.

The control (`direct`) deliberately does NOT read ANTHROPIC_API_KEY or
OPENAI_API_KEY. On a machine enrolled with Anyray those variables ARE the
routing, so borrowing one is how a "direct" control quietly goes through the
gateway and produces a null result that looks like a rigorous one. The lab's
agentbench hit exactly this; the variable is separate on purpose.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse


class RoutingError(RuntimeError):
    pass


@dataclass(frozen=True)
class Arm:
    name: str
    base_url: str
    api_key: str
    model: str
    through_gateway: bool
    extra_headers: dict

    def check(self) -> None:
        host = (urlparse(self.base_url).hostname or "").lower()
        if not host:
            raise RoutingError(f"arm {self.name!r}: {self.base_url!r} has no host")
        if not self.through_gateway and "anyray" in host:
            raise RoutingError(
                f"arm {self.name!r} is the DIRECT control but resolves to {host!r}. "
                "That is the ambient-routing defect: the control would measure an "
                "optimized call and the whole comparison would be against itself."
            )
        if self.through_gateway and "anyray" not in host:
            raise RoutingError(
                f"arm {self.name!r} is meant to traverse the gateway but resolves to {host!r}."
            )


def _require(name: str, why: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise RoutingError(f"{name} is not set. {why}")
    return v


def build_arms(model: str | None = None) -> list[Arm]:
    model = model or os.environ.get("EXPERIMENT_MODEL", "").strip()
    if not model:
        raise RoutingError(
            "EXPERIMENT_MODEL is not set, and there is no safe default: every "
            "deployment routes a different set of models."
        )
    gateway = _require(
        "ANYRAY_GATEWAY_URL", "It is the gateway the 'anyray' arm goes through."
    )
    gateway_key = _require(
        "ANYRAY_API_KEY", "The 'anyray' arm needs an Anyray client key (ark_...)."
    )
    direct_url = _require(
        "DIRECT_BASE_URL",
        "The 'direct' control needs your provider's own base URL, e.g. https://api.openai.com/v1.",
    )
    direct_key = _require(
        "DIRECT_API_KEY",
        "The 'direct' control needs YOUR provider key, given explicitly. It is deliberately "
        "not read from ANTHROPIC_API_KEY / OPENAI_API_KEY: on an enrolled machine those are "
        "part of the Anyray routing, and borrowing one makes the control a second gateway arm.",
    )

    arms = [
        Arm("direct", direct_url.rstrip("/"), direct_key,
            os.environ.get("DIRECT_MODEL", model), False, {}),
        Arm("anyray", gateway.rstrip("/") + "/v1", gateway_key, model, True,
            # x-anyray-test asks for the content-free decisions header, which is
            # how the run records WHICH strategies fired rather than guessing.
            {"x-anyray-test": "1", "x-anyray-metadata": '{"tool":"langgraph-session"}'}),
    ]
    for a in arms:
        a.check()
    return arms
