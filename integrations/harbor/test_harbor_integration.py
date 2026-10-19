"""Checks for the Harbor integration: the ATIF conversion, the matrix, the scrub, the summary, and the adapter.

    python -m unittest discover -s integrations/harbor -t . -p "test_*.py" -v

The adapter's own checks need Harbor installed and are skipped without it; the
workflow's preflight job runs all of them under the Harbor version it pins.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from integrations.harbor import atif, summarize

HERE = Path(__file__).resolve().parent

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


class ScriptsTest(unittest.TestCase):
    def test_plan_expands_agents_tasks_and_attempts(self):
        registry = [
            {"name": "terminal-bench", "version": "2.0", "tasks": [{"name": n} for n in ("a", "b", "c")]},
            {"name": "terminal-bench-sample", "version": "2.0", "tasks": [{"name": "b"}]},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registry.json"
            path.write_text(json.dumps(registry))
            run = lambda *a: subprocess.run(
                [sys.executable, str(HERE / "plan.py"), "--registry-url", path.as_uri(), *a],
                capture_output=True, text=True,
            )
            done = run("--agents", "oracle, terminus-2", "--tasks", "sample", "--attempts", "2")
            self.assertEqual(done.returncode, 0, done.stderr)
            ids = [m["id"] for m in json.loads(done.stdout)]
            self.assertEqual(ids, ["oracle__b__1", "terminus-2__b__1", "oracle__b__2", "terminus-2__b__2"])
            # Task by task, every agent's trial of a task together, so a run cut short loses whole tasks.
            done = run("--agents", "mini-claude-code,claude-code", "--tasks", "a c")
            ids = [m["id"] for m in json.loads(done.stdout)]
            self.assertEqual(ids, ["mini-claude-code__a__1", "claude-code__a__1", "mini-claude-code__c__1", "claude-code__c__1"])
            self.assertNotEqual(run("--agents", "oracle", "--tasks", "a nope").returncode, 0)
            self.assertNotEqual(run("--agents", "codex", "--tasks", "all").returncode, 0)

    def test_scrub_redacts_text_and_deletes_binaries(self):
        secret = "sk-api-THIS-IS-NOT-A-REAL-KEY-0123456789"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "agent").mkdir()
            (root / "agent" / "events.jsonl").write_text(f'{{"output": "ANTHROPIC_API_KEY={secret}"}}\n')
            (root / "agent" / "blob.bin").write_bytes(b"\xff\xfe" + secret.encode())
            (root / "clean.txt").write_text("nothing here")
            outside = Path(tmp + "-outside")
            outside.write_text("a file of the runner")
            try:
                (root / "agent" / "link").symlink_to(outside)
                linked = True
            except OSError:  # Windows without the right to make symbolic links
                linked = False
            done = subprocess.run(
                [sys.executable, str(HERE / "scrub.py"), str(root)],
                capture_output=True, text=True, env={**os.environ, "SECRET": secret},
            )
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertNotIn(secret, done.stdout + done.stderr)
            self.assertIn("[REDACTED]", (root / "agent" / "events.jsonl").read_text())
            self.assertFalse((root / "agent" / "blob.bin").exists())
            self.assertEqual((root / "clean.txt").read_text(), "nothing here")
            if linked:
                self.assertFalse((root / "agent" / "link").is_symlink())
                self.assertTrue(outside.exists())  # the link goes, not what it named
            outside.unlink()

    def test_scrub_takes_every_key_it_is_given(self):
        one, two = "sk-api-NOT-A-REAL-KEY-aaaaaaaaaa", "sk-NOT-A-REAL-KEY-bbbbbbbbbb"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "log.txt").write_text(f"first {one} second {two}\n")
            done = subprocess.run(
                [sys.executable, str(HERE / "scrub.py"), str(root)],
                capture_output=True, text=True, env={**os.environ, "SECRET": one, "SECRET_2": two},
            )
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual((root / "log.txt").read_text(), "first [REDACTED] second [REDACTED]\n")

    def test_deepseek_peak_hours_cost_double(self):
        # 2026-10-19 is a Monday: 02:00 UTC is 10:00 in Beijing (peak), 04:30 UTC is 12:30 (off-peak).
        self.assertEqual(summarize.peak_factor("2026-10-19T02:00:00Z", "deepseek"), 2.0)
        self.assertEqual(summarize.peak_factor("2026-10-19T04:30:00+00:00", "deepseek"), 1.0)
        self.assertEqual(summarize.peak_factor("2026-10-18T02:00:00Z", "deepseek"), 1.0)  # a Sunday
        self.assertEqual(summarize.peak_factor("2026-10-19T02:00:00Z", "none"), 1.0)

    def test_summary_scores_by_task_and_names_what_is_missing(self):
        def trial(job, agent, task, reward, exception=None, tokens=(1000, 800, 50)):
            return {
                "trial_name": f"{task}__x", "task_name": task, "agent_info": {"name": agent, "version": "1"},
                "verifier_result": {"rewards": {"reward": reward}},
                "exception_info": {"exception_type": exception} if exception else None,
                "agent_result": {"n_input_tokens": tokens[0], "n_cache_tokens": tokens[1], "n_output_tokens": tokens[2]},
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for job, agent, task, reward, exc in [
                ("terminus-2__a__1", "terminus-2", "a", 1, None),
                ("terminus-2__a__2", "terminus-2", "a", 0, "AgentTimeoutError"),
                ("terminus-2__b__1", "terminus-2", "b", 0, None),
                ("mini-claude-code__a__1", "mini-claude-code", "a", 1, None),
                ("mini-claude-code__b__1", "mini-claude-code", "b", 1, "ApiRateLimitError"),
            ]:
                (root / job / "t").mkdir(parents=True)
                (root / job / "t" / "result.json").write_text(json.dumps(trial(job, agent, task, reward, exc)))
            (root / "terminus-2__b__1" / "t" / "verifier").mkdir()
            (root / "terminus-2__b__1" / "t" / "verifier" / "test-stdout.txt").write_text("collected 2\nFAILED test_output\n")
            (root / "terminus-2__a__1" / "result.json").write_text(json.dumps({"n_total_trials": 1}))
            trials = summarize.load_trials(root)
            self.assertEqual(len(trials), 5)
            markdown, data = summarize.summarize(trials, (2.1, 8.4, 0.42, 2.625), "CNY")
            # terminus-2: task a 1/2, task b 0/1 -> mean over tasks 25%.
            self.assertAlmostEqual(data["agents"]["terminus-2"]["score"], 0.25)
            self.assertEqual(data["agents"]["mini-claude-code"]["categories"], {"passed": 1, "passed, with ApiRateLimitError": 1})
            # 1000 input tokens of which 800 cached: 200 at the input price.
            self.assertAlmostEqual(trials[0]["est_cost"], (200 * 2.1 + 800 * 0.42 + 50 * 8.4) / 1e6)
            self.assertIn("| a | 1/1 | 1/2 T |", markdown)
            self.assertIn("| b | 1/1 E | 0/1 |", markdown)
            # Why a trial failed is on the summary page, not only in the artifact.
            self.assertIn("terminus-2__b__1: failed: finished, tests fail", markdown)
            self.assertIn("FAILED test_output", markdown)
            # A failed command's message is the command and then its output: the output is what is shown.
            text = summarize._exception_text("Command failed (exit 1): mini-swe-agent --task='a long task'\nstdout: litellm.BadRequestError: 400\nstderr: None")
            self.assertTrue(text.startswith("Command failed (exit 1)"))
            self.assertIn("stdout: litellm.BadRequestError: 400", text)
            # An install-only trial that installed is not an error, and has nothing to explain.
            installed = summarize._row({**trial("j", "terminus-2", "a", None), "verifier_result": None,
                                        "config": {"verifier": {"disable": True}}}, job="terminus-2__a__1")
            self.assertEqual(installed["category"], "installed (install-only run)")
            planned = Path(tmp) / "planned.json"
            planned.write_text(json.dumps([{"id": "terminus-2__a__1"}, {"id": "terminus-2__c__1"}]))
            done = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), str(root), "--expect", str(planned)],
                capture_output=True, text=True,
            )
            self.assertEqual(done.returncode, 1)
            self.assertIn("terminus-2__c__1", done.stdout)


@unittest.skipUnless(HAVE_HARBOR, "Harbor is not installed")
class AdapterTest(unittest.TestCase):
    def make(self, logs: Path):
        from integrations.harbor.mini_claude_code import MiniClaudeCode

        return MiniClaudeCode(logs_dir=logs, model_name="anthropic/MiniMax-M2.7", ref="abc", max_turns=5, context_window=204800)

    def test_mini_swe_agent_is_harbors_with_one_more_install_step(self):
        from harbor.agents.installed.mini_swe_agent import MiniSweAgent as HarborMiniSweAgent

        from integrations.harbor.mini_swe_agent import MiniSweAgent

        calls = []

        async def fake_super_install(self, environment):
            calls.append("harbor")

        async def fake_exec(self, environment, command, **kwargs):
            calls.append(command)

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(HarborMiniSweAgent, "install", fake_super_install), \
                mock.patch.object(MiniSweAgent, "exec_as_agent", fake_exec):
            agent = MiniSweAgent(logs_dir=Path(tmp), model_name="anthropic/deepseek-flash")
            self.assertEqual(agent.name(), HarborMiniSweAgent.name())
            asyncio.run(agent.install(object()))
        self.assertEqual(calls[0], "harbor")
        self.assertIn("uv pip install", calls[1])
        self.assertIn("import mcp.types, litellm", calls[1])

    def test_mini_swe_agent_runs_in_its_text_based_mode(self):
        from harbor.models.agent.context import AgentContext

        from integrations.harbor.mini_swe_agent import MiniSweAgent

        commands = []

        class FakeEnvironment:
            default_user = None

            async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
                commands.append(command)
                return SimpleNamespace(return_code=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "not-a-real-key"}):
            agent = MiniSweAgent(logs_dir=Path(tmp), model_name="anthropic/deepseek-flash")
            asyncio.run(agent.run("Do the task", FakeEnvironment(), AgentContext()))
        run = next(c for c in commands if "mini-swe-agent --yolo" in c)
        self.assertIn(" -c mini_textbased -c model.model_class=litellm_textbased ", run)
        self.assertNotIn(" -c mini ", run)

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
        self.assertNotIn("AGENT_THINKING", env)  # no kwarg: the harness's own default

    def test_thinking_goes_through_the_environment_and_a_misspelt_one_fails_first(self):
        from harbor.models.agent.context import AgentContext

        from integrations.harbor.mini_claude_code import MiniClaudeCode

        envs = []

        class FakeEnvironment:
            default_user = None

            async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
                envs.append(env)
                line = {"type": "result", "subtype": "success"}
                return SimpleNamespace(return_code=0, stdout=json.dumps(line) + "\n", stderr="")

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "not-a-real-key"}):
            agent = MiniClaudeCode(logs_dir=Path(tmp), model_name="anthropic/deepseek-flash", thinking="Omit")
            asyncio.run(agent.run("Do the task", FakeEnvironment(), AgentContext()))
            self.assertEqual(envs[-1]["AGENT_THINKING"], "omit")
            with self.assertRaises(ValueError):
                MiniClaudeCode(logs_dir=Path(tmp), model_name="anthropic/deepseek-flash", thinking="omitted")

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
