"""A mini-claude-code session as an ATIF trajectory, the format Harbor's viewer and tools read.

Plain dicts and the standard library only, so it can be tested without Harbor;
the adapter validates the result against Harbor's own models before writing it.

The session file holds the conversation as the API saw it (Anthropic content
blocks), saved after every turn, so a run that Harbor's timeout killed still
has everything up to its last finished turn. What it lacks is per-turn usage:
that comes from the `turn_end` lines of the run's stream-json output.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ARCHIVE_SUFFIX = re.compile(r"-(\d+)\.json$")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """The JSON objects of a JSONL file, skipping lines that are not one (a run killed mid-write)."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def usage_from_events(events: list[dict[str, Any]]) -> tuple[dict[str, int], str]:
    """Token totals for the run, and where they came from.

    The result line is the whole run, subagents and compaction included. A run
    that never printed one (killed at the timeout) is summed from its turns,
    which misses the calls that summarise a compacted history.
    """
    for event in reversed(events):
        if event.get("type") == "result" and isinstance(event.get("usage"), dict):
            return _anthropic_usage(event["usage"]), "result"
    total = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    for event in events:
        inner = event.get("event") if event.get("type") == "subagent" else event
        if isinstance(inner, dict) and inner.get("type") == "turn_end":
            for key, value in _agent_usage(inner.get("usage")).items():
                total[key] += value
    return total, "turn_end events (no result line, so compaction calls are missing)"


def turn_usages(events: list[dict[str, Any]]) -> list[dict[str, int]]:
    """Usage of each of the main agent's turns, in order (subagents' turns are wrapped and skipped)."""
    return [_agent_usage(e.get("usage")) for e in events if e.get("type") == "turn_end"]


def _agent_usage(usage: Any) -> dict[str, int]:
    """AgentUsage (camelCase, as turn_end carries it) in the Anthropic API's names."""
    usage = usage if isinstance(usage, dict) else {}
    return {
        "input_tokens": int(usage.get("inputTokens") or 0),
        "output_tokens": int(usage.get("outputTokens") or 0),
        "cache_creation_input_tokens": int(usage.get("cacheCreationTokens") or 0),
        "cache_read_input_tokens": int(usage.get("cacheReadTokens") or 0),
    }


def _anthropic_usage(usage: dict[str, Any]) -> dict[str, int]:
    keys = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    return {key: int(usage.get(key) or 0) for key in keys}


def prompt_tokens(usage: dict[str, int]) -> int:
    """All input tokens, cached or not: what Harbor and ATIF call prompt or input tokens."""
    return usage["input_tokens"] + usage["cache_creation_input_tokens"] + usage["cache_read_input_tokens"]


def load_segments(sessions_dir: Path, session_id: str) -> list[list[dict[str, Any]]]:
    """The conversation in order: each archived history a compaction replaced, then the live one.

    Each archive is the whole history at the moment it was compacted; the next
    segment starts with the summary that replaced it.
    """
    archives = []
    archive_dir = sessions_dir / "archive"
    if archive_dir.is_dir():
        for path in archive_dir.glob(f"{session_id}-*.json"):
            match = ARCHIVE_SUFFIX.search(path.name)
            if match:
                archives.append((int(match.group(1)), path))
    segments = []
    for _, path in sorted(archives):
        messages = _load_json(path)
        if isinstance(messages, list):
            segments.append(messages)
    session = _load_json(sessions_dir / f"{session_id}.json")
    if isinstance(session, dict) and isinstance(session.get("messages"), list):
        segments.append(session["messages"])
    return segments


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def session_to_atif(
    segments: list[list[dict[str, Any]]],
    *,
    session_id: str,
    agent_version: str,
    model_name: str | None,
    turns: list[dict[str, int]],
    total: dict[str, int] | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """ATIF for the conversation, or None when there is nothing to convert.

    One agent step per assistant message, carrying its text, thinking and tool
    calls; the tool results of the user message after it become that step's
    observation, and any text in that message a user step of its own.
    """
    steps: list[dict[str, Any]] = []
    last_agent: dict[str, Any] | None = None

    def add(step: dict[str, Any]) -> None:
        steps.append({"step_id": len(steps) + 1, **step})

    for index, messages in enumerate(segments):
        for position, message in enumerate(messages):
            blocks = _blocks(message.get("content"))
            if message.get("role") == "assistant":
                step: dict[str, Any] = {"source": "agent", "message": _text(blocks)}
                if model_name:
                    step["model_name"] = model_name
                thinking = "\n\n".join(b.get("thinking") or "" for b in blocks if b.get("type") == "thinking").strip()
                if thinking:
                    step["reasoning_content"] = thinking
                calls = [
                    {
                        "tool_call_id": str(b.get("id")),
                        "function_name": str(b.get("name")),
                        "arguments": b.get("input") if isinstance(b.get("input"), dict) else {"input": b.get("input")},
                    }
                    for b in blocks
                    if b.get("type") == "tool_use"
                ]
                if calls:
                    step["tool_calls"] = calls
                add(step)
                last_agent = steps[-1]
                continue

            results = [b for b in blocks if b.get("type") == "tool_result"]
            if results and last_agent is not None:
                observation = last_agent.setdefault("observation", {"results": []})
                for block in results:
                    result: dict[str, Any] = {
                        "source_call_id": str(block.get("tool_use_id")),
                        "content": _text(_blocks(block.get("content"))),
                    }
                    if block.get("is_error"):
                        result["extra"] = {"is_error": True}
                    observation["results"].append(result)
            text = _text([b for b in blocks if b.get("type") != "tool_result"])
            if text:
                # A segment after the first opens with the summary that replaced the history before it.
                summary = index > 0 and position == 0
                add({"source": "user", "message": text, **({"extra": {"compaction_summary": True}} if summary else {})})

    if not steps:
        return None

    # Per-step usage only where the turns line up with the assistant messages one to one. A run killed
    # while tools ran has one turn more: its reply was never saved, because the history is saved without
    # a tool call whose result is missing.
    agent_steps = [s for s in steps if s["source"] == "agent"]
    if len(turns) in (len(agent_steps), len(agent_steps) + 1):
        for step, usage in zip(agent_steps, turns):
            step["metrics"] = _metrics(usage)

    trajectory: dict[str, Any] = {
        "session_id": session_id,
        "agent": {"name": "mini-claude-code", "version": agent_version, **({"model_name": model_name} if model_name else {})},
        "steps": steps,
    }
    if total is not None:
        trajectory["final_metrics"] = {
            "total_prompt_tokens": prompt_tokens(total),
            "total_completion_tokens": total["output_tokens"],
            "total_cached_tokens": total["cache_read_input_tokens"],
            "total_steps": len(steps),
            "extra": {"cache_creation_input_tokens": total["cache_creation_input_tokens"]},
        }
    if extra:
        trajectory["extra"] = extra
    return trajectory


def _metrics(usage: dict[str, int]) -> dict[str, Any]:
    return {
        "prompt_tokens": prompt_tokens(usage),
        "completion_tokens": usage["output_tokens"],
        "cached_tokens": usage["cache_read_input_tokens"],
        "extra": {"cache_creation_input_tokens": usage["cache_creation_input_tokens"]},
    }


def _blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _text(blocks: list[dict[str, Any]]) -> str:
    parts = []
    for block in blocks:
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "image":
            parts.append("[image]")
    return "\n\n".join(p for p in parts if p).strip()
