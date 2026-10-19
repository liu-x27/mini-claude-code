"""Harbor job directories -> one table per harness, the way README.md reports them.

    python integrations/harbor/summarize.py artifacts/ --prices 2.1,8.4,0.42,2.625 --currency CNY

Walks every trial's result.json under the directory (one Harbor job per
GitHub job, so each trial is its own job directory) and prints Markdown; with
--json it also writes every trial and every aggregate.

The score counts a trial's reward as the verifier gave it, an errored trial
included: Harbor verifies after a timeout or an agent error too. Its 95%
interval resamples tasks, not trials, since attempts at one task are not
independent. Cost is estimated from tokens at the given prices; cache writes
are priced as input for harnesses that do not report them separately, and
with --peak deepseek a trial that started in DeepSeek's peak hours costs double.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ORDER = ("oracle", "mini-claude-code", "claude-code", "terminus-2", "mini-swe-agent")
API_ERRORS = {"NetworkConnectionError", "AgentAuthenticationError", "ModelNotFoundError"}
VERIFIER_ERRORS = {"VerifierTimeoutError", "RewardFileNotFoundError", "RewardFileEmptyError", "VerifierOutputParseError"}


def load_trials(root: Path) -> list[dict[str, Any]]:
    trials = []
    for path in sorted(root.rglob("result.json")):
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(result, dict) or "trial_name" not in result:
            continue  # the job's own result.json
        trials.append(_row(result, job=path.parent.parent.name, trial_dir=path.parent))
    return trials


def _row(result: dict[str, Any], job: str, trial_dir: Path | None = None) -> dict[str, Any]:
    agent = (result.get("agent_info") or {}).get("name") or "?"
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward", next(iter(rewards.values()), None)) if rewards else None
    exception_info = result.get("exception_info") or {}
    exception = exception_info.get("exception_type")
    context = result.get("agent_result") or {}
    metadata = context.get("metadata") or {}
    parts = job.split("__")
    # An install-only run disables the verifier: no reward is what success looks like there.
    installed_only = bool(((result.get("config") or {}).get("verifier") or {}).get("disable"))
    return {
        "installed_only": installed_only,
        # What a reader needs to see why a trial did not pass, without downloading the artifact.
        "exception_message": _exception_text(exception_info.get("exception_message")),
        "test_output_tail": _tail(trial_dir / "verifier" / "test-stdout.txt") if trial_dir else None,
        "agent_log_tail": _agent_log_tail(trial_dir) if trial_dir and exception_info else None,
        "job": job,
        "agent": agent,
        "task": result.get("task_name"),
        "attempt": parts[2] if len(parts) == 3 else None,
        "reward": reward,
        "exception": exception,
        "category": _category(reward, exception, metadata, installed_only),
        "input_tokens": context.get("n_input_tokens"),
        "cached_tokens": context.get("n_cache_tokens"),
        "cache_write_tokens": metadata.get("cache_creation_input_tokens"),
        "output_tokens": context.get("n_output_tokens"),
        "reported_cost_usd": context.get("cost_usd"),
        "stop_reason": metadata.get("stop_reason"),
        "agent_seconds": _seconds(result.get("agent_execution")),
        "trial_seconds": _seconds({"started_at": result.get("started_at"), "finished_at": result.get("finished_at")}),
        "started_at": (result.get("agent_execution") or {}).get("started_at") or result.get("started_at"),
        "version": (result.get("agent_info") or {}).get("version"),
    }


def _category(reward: Any, exception: str | None, metadata: dict[str, Any], installed_only: bool = False) -> str:
    if installed_only and not exception:
        return "installed (install-only run)"
    if isinstance(reward, (int, float)) and reward >= 1:
        return "passed" if not exception else f"passed, with {exception}"
    if exception == "AgentTimeoutError":
        return "failed: agent timed out"
    if exception == "AgentSetupTimeoutError" or exception == "EnvironmentStartTimeoutError":
        return f"error: {exception}"
    if exception in VERIFIER_ERRORS:
        return f"error: verifier ({exception})"
    if exception and (exception.startswith("Api") or exception in API_ERRORS):
        return f"error: API ({exception})"
    if exception:
        return f"error: {exception}"
    if reward is None:
        return "error: no reward"
    stop = metadata.get("stop_reason")
    if stop and stop not in ("end_turn", "success"):
        return f"failed: stopped ({stop})"
    return "failed: finished, tests fail"


def _exception_text(message: str | None) -> str | None:
    """The exception's first line, and for a failed command what it printed rather than the command.

    Harbor's message for an agent that exited non-zero is the whole command (the task's instruction
    included) and then its stdout and stderr, cut to their ends; the cause is in the latter.
    """
    if not message:
        return None
    first = message.strip().splitlines()[0][:200]
    for marker in ("\nstdout: ", "\nstderr: "):
        at = message.find(marker)
        if at >= 0:
            return f"{first}\n...\n{message[at + 1:][-1500:]}"
    return message.strip()[:1500]


def _agent_log_tail(trial_dir: Path) -> str | None:
    """The end of the agent's own log, for a trial that ended in an exception."""
    for name in ("mini-swe-agent.txt", "stderr.txt", "trial.log"):
        for path in (trial_dir / "agent" / name, trial_dir / name):
            tail = _tail(path, lines=25, chars=2000)
            if tail:
                return f"{path.relative_to(trial_dir)}:\n{tail}"
    return None


