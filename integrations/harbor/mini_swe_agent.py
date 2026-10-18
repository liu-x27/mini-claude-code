"""Harbor's mini-swe-agent, with the one package its install now leaves out.

    harbor run ... -a integrations.harbor.mini_swe_agent:MiniSweAgent -m anthropic/<model>

Harbor 0.24.0 installs mini-swe-agent as `uv tool install mini-swe-agent --with
litellm --with orjson --with fastapi`, leaving out LiteLLM's proxy extra on
purpose (one of its packages has no Alpine build). The LiteLLM that resolves
to on 2026-10-18 imports the `mcp` package from its proxy code on the way to
a completion, so mini-swe-agent 2.4.6 exited at its first model call with
ModuleNotFoundError: No module named 'mcp'. terminus-2 was unaffected: it
runs on Harbor's own LiteLLM, whose environment has `mcp`.

This adds `mcp` to mini-swe-agent's tool environment after Harbor's install,
and checks it imports, so a later change of the same kind fails the setup
instead of every model call. Everything else, the name included, is Harbor's
agent unchanged.
"""

from __future__ import annotations

from harbor.agents.installed.mini_swe_agent import MiniSweAgent as HarborMiniSweAgent
from harbor.environments.base import BaseEnvironment


class MiniSweAgent(HarborMiniSweAgent):
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'if [ -f "$HOME/.local/bin/env" ]; then . "$HOME/.local/bin/env"; fi; '
                'export PATH="$HOME/.local/bin:$PATH"; '
                'python="$(uv tool dir)/mini-swe-agent/bin/python"; '
                'uv pip install --python "$python" mcp; '
                '"$python" -c "import mcp.types, litellm"'
            ),
        )
