"""
The LangGraph agent, and the accounting around it.

WHY A REAL GRAPH AND NOT A REPLAY. The per-request simulator sends one request
twice and compares the bill. It cannot see the thing that decided the Salt
evaluation: an agent REACTS to what the optimizer changed, and may take a
different number of turns. Replaying a recorded transcript cannot produce that
effect in either direction, because the turns in a recording already happened
under whatever policy was live.

So here turns are an OUTCOME. The graph runs until the model stops calling
tools; whatever number of turns that takes is data, not a parameter.

What is measured per episode:
  turns          model invocations until it stopped
  tool_calls     observations it pulled back
  input_tokens   summed from the provider's own usage, every call
  cost_usd       at the rates in the simulator's rates.json
  passed         the withheld grader's verdict on the final answer
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

SYSTEM = (
    "You are an SRE agent investigating a production incident. Use the read_logs "
    "tool to read each pod's logs. Be thorough: the cause appears in only one pod, "
    "and the most frequent error is a harmless red herring. When you are certain, "
    "reply with one sentence naming the order id, the upstream service and the "
    "exact error code. Do not call a tool in the same message as your final answer."
)


class State(TypedDict):
    messages: Annotated[list, add_messages]


@dataclass
class Episode:
    arm: str
    seed_index: int
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    wall_s: float = 0.0
    passed: bool | None = None
    missing: list[str] = field(default_factory=list)
    answer: str = ""
    strategies: list[str] = field(default_factory=list)
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _usage_of(msg: AIMessage) -> tuple[int, int, int]:
    """Input, output, cached — from the provider's own usage block.

    LangChain normalises some of this, but the cached count only survives in
    the raw response metadata, and it matters: a cached read is real input the
    provider counted, so leaving it out would understate the baseline and
    flatter whichever arm caches better.
    """
    meta = (msg.response_metadata or {}).get("token_usage") or {}
    usage = msg.usage_metadata or {}
    inp = usage.get("input_tokens") or meta.get("prompt_tokens") or 0
    out = usage.get("output_tokens") or meta.get("completion_tokens") or 0
    details = meta.get("prompt_tokens_details") or {}
    cached = details.get("cached_tokens") or (usage.get("input_token_details") or {}).get("cache_read") or 0
    return int(inp), int(out), int(cached)


def run_episode(arm, task, seed_index: int, max_turns: int = 40, timeout_s: int = 300) -> Episode:
    ep = Episode(arm=arm.name, seed_index=seed_index)
    started = time.time()

    @tool
    def read_logs(pod: str) -> str:
        """Read the full log for one checkout pod. Valid pods: checkout-pod-0 … checkout-pod-3."""
        return task.logs.get(pod, f"no such pod: {pod}. Valid pods: {', '.join(task.logs)}")

    tools = [read_logs]
    llm = ChatOpenAI(
        model=arm.model,
        base_url=arm.base_url,
        api_key=arm.api_key,
        temperature=0,
        max_retries=3,
        timeout=timeout_s,
        default_headers=arm.extra_headers or None,
        # Without this, response_metadata carries no headers at all and the
        # gateway's x-anyray-optimization block is silently unreadable — the
        # run would report "no strategies fired" on every episode forever,
        # which looks like a finding and is actually a missing flag.
        include_response_headers=True,
    ).bind_tools(tools)
    by_name = {t.name: t for t in tools}

    def call_model(state: State):
        msg = llm.invoke([SystemMessage(SYSTEM)] + state["messages"])
        ep.turns += 1
        inp, out, cached = _usage_of(msg)
        ep.input_tokens += inp
        ep.output_tokens += out
        ep.cached_tokens += cached
        hdr = (msg.response_metadata or {}).get("headers") or {}
        # Header names are case-insensitive on the wire; do not assume a case.
        raw = next(
            (v for k, v in hdr.items() if k.lower() == "x-anyray-optimization"),
            None,
        )
        if raw:
            try:
                for d in (json.loads(raw).get("decisions") or []):
                    kind = d.get("kind") or d.get("strategy")
                    if kind and kind not in ep.strategies:
                        ep.strategies.append(kind)
            except Exception:
                pass
        return {"messages": [msg]}

    def call_tools(state: State):
        last = state["messages"][-1]
        out = []
        for tc in last.tool_calls:
            ep.tool_calls += 1
            result = by_name[tc["name"]].invoke(tc["args"])
            out.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
        return {"messages": out}

    def should_continue(state: State):
        last = state["messages"][-1]
        if getattr(last, "tool_calls", None):
            return "tools"
        return END

    g = StateGraph(State)
    g.add_node("model", call_model)
    g.add_node("tools", call_tools)
    g.set_entry_point("model")
    g.add_conditional_edges("model", should_continue, {"tools": "tools", END: END})
    g.add_edge("tools", "model")
    app = g.compile()

    try:
        final = app.invoke(
            {"messages": [HumanMessage(task.question)]},
            {"recursion_limit": max_turns * 2},
        )
        ep.answer = final["messages"][-1].content or ""
        ep.passed, ep.missing = task.grade(ep.answer)
    except Exception as e:  # noqa: BLE001 — an episode that dies is data, not a crash
        ep.error = f"{type(e).__name__}: {e}"[:300]
    ep.wall_s = round(time.time() - started, 2)
    return ep
