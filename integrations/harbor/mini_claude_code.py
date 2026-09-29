"""mini-claude-code as a Harbor installed agent, for Terminal-Bench and the other Harbor datasets.

    harbor run -d terminal-bench@2.0 \\
        -a integrations.harbor.mini_claude_code:MiniClaudeCode \\
        -m anthropic/claude-opus-5-5 \\
        --agent-env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

Any endpoint that speaks the Messages API works the same way: add
--agent-env ANTHROPIC_BASE_URL=... and name its model with -m (MiniMax and
DeepSeek both serve one). --agent-kwarg ref=<branch or tag> picks the version
of this repository to install, and --agent-kwarg max_turns=<n> the turn limit
(default 100; the CLI's own default of 20 is too few for these tasks).

The comparison worth running is the same model three ways: this harness,
Harbor's own terminus-2, and mini-swe-agent. On Terminal-Bench 2.0 the
harness alone has moved one model by 18 points, and its 95% intervals are
about +/-2-3 points, which says how many tasks a difference needs.

Status: written on 2026-09-29 against Harbor's documented BaseInstalledAgent
interface and its Claude Code adapter, and not yet run. The machine it was
written on has no Docker, and Harbor runs every task in a container. It
installs from GitHub, so what it runs is whatever `ref` names there.
"""

from __future__ import annotations

import json
import shlex
import uuid

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = "https://github.com/liu-x27/mini-claude-code.git"
HOME_DIR = "$HOME/mini-claude-code"
# path.matchesGlob, used by the permission rules, needs Node 22 or later.
NODE = (
    'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
)


class MiniClaudeCode(BaseInstalledAgent):
    def __init__(self, *args, ref: str = "main", repo: str = REPO, max_turns: int | str = 100, **kwargs):
        super().__init__(*args, **kwargs)
        self._ref = str(ref)
        self._repo = str(repo)
        self._max_turns = int(max_turns)

    @staticmethod
    def name() -> str:
        return "mini-claude-code"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("git", "curl", "bash"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                + NODE
                + 'major=$(node -p "process.versions.node.split(\'.\')[0]" 2>/dev/null || echo 0); '
                'if [ "$major" -lt 22 ]; then '
                "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; "
                '  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24; '
                "fi; "
                f"rm -rf {HOME_DIR}; "
                f"git clone --depth 1 --branch {shlex.quote(self._ref)} {shlex.quote(self._repo)} {HOME_DIR}; "
                f"cd {HOME_DIR} && npm ci --no-audit --no-fund && node --version"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        logs = self.environment_logs_dir.as_posix()
        model = getattr(self, "_parsed_model_name", None) or self.model_name
        # The task goes in through the environment, not the command line, so no quoting can break it.
        var = f"MCC_INSTRUCTION_{uuid.uuid4().hex.upper()}"
        env = {
            var: instruction,
            "AGENT_SESSION_DIR": f"{logs}/sessions",
            "AGENT_OUTPUT_DIR": f"{logs}/tool-output",
            "AGENT_LOG_LEVEL": "warn",
        }
        flags = [
            "--allow-all",  # a container with nobody to ask; the verifier decides what counted
            "--output-format", "stream-json",
            "--max-turns", str(self._max_turns),
        ]
        if model:
            flags += ["--model", str(model)]
        # Run in the task's own working directory. The exit code goes to a file rather than failing
        # the trial: 2 means the run stopped short (turn limit, stuck), which the verifier should judge.
        await self.exec_as_agent(
            environment,
            command=(
                NODE
                + f"mkdir -p {logs}; "
                + f"node {HOME_DIR}/node_modules/tsx/dist/cli.mjs {HOME_DIR}/cli/index.ts "
                + f'-p "${var}" '
                + " ".join(shlex.quote(f) for f in flags)
                + f" > {logs}/events.jsonl 2> {logs}/stderr.txt; "
                + f"echo $? > {logs}/exit_code.txt; true"
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Token counts and cost from the run's result line, when there is one."""
        try:
            lines = (self.logs_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "result":
                continue
            usage = event.get("usage") or {}
            context.n_input_tokens = (usage.get("input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
            context.n_cache_tokens = usage.get("cache_read_input_tokens") or 0
            context.n_output_tokens = usage.get("output_tokens") or 0
            if event.get("total_cost_usd") is not None:
                context.cost_usd = event["total_cost_usd"]
            return
