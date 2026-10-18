"""mini-claude-code as a Harbor installed agent, for Terminal-Bench and the other Harbor datasets.

    harbor run -d terminal-bench@2.0 \\
        -a integrations.harbor.mini_claude_code:MiniClaudeCode \\
        -m anthropic/claude-opus-5-5

The key and the endpoint come from the Harbor process's environment, the way
Harbor's own claude-code agent takes them: ANTHROPIC_API_KEY, and
ANTHROPIC_BASE_URL for any other endpoint that speaks the Messages API
(MiniMax serves one; name its model with -m). Neither goes on the command
line, so neither ends up in the job's config.json.

Agent kwargs (--ak):
    ref=<branch, tag or commit>   the version of this repository to install (default main)
    max_turns=<n>                 turn limit (default 1000, so the task's own timeout is the limit,
                                  as it is for terminus-2 and mini-swe-agent)
    context_window=<tokens>       for a model the harness has no window for; sets AGENT_CONTEXT_WINDOW,
                                  which decides when the history is compacted

A run that stopped short (the turn limit, stuck, a full context window) is
left to the verifier; a run that threw (the API failing after its retries)
raises, so the trial counts as an error rather than as a task the harness
failed.
"""

from __future__ import annotations

import json
import shlex
import uuid
from types import SimpleNamespace
from typing import ClassVar

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = "https://github.com/liu-x27/mini-claude-code.git"
# The Node CI uses: a newer npm resolves one optional peer in the lockfile differently, and
# `npm ci` refuses a lockfile it would have to change. Its own directory, not nvm and not PATH,
# so the task's shell keeps whatever node the task image has.
NODE_VERSION = "24.12.0"
APP = "$HOME/.mini-claude-code"


class MiniClaudeCode(BaseInstalledAgent):
    MODEL_CONNECTION: ClassVar[ModelConnectionSpec] = ModelConnectionSpec(
        default_provider="anthropic",
        api_key_envs=("ANTHROPIC_API_KEY",),
        base_url_envs=("ANTHROPIC_BASE_URL",),
    )
    # Node, a clone and `npm ci` (whose git dependency builds itself) take longer than the default 360 s.
    DEFAULT_SETUP_TIMEOUT_SEC: ClassVar[float] = 900.0

    def __init__(
        self,
        *args,
        ref: str = "main",
        repo: str = REPO,
        max_turns: int | str = 1000,
        context_window: int | str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._ref = str(ref)
        self._repo = str(repo)
        self._max_turns = int(max_turns)
        self._context_window = int(context_window) if context_window else None

    @staticmethod
    def name() -> str:
        return "mini-claude-code"

    def get_version_command(self) -> str | None:
        return f'git -C "{APP}/src" rev-parse --short=12 HEAD'

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "git", "tar", "ca_certificates"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f'app="{APP}"; rm -rf "$app"; mkdir -p "$app/node"; '
                'case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; '
                '*) echo "no Node build for $(uname -m)" >&2; exit 1 ;; esac; '
                f'curl -fsSL "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-$arch.tar.gz" '
                '| tar -xz -C "$app/node" --strip-components=1; '
                'export PATH="$app/node/bin:$PATH"; '
                # Fetched by name, so a commit works as well as a branch or a tag.
                'git init -q "$app/src"; cd "$app/src"; '
                f"git fetch -q --depth 1 {shlex.quote(self._repo)} {shlex.quote(self._ref)}; "
                "git checkout -q FETCH_HEAD; "
                # The lockfile records the xavierjev dependency as git+ssh, and a container has no SSH key.
                # The rewrite lives in a HOME of its own for this one command, not in the container's git
                # config: some tasks are about git, and their verifiers read it.
                'HOME="$app" git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"; '
                'HOME="$app" npm ci --no-audit --no-fund --cache "$app/npm-cache"; '
                "node --version; git rev-parse HEAD"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        logs = self.environment_logs_dir.as_posix()
        model = self._parsed_model_name or self.model_name
        # The task goes in through the environment, not the command line, so no quoting can break it.
        var = f"MCC_INSTRUCTION_{uuid.uuid4().hex.upper()}"
        env = {
            **self.model_connection.env,
            var: instruction,
            "AGENT_SESSION_DIR": f"{logs}/sessions",
            "AGENT_OUTPUT_DIR": f"{logs}/tool-output",
            "AGENT_LOG_LEVEL": "warn",
        }
        if self._context_window:
            env["AGENT_CONTEXT_WINDOW"] = str(self._context_window)
        flags = [
            "--allow-all",  # a container with nobody to ask; the verifier decides what counted
            "--output-format", "stream-json",
            "--max-turns", str(self._max_turns),
        ]
        if model:
            flags += ["--model", str(model)]
        # Run in the task's own working directory, with node named by its path. The exit code goes to a
        # file rather than failing the command, and the last event (the result line) back to Harbor.
        command = (
            f'app="{APP}"; mkdir -p {logs}; '
            '"$app/node/bin/node" "$app/src/node_modules/tsx/dist/cli.mjs" "$app/src/cli/index.ts" '
            + f'-p "${var}" '
            + " ".join(shlex.quote(f) for f in flags)
            + f" > {logs}/events.jsonl 2> {logs}/stderr.txt; "
            + f"code=$?; echo $code > {logs}/exit_code.txt; tail -n 1 {logs}/events.jsonl; "
            + f"[ $code -eq 1 ] && tail -c 2000 {logs}/stderr.txt >&2; true"
        )
        result = await self.exec_as_agent(environment, command=command, env=env)
        # 0 finished and 2 stopped short: either way the verifier judges the work. 1 is a run that threw,
        # which in a headless run means the API failed after its retries: an error, like an API error
        # in the other harnesses, and Harbor's patterns say which kind (rate limit, overloaded, auth).
        last = _last_json(result.stdout)
        if last.get("type") == "result" and last.get("subtype") == "error_during_execution":
            detail = SimpleNamespace(return_code=1, stdout=str(last.get("error") or ""), stderr=result.stderr or "")
            raise self._classify_exec_error("mini-claude-code -p", detail)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Token counts and cost from the run's result line, when there is one."""
        try:
            lines = (self.logs_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        result = _last_json("\n".join(line for line in lines if '"type":"result"' in line))
        usage = result.get("usage") or {}
        if not usage:
            return
        cached = usage.get("cache_read_input_tokens") or 0
        written = usage.get("cache_creation_input_tokens") or 0
        # Harbor counts input tokens with the cached ones included, and cached ones again on their own.
        context.n_input_tokens = (usage.get("input_tokens") or 0) + written + cached
        context.n_cache_tokens = cached
        context.n_output_tokens = usage.get("output_tokens") or 0
        if result.get("total_cost_usd") is not None:  # null for a model with no price in utils/cost.ts
            context.cost_usd = result["total_cost_usd"]
        context.metadata = {"cache_creation_input_tokens": written, "stop_reason": result.get("stop_reason") or result.get("subtype")}


def _last_json(stdout: str | None) -> dict:
    for line in reversed((stdout or "").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        return value if isinstance(value, dict) else {}
    return {}
