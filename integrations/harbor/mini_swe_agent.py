"""Harbor's mini-swe-agent in its text-based mode, with the one package its install now leaves out.

    harbor run ... -a integrations.harbor.mini_swe_agent:MiniSweAgent -m anthropic/<model>

Two things stood between Harbor 0.24.0's mini-swe-agent and DeepSeek's
Anthropic-compatible endpoint on 2026-10-18, both found by running it:

- Harbor installs it as `uv tool install mini-swe-agent --with litellm --with
  orjson --with fastapi`, leaving LiteLLM's proxy extra out on purpose (one of
  its packages has no Alpine build). The LiteLLM that resolves to imports the
  `mcp` package from its proxy code on the way to a completion, so
  mini-swe-agent 2.4.6 exited at its first model call with
  ModuleNotFoundError: No module named 'mcp'. terminus-2 was unaffected: it
  runs on Harbor's own LiteLLM, whose environment has `mcp`.
- In its default tool-calling mode it sends LiteLLM's Anthropic form of its
  bash tool, which now carries "type": "custom", and DeepSeek rejects the
  request: tools[0]: unknown variant `custom`. The Anthropic SDK that this
  harness uses leaves the field out.

So `mcp` goes into the tool's environment after Harbor's install, with an
import check that fails the setup rather than every model call; and the run
uses mini-swe-agent's own other built-in configuration, mini_textbased, with
its text-based model class: the command comes back in a fenced block, and no
tools field is sent at all. Everything else, the name included, is Harbor's
agent unchanged.
"""

from __future__ import annotations

from harbor.agents.installed.mini_swe_agent import MiniSweAgent as HarborMiniSweAgent
from harbor.environments.base import BaseEnvironment

# Harbor's run command starts the spec list with mini-swe-agent's builtin `mini` config.
TOOL_CALLING = " -c mini "
TEXT_BASED = " -c mini_textbased -c model.model_class=litellm_textbased "


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

    async def exec_as_agent(self, environment: BaseEnvironment, command: str, **kwargs):
        if "mini-swe-agent --yolo" in command:
            if TOOL_CALLING not in command:
                raise RuntimeError("Harbor's mini-swe-agent command no longer starts its specs with `-c mini`")
            command = command.replace(TOOL_CALLING, TEXT_BASED, 1)
        return await super().exec_as_agent(environment, command=command, **kwargs)