def _tail(path: Path, lines: int = 15, chars: int = 1500) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return "\n".join(text.rstrip().splitlines()[-lines:])[-chars:] or None


def _fence(text: str) -> str:
    """A code fence longer than any run of backticks in the text. mini-swe-agent fences its commands, and
    a log tail holding one would otherwise close the block early and print every later trial's as text."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def _seconds(timing: Any) -> float | None:
    if not isinstance(timing, dict) or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    try:
        start = datetime.fromisoformat(str(timing["started_at"]).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(timing["finished_at"]).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (end - start).total_seconds()


def cost(row: dict[str, Any], prices: tuple[float, float, float, float] | None, peak: str | None = None) -> float | None:
    """Estimated cost of one trial, in the prices' currency (per million tokens: input, output, cache read, cache write)."""
    if prices is None or row["input_tokens"] is None or row["output_tokens"] is None:
        return None
    p_in, p_out, p_read, p_write = prices
    cached = row["cached_tokens"] or 0
    written = row["cache_write_tokens"] or 0
    uncached = max(row["input_tokens"] - cached - written, 0)
    base = (uncached * p_in + cached * p_read + written * p_write + row["output_tokens"] * p_out) / 1e6
    return base * peak_factor(row.get("started_at"), peak)


def peak_factor(started_at: Any, peak: str | None) -> float:
    """DeepSeek's prices double on weekdays 09:00-12:00 and 14:00-18:00 Beijing time, by when the agent started.

    Chinese public holidays are off-peak too, and not known here, so a trial on one is overcounted.
    """
    if peak != "deepseek" or not started_at:
        return 1.0
    try:
        start = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
    except ValueError:
        return 1.0
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    beijing = start.astimezone(timezone(timedelta(hours=8)))
    return 2.0 if beijing.weekday() < 5 and (9 <= beijing.hour < 12 or 14 <= beijing.hour < 18) else 1.0


def by_task(rows: list[dict[str, Any]]) -> dict[str, float]:
    rewards: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        rewards[row["task"]].append(float(row["reward"] or 0))
    return {task: sum(v) / len(v) for task, v in rewards.items()}


def bootstrap(values: list[float], n: int = 10_000, seed: int = 0) -> tuple[float, float]:
    """95% interval of the mean, resampling the given per-task values."""
    if not values:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(values, k=len(values))) / len(values) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n) - 1]


