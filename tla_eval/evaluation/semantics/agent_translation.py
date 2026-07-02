"""Language-neutral agent-CLI invariant translation.

Runs an agent CLI (Claude Code or Codex) in a throwaway workspace to translate
invariant templates against a generated specification. This is the shared core
behind the agent-based translator: TLA+ has used it, and any other backend
(JS-SAM, Alloy, PAT) can reuse it instead of remapping to a single direct LLM
call. The workspace setup, CLI selection, subprocess execution, and output
reading live here; the *language-specific* pieces — the files written into the
workspace (spec + templates), the agent instructions, and the output parser —
are supplied by the caller.

The caller supplies `instructions` (written as CLAUDE.md or CODEX.md depending
on the selected CLI) and `extra_files` (e.g. the spec and templates), and
receives the raw text the agent wrote to `output_relpath` to parse itself.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)


def select_agent_cli(model_name: str) -> str:
    """Select the agent CLI from a model name.

    Claude Code aliases (and any ``claude*`` / empty name) route to the
    ``claude`` CLI; everything else uses ``codex``.
    """
    normalized = (model_name or "").strip().lower()
    claude_aliases = {"default", "sonnet", "haiku", "opus"}
    if not normalized or normalized in claude_aliases or normalized.startswith("claude"):
        return "claude"
    return "codex"


async def _execute_agent_cli(
    workspace_path: Path, model_name: str, agent_cli: str, timeout: int
) -> dict:
    """Execute the Claude Code or Codex CLI in the workspace directory."""
    if agent_cli == "codex":
        model = model_name if model_name and model_name not in {"default", "codex"} else ""
        cmd = [
            "codex",
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-c", 'model_reasoning_effort="high"',
        ]
        if model:
            cmd.extend(["-m", model])
        cmd.append("Read CODEX.md and complete the invariant translation task.")
    else:
        # The `claude` CLI accepts model codes (sonnet/opus/haiku) or full
        # model IDs (claude-*) — not SysMoBench aliases like "claude_opus_proxy",
        # which would yield "400 Unknown Model". Refuse anything else so callers
        # don't silently run against a different model than they configured.
        cli_model_codes = {"sonnet", "opus", "haiku"}
        if model_name in cli_model_codes or (model_name and model_name.startswith("claude-")):
            model = model_name
        else:
            return {
                "success": False,
                "error": (
                    f"Agent translator (claude CLI) needs a sonnet/opus/haiku "
                    f"code or a claude-* model ID; got {model_name!r}. Pass a "
                    f"valid code at the call site instead of relying on a fallback."
                ),
            }
        cmd = [
            "claude",
            "--print",
            "--dangerously-skip-permissions",
            "--model", model,
            "--output-format", "json",
            "Read CLAUDE.md and complete the invariant translation task.",
        ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workspace_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return {"success": False, "error": f"Timeout after {timeout} seconds"}

        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        return {
            "success": process.returncode == 0,
            "stdout": out,
            "stderr": err,
            "exit_code": process.returncode,
            # `claude --output-format json` writes its error payload to stdout
            # and leaves stderr empty; fall back to stdout so the reason is kept.
            "error": (err or out) if process.returncode != 0 else None,
        }
    except FileNotFoundError:
        return {
            "success": False,
            "error": "Codex CLI not found" if agent_cli == "codex" else "Claude Code CLI not found",
        }
    except Exception as e:  # pragma: no cover - defensive
        return {"success": False, "error": str(e)}


def run_agent_translation(
    *,
    instructions: str,
    extra_files: Dict[str, str],
    model_name: str,
    timeout: int,
    output_relpath: str = "output/invariants.json",
) -> Tuple[bool, Optional[str], Optional[str]]:
    """Run an agent CLI over a throwaway workspace and return its output text.

    Args:
        instructions: agent instructions, written as CLAUDE.md or CODEX.md
            depending on the selected CLI.
        extra_files: mapping of ``relative filename -> content`` written into the
            workspace (e.g. the spec and the templates listing).
        model_name: model/alias used to select and parameterize the CLI.
        timeout: per-run timeout in seconds.
        output_relpath: the path (relative to the workspace) the agent is asked
            to write; its text is returned for the caller to parse.

    Returns:
        ``(success, output_content, error)`` — exactly one of the latter two is
        set. ``output_content`` is the raw text at ``output_relpath``.
    """
    agent_cli = select_agent_cli(model_name)
    workspace_dir = Path(tempfile.mkdtemp(prefix="inv_translator_"))
    logger.info("Created agent workspace at: %s (cli=%s)", workspace_dir, agent_cli)
    try:
        for rel, content in extra_files.items():
            path = workspace_dir / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

        instruction_filename = "CODEX.md" if agent_cli == "codex" else "CLAUDE.md"
        (workspace_dir / instruction_filename).write_text(instructions, encoding="utf-8")

        output_path = workspace_dir / output_relpath
        output_path.parent.mkdir(parents=True, exist_ok=True)

        result = asyncio.run(_execute_agent_cli(workspace_dir, model_name, agent_cli, timeout))
        if not result["success"]:
            return False, None, result.get("error", "Agent execution failed")

        if not output_path.exists():
            return False, None, f"Agent did not produce output file: {output_relpath}"

        return True, output_path.read_text(encoding="utf-8"), None
    except Exception as e:
        logger.error("Agent translation failed: %s", e)
        return False, None, str(e)
    finally:
        shutil.rmtree(workspace_dir, ignore_errors=True)
