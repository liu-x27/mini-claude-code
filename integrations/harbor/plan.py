"""The trial matrix for .github/workflows/terminal-bench.yml: one GitHub job per agent, task and attempt.

    python integrations/harbor/plan.py --agents oracle --tasks sample --attempts 1

Task names come from the registry file the workflow pins, so `sample` is the
benchmark's own 10-task sample and `all` its 89 tasks, never a list kept here.
Standard library only: it runs before anything is installed.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

AGENTS = ("oracle", "mini-claude-code", "claude-code", "terminus-2", "mini-swe-agent")
# GitHub's limit on the jobs one matrix can expand to.
MAX_JOBS = 256


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry-url", required=True)
    parser.add_argument("--dataset", default="terminal-bench@2.0")
    parser.add_argument("--sample", default="terminal-bench-sample@2.0")
    parser.add_argument("--agents", required=True, help=f"comma-separated, from {', '.join(AGENTS)}")
    parser.add_argument("--tasks", required=True, help='"sample", "all", or task names separated by spaces or commas')
    parser.add_argument("--attempts", type=int, default=1)
    args = parser.parse_args()

    registry = json.load(urllib.request.urlopen(args.registry_url, timeout=60))
    names = _dataset_tasks(registry, args.dataset)
    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    unknown = [a for a in agents if a not in AGENTS]
    if not agents or unknown:
        return _fail(f"agents must be from {', '.join(AGENTS)}; got {args.agents!r}")

    spec = args.tasks.strip()
    if spec == "all":
        tasks = sorted(names)
    elif spec == "sample":
        tasks = sorted(_dataset_tasks(registry, args.sample))
    else:
        tasks = [t for t in spec.replace(",", " ").split() if t]
    missing = [t for t in tasks if t not in names]
    if not tasks or missing:
        return _fail(f"not tasks of {args.dataset}: {', '.join(missing) or '(none given)'}")
    if args.attempts < 1:
        return _fail("attempts must be at least 1")

    # Task by task, with every agent's trial of an attempt next to the others': GitHub starts jobs
    # roughly in this order, so a run cut short (a key out of credit, a cancel) loses whole tasks for
    # every agent instead of one agent's last tasks, and the comparison stays paired.
    matrix = [
        {"agent": agent, "task": task, "attempt": attempt, "id": f"{agent}__{task}__{attempt}"}
        for task in tasks
        for attempt in range(1, args.attempts + 1)
        for agent in agents
    ]
    if len(matrix) > MAX_JOBS:
        return _fail(f"{len(matrix)} jobs; one run can have at most {MAX_JOBS}")
    print(json.dumps(matrix))
    print(f"{len(matrix)} trials: {len(agents)} agent(s) x {len(tasks)} task(s) x {args.attempts}", file=sys.stderr)
    return 0


def _dataset_tasks(registry: list[dict], ref: str) -> set[str]:
    name, _, version = ref.partition("@")
    for entry in registry:
        if entry.get("name") == name and entry.get("version") == version:
            return {t["name"] for t in entry["tasks"]}
    raise SystemExit(f"{ref} is not in the registry")


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
