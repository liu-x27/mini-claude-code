"""Checks for the Harbor integration: the ATIF conversion and the adapter.

    python -m unittest discover -s integrations/harbor -t . -p "test_*.py" -v

The adapter's own checks need Harbor installed and are skipped without it; the
workflow's preflight job runs all of them under the Harbor version it pins.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from integrations.harbor import atif

try:
    from harbor.models.trajectories import Trajectory

    HAVE_HARBOR = True
except ImportError:
    HAVE_HARBOR = False


def usage(i=0, o=0, cw=0, cr=0):
    return {"inputTokens": i, "outputTokens": o, "cacheCreationTokens": cw, "cacheReadTokens": cr, "estimatedCostUsd": None}


SESSION = [
    {"role": "user", "content": "Fix the failing test.\n\n<environment>cwd: /app</environment>"},
    {
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "Look first.", "signature": "s"},
            {"type": "text", "text": "Reading the test."},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "test.py"}},
            {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "pytest -q"}},
        ],
    },
    {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "def test(): assert f() == 2"},
            {"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "1 failed"}], "is_error": True},
        ],
    },
    {"role": "assistant", "content": [{"type": "text", "text": "Fixed: f returns 2."}]},
]


class AtifTest(unittest.TestCase):
    def convert(self, segments, turns):
        return atif.session_to_atif(
            segments,
            session_id="s-1",
            agent_version="abc123",
            model_name="MiniMax-M2.7",
            turns=turns,
            total={"input_tokens": 30, "output_tokens": 20, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 100},
        )

    def test_steps_calls_and_observations(self):
        turns = [atif._agent_usage(usage(10, 7, 5, 0)), atif._agent_usage(usage(20, 13, 0, 100))]
        traj = self.convert([SESSION], turns)
        self.assertEqual([s["source"] for s in traj["steps"]], ["user", "agent", "agent"])
        self.assertEqual([s["step_id"] for s in traj["steps"]], [1, 2, 3])
        first = traj["steps"][1]
        self.assertEqual(first["reasoning_content"], "Look first.")
        self.assertEqual([c["tool_call_id"] for c in first["tool_calls"]], ["t1", "t2"])
        results = first["observation"]["results"]
        self.assertEqual([r["source_call_id"] for r in results], ["t1", "t2"])
        self.assertEqual(results[1]["content"], "1 failed")
        self.assertEqual(results[1]["extra"], {"is_error": True})
        # Per-step prompt tokens count the cached ones too, as Harbor's do.
        self.assertEqual(traj["steps"][2]["metrics"]["prompt_tokens"], 120)
        self.assertEqual(traj["final_metrics"]["total_prompt_tokens"], 135)
        self.assertEqual(traj["final_metrics"]["total_cached_tokens"], 100)
        if HAVE_HARBOR:
            Trajectory.model_validate(traj)

    def test_turns_that_do_not_line_up_give_no_step_metrics(self):
        traj = self.convert([SESSION], [atif._agent_usage(usage(1, 1))])
        self.assertTrue(all("metrics" not in s for s in traj["steps"]))

    def test_a_turn_killed_while_its_tools_ran_still_lines_up(self):
        turns = [atif._agent_usage(usage(1, 1))] * 3  # two saved replies and the one that was cut
        traj = self.convert([SESSION], turns)
        self.assertEqual(sum(1 for s in traj["steps"] if "metrics" in s), 2)

    def test_compacted_history_comes_first(self):
        archived = SESSION[:3]
        live = [{"role": "user", "content": "Summary of the work so far."}, SESSION[3]]
        traj = self.convert([archived, live], [])
        self.assertEqual([s["source"] for s in traj["steps"]], ["user", "agent", "user", "agent"])
        self.assertEqual(traj["steps"][2]["extra"], {"compaction_summary": True})
        if HAVE_HARBOR:
            Trajectory.model_validate(traj)

    def test_segments_load_in_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "archive").mkdir()
            (root / "archive" / "s-1-200.json").write_text(json.dumps([{"role": "user", "content": "second"}]))
            (root / "archive" / "s-1-100.json").write_text(json.dumps([{"role": "user", "content": "first"}]))
            (root / "s-1.json").write_text(json.dumps({"metadata": {}, "messages": [{"role": "user", "content": "live"}]}))
            segments = atif.load_segments(root, "s-1")
        self.assertEqual([s[0]["content"] for s in segments], ["first", "second", "live"])

    def test_usage_from_the_result_line_or_the_turns(self):
        result = {"type": "result", "usage": {"input_tokens": 1, "output_tokens": 2, "cache_creation_input_tokens": 3, "cache_read_input_tokens": 4}}
        turn = {"type": "turn_end", "turn": 1, "usage": usage(10, 1, 0, 5)}
        sub = {"type": "subagent", "subagent": "general-purpose", "event": {"type": "turn_end", "turn": 1, "usage": usage(2, 1, 0, 0)}}
        total, source = atif.usage_from_events([turn, sub, result])
        self.assertEqual((total["input_tokens"], source), (1, "result"))
        total, source = atif.usage_from_events([turn, sub])
        self.assertEqual((total["input_tokens"], total["cache_read_input_tokens"]), (12, 5))
        self.assertNotEqual(source, "result")
        self.assertEqual(len(atif.turn_usages([turn, sub])), 1)


@unittest.skipUnless(HAVE_HARBOR, "Harbor is not installed")
class AdapterTest(unittest.TestCase):
    def make(self, logs: Path):
        from integrations.harbor.mini_claude_code import MiniClaudeCode

        return MiniClaudeCode(logs_dir=logs, model_name="anthropic/MiniMax-M2.7", ref="abc", max_turns=5, context_window=204800)

    def test_key_and_endpoint_come_from_the_harbor_process(self):
        env = {"ANTHROPIC_API_KEY": "not-a-real-key", "ANTHROPIC_BASE_URL": "https://example.invalid/anthropic"}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, env):
            agent = self.make(Path(tmp))
            self.assertEqual(agent.model_connection.env, env)
            self.assertEqual(agent.name(), "mini-claude-code")

    def test_run_command_and_an_api_error_raises(self):
        from harbor.agents.installed.base import ApiRateLimitError
        from harbor.models.agent.context import AgentContext

        calls = []

        class FakeEnvironment:
            default_user = None

            async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
                calls.append((command, env))
                line = {"type": "result", "subtype": "error_during_execution", "error": '429 {"type":"rate_limit_error"}'}
                return SimpleNamespace(return_code=0, stdout=json.dumps(line) + "\n", stderr="")

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "not-a-real-key"}):
            agent = self.make(Path(tmp))
            with self.assertRaises(ApiRateLimitError):
                asyncio.run(agent.run("Do the task", FakeEnvironment(), AgentContext()))
        command, env = calls[-1]
        self.assertIn("--max-turns 5", command)
        self.assertIn("--model MiniMax-M2.7", command)
        self.assertNotIn("Do the task", command)  # the instruction travels in the environment
        self.assertIn("Do the task", env.values())
        self.assertEqual(env["AGENT_CONTEXT_WINDOW"], "204800")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "not-a-real-key")

    def test_context_and_trajectory_after_a_run(self):
        from harbor.models.agent.context import AgentContext

        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp)
            (logs / "sessions").mkdir()
            (logs / "sessions" / "s-1.json").write_text(json.dumps({"metadata": {}, "messages": SESSION}))
            events = [
                {"type": "session", "sessionId": "s-1", "resumed": False},
                {"type": "turn_end", "turn": 1, "usage": usage(10, 7, 5, 0)},
                {"type": "turn_end", "turn": 2, "usage": usage(20, 13, 0, 100)},
                {"type": "result", "subtype": "success", "stop_reason": "end_turn", "session_id": "s-1", "num_turns": 2,
                 "usage": {"input_tokens": 30, "output_tokens": 20, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 100},
                 "total_cost_usd": None},
            ]
            (logs / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
            (logs / "exit_code.txt").write_text("0\n")
            context = AgentContext()
            self.make(logs).populate_context_post_run(context)
            self.assertEqual((context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens), (135, 100, 20))
            self.assertIsNone(context.cost_usd)
            self.assertEqual(context.metadata["stop_reason"], "end_turn")
            trajectory = Trajectory.model_validate_json((logs / "trajectory.json").read_text())
            self.assertEqual(len(trajectory.steps), 3)


if __name__ == "__main__":
    unittest.main()