def summarize(trials: list[dict[str, Any]], prices, currency: str, peak: str | None = None) -> tuple[str, dict[str, Any]]:
    agents = sorted({t["agent"] for t in trials}, key=lambda a: (ORDER.index(a) if a in ORDER else len(ORDER), a))
    tasks = sorted({t["task"] for t in trials})
    out: list[str] = []
    aggregates: dict[str, Any] = {}

    out.append(f"{len(trials)} trials, {len(tasks)} tasks, {len(agents)} agent(s).\n")
    out.append(f"| agent | trials | passed | score, 95% CI over tasks | errors | timeouts | input tokens / trial (cached) | output tokens / trial | est. cost / trial ({currency}) | est. total ({currency}) | median agent time |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for agent in agents:
        rows = [t for t in trials if t["agent"] == agent]
        per_task = by_task(rows)
        score = sum(per_task.values()) / len(per_task)
        low, high = bootstrap(list(per_task.values()))
        costs = [c for c in (cost(r, prices, peak) for r in rows) if c is not None]
        inputs = [r["input_tokens"] for r in rows if r["input_tokens"] is not None]
        cached = [r["cached_tokens"] or 0 for r in rows if r["input_tokens"] is not None]
        outputs = [r["output_tokens"] for r in rows if r["output_tokens"] is not None]
        times = [r["agent_seconds"] for r in rows if r["agent_seconds"] is not None]
        aggregate = {
            "trials": len(rows),
            "passed": sum(1 for r in rows if (r["reward"] or 0) >= 1),
            "score": score,
            "ci95": [low, high],
            "errors": sum(1 for r in rows if r["exception"] and r["exception"] != "AgentTimeoutError"),
            "timeouts": sum(1 for r in rows if r["exception"] == "AgentTimeoutError"),
            "mean_input_tokens": statistics.mean(inputs) if inputs else None,
            "mean_cached_tokens": statistics.mean(cached) if cached else None,
            "mean_output_tokens": statistics.mean(outputs) if outputs else None,
            "mean_cost": statistics.mean(costs) if costs else None,
            "total_cost": sum(costs) if costs else None,
            "median_agent_seconds": statistics.median(times) if times else None,
            "categories": dict(Counter(r["category"] for r in rows)),
            "per_task": per_task,
        }
        aggregates[agent] = aggregate
        out.append(
            f"| {agent} | {len(rows)} | {aggregate['passed']} | {100 * score:.1f}% ({100 * low:.0f}–{100 * high:.0f}) "
            f"| {aggregate['errors']} | {aggregate['timeouts']} "
            f"| {_k(aggregate['mean_input_tokens'])} ({_k(aggregate['mean_cached_tokens'])}) | {_k(aggregate['mean_output_tokens'])} "
            f"| {_money(aggregate['mean_cost'])} | {_money(aggregate['total_cost'])} | {_minutes(aggregate['median_agent_seconds'])} |"
        )

    if len([a for a in agents if a != "oracle"]) > 1:
        models = [a for a in agents if a != "oracle"]
        base = models[0]
        out.append(f"\nPaired over tasks both ran, against {base} (positive: the other harness scored higher):\n")
        out.append("| agent | tasks | difference in score, 95% CI |")
        out.append("|---|---|---|")
        for agent in models[1:]:
            a, b = aggregates[agent]["per_task"], aggregates[base]["per_task"]
            common = sorted(set(a) & set(b))
            diffs = [a[t] - b[t] for t in common]
            low, high = bootstrap(diffs)
            mean = sum(diffs) / len(diffs) if diffs else float("nan")
            aggregates[agent][f"vs_{base}"] = {"tasks": len(common), "difference": mean, "ci95": [low, high]}
            out.append(f"| {agent} | {len(common)} | {100 * mean:+.1f} points ({100 * low:+.0f} to {100 * high:+.0f}) |")

    out.append("\nHow each trial ended:\n")
    categories = sorted({c for a in aggregates.values() for c in a["categories"]})
    out.append("| category | " + " | ".join(agents) + " |")
    out.append("|---|" + "---|" * len(agents))
    for category in categories:
        out.append(f"| {category} | " + " | ".join(str(aggregates[a]["categories"].get(category, 0)) for a in agents) + " |")

    out.append("\nPer task (passed / attempts):\n")
    out.append("| task | " + " | ".join(agents) + " |")
    out.append("|---|" + "---|" * len(agents))
    for task in tasks:
        cells = []
        for agent in agents:
            rows = [t for t in trials if t["agent"] == agent and t["task"] == task]
            passed = sum(1 for r in rows if (r["reward"] or 0) >= 1)
            marks = "".join(_mark(r) for r in rows)
            cells.append(f"{passed}/{len(rows)} {marks}".strip() if rows else "–")
        out.append(f"| {task} | " + " | ".join(cells) + " |")
    out.append("\nT timed out, E errored, S stopped short (turn limit, stuck, context).")

    failed = [
        t
        for t in trials
        if not (isinstance(t["reward"], (int, float)) and t["reward"] >= 1) and not t["category"].startswith("installed")
    ]
    if failed:
        out.append(f"\nThe {len(failed)} trial(s) that did not pass: the exception, the end of the agent's log, and the end of the tests' output.\n")
        for row in failed:
            body = "\n\n".join(
                part
                for part in (
                    f"{row['exception']}: {row['exception_message']}" if row["exception"] else None,
                    row.get("agent_log_tail"),
                    row["test_output_tail"],
                )
                if part
            )
            fence = _fence(body)
            out.append(f"<details><summary>{row['job']}: {row['category']}</summary>\n\n{fence}\n{body or '(no test output)'}\n{fence}\n</details>")

    for row in trials:
        row["est_cost"] = cost(row, prices, peak)
    return "\n".join(out) + "\n", {"currency": currency, "prices_per_million": prices, "agents": aggregates, "trials": trials}


def _mark(row: dict[str, Any]) -> str:
    if row["exception"] == "AgentTimeoutError":
        return "T"
    if row["exception"]:
        return "E"
    if row["category"].startswith("failed: stopped"):
        return "S"
    return ""


def _k(value: float | None) -> str:
    return "–" if value is None else f"{value / 1000:,.0f}k"


def _money(value: float | None) -> str:
    return "–" if value is None else f"{value:,.2f}"


def _minutes(value: float | None) -> str:
    return "–" if value is None else f"{value / 60:.1f} min"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--prices", help="per million tokens: input,output,cache_read,cache_write")
    parser.add_argument("--currency", default="CNY")
    parser.add_argument("--peak", help='"deepseek": double the prices for a trial started in its peak hours')
    parser.add_argument("--json", type=Path, help="also write every trial and aggregate here")
    parser.add_argument("--expect", type=Path, help="the planned matrix (plan.py's output): name the trials with no result")
    args = parser.parse_args()

    prices = tuple(float(p) for p in args.prices.split(",")) if args.prices else None
    if prices is not None and len(prices) != 4:
        parser.error("--prices takes four numbers")
    trials = load_trials(args.root)
    # A trial whose job died before Harbor wrote a result, or whose artifact did not upload, would
    # otherwise just be absent from every table: a smaller denominator, not an error.
    missing = []
    if args.expect:
        planned = [entry["id"] for entry in json.loads(args.expect.read_text(encoding="utf-8"))]
        found = {t["job"] for t in trials}
        missing = [job for job in planned if job not in found]
    if missing:
        print(f"**{len(missing)} planned trial(s) left no result**, and are in none of the tables below: {', '.join(missing)}\n")
    if not trials:
        print("No trial results found.")
        return 1
    markdown, data = summarize(trials, prices, args.currency, args.peak)
    data["missing"] = missing
    print(markdown)
    if args.json:
        args.json.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
