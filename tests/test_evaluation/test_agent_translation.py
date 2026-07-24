"""Unit tests for the shared, language-neutral agent-translation core.

The real path shells out to the claude-code / codex CLI; these tests mock that
subprocess boundary so routing, workspace setup, and output handling are
verified without a live agent.
"""

import json
from pathlib import Path

from tla_eval.evaluation.semantics.agent_translation import (
    run_agent_translation,
    select_agent_cli,
)


def test_select_agent_cli_routing():
    for claude in ("sonnet", "opus", "haiku", "claude-opus-4-8", "", "default"):
        assert select_agent_cli(claude) == "claude"
    for codex in ("codex", "gpt-5", "o4-mini"):
        assert select_agent_cli(codex) == "codex"


def test_run_agent_translation_success(monkeypatch):
    async def fake_exec(workspace_path, model_name, agent_cli, timeout):
        ws = Path(workspace_path)
        # Instructions + caller-supplied files landed in the workspace.
        assert (ws / "CLAUDE.md").read_text() == "do it"
        assert (ws / "specification.tla").read_text() == "MODULE X"
        out = ws / "output" / "invariants.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text('{"invariants": []}', encoding="utf-8")
        return {"success": True}

    monkeypatch.setattr(
        "tla_eval.evaluation.semantics.agent_translation._execute_agent_cli", fake_exec
    )
    ok, content, err = run_agent_translation(
        instructions="do it",
        extra_files={"specification.tla": "MODULE X"},
        model_name="sonnet",
        timeout=5,
    )
    assert ok and err is None
    assert json.loads(content) == {"invariants": []}


def test_run_agent_translation_missing_output(monkeypatch):
    async def fake_exec(workspace_path, model_name, agent_cli, timeout):
        return {"success": True}  # reports success but writes nothing

    monkeypatch.setattr(
        "tla_eval.evaluation.semantics.agent_translation._execute_agent_cli", fake_exec
    )
    ok, content, err = run_agent_translation(
        instructions="x", extra_files={}, model_name="sonnet", timeout=5
    )
    assert not ok and content is None and "did not produce" in err


def test_run_agent_translation_cli_failure(monkeypatch):
    async def fake_exec(workspace_path, model_name, agent_cli, timeout):
        return {"success": False, "error": "CLI not found"}

    monkeypatch.setattr(
        "tla_eval.evaluation.semantics.agent_translation._execute_agent_cli", fake_exec
    )
    ok, content, err = run_agent_translation(
        instructions="x", extra_files={}, model_name="sonnet", timeout=5
    )
    assert not ok and content is None and err == "CLI not found"


def test_run_agent_translation_uses_codex_md(monkeypatch):
    async def fake_exec(workspace_path, model_name, agent_cli, timeout):
        ws = Path(workspace_path)
        assert agent_cli == "codex"
        assert (ws / "CODEX.md").exists() and not (ws / "CLAUDE.md").exists()
        out = ws / "output" / "invariants.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("{}", encoding="utf-8")
        return {"success": True}

    monkeypatch.setattr(
        "tla_eval.evaluation.semantics.agent_translation._execute_agent_cli", fake_exec
    )
    ok, _content, err = run_agent_translation(
        instructions="x", extra_files={}, model_name="codex", timeout=5
    )
    assert ok and err is None
