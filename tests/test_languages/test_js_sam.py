"""
JS-SAM backend tests.

Integration-style: they exercise the real Node helper (tools/js-sam/cli.mjs)
against the fixtures in tests/fixtures/js_sam/. Skipped when Node or the
helper's node_modules are unavailable.
"""

import json
import shutil
from pathlib import Path

import pytest

from tla_eval.languages import get
from tla_eval.languages.base import InvariantTemplate
from tla_eval.languages.js_sam import (
    HELPER_NODE_MODULES,
    JsSamBackend,
    _parse_js_sam_translations,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PROJECT_ROOT / "tests" / "fixtures" / "js_sam"
SPECS = FIXTURES / "specs"

node_required = pytest.mark.skipif(
    shutil.which("node") is None or not HELPER_NODE_MODULES.exists(),
    reason="Node.js or the JS-SAM helper dependencies are not installed",
)


@pytest.fixture()
def backend():
    return get("js-sam")


class TestRegistration:
    def test_registry_resolution(self):
        backend = get("js-sam")
        assert backend.name == "JS-SAM"
        assert get("JS-SAM") is backend
        assert get("SAM") is backend
        assert get("jssam") is backend

    def test_identity_fields(self):
        backend = get("js-sam")
        assert backend.fence_label == "javascript"
        assert backend.spec_extension == ".js"
        assert backend.config_fence_label is None
        assert backend.supports_direct_transition_validation is True

    def test_extract_artifacts_accepts_js_and_javascript_fences(self):
        backend = get("js-sam")
        body = "module.exports = {};"
        for label in ("javascript", "js"):
            artifacts = backend.extract_artifacts(f"text\n```{label}\n{body}\n```\ntail")
            assert artifacts.spec == body
            assert artifacts.config is None


@node_required
class TestCheckAvailable:
    def test_tools_ready(self, backend):
        assert backend.check_available() is None


@node_required
class TestPhase1Syntax:
    def _validate(self, backend, fixture, tmp_path):
        spec = (SPECS / fixture).read_text(encoding="utf-8")
        return backend.validate_syntax(spec, None, tmp_path, timeout=60)

    def test_good_spec_passes(self, backend, tmp_path):
        outcome = self._validate(backend, "spin-good.js", tmp_path)
        assert outcome.success, outcome.raw_output
        assert outcome.syntax_errors == []
        assert outcome.semantic_errors == []

    def test_syntax_error_reported_as_syntax(self, backend, tmp_path):
        outcome = self._validate(backend, "spin-syntax-error.js", tmp_path)
        assert not outcome.success
        assert outcome.syntax_errors
        assert outcome.semantic_errors == []

    def test_import_throw_reported_as_semantic(self, backend, tmp_path):
        outcome = self._validate(backend, "spin-load-error.js", tmp_path)
        assert not outcome.success
        assert outcome.syntax_errors == []
        assert any("failed to load" in e for e in outcome.semantic_errors)

    def test_contract_violations_reported(self, backend, tmp_path):
        outcome = self._validate(backend, "spin-missing-export.js", tmp_path)
        assert not outcome.success
        joined = " ".join(outcome.semantic_errors)
        assert "setState" in joined
        assert "checkerIntents" in joined


@node_required
class TestPhase2ModelCheck:
    def test_good_spec_explores_cleanly(self, backend, tmp_path):
        outcome = backend.run_model_checker(SPECS / "spin-good.js", None, tmp_path, timeout=300)
        assert outcome.success, outcome.error_message
        assert outcome.classification is None

    def test_throwing_acceptor_is_runtime_error(self, backend, tmp_path):
        outcome = backend.run_model_checker(SPECS / "spin-throwing.js", None, tmp_path, timeout=300)
        assert not outcome.success
        assert outcome.classification == "runtime_error"
        assert "release by non-holder" in outcome.error_message

    def test_distinct_states_are_semantic_not_combinatorial(self, backend, tmp_path):
        """Regression for the Phase-2 metric audit: the checker's step count is
        combinatorial — the same intent-permutation tree for ANY spec honoring the
        intent-domain contract — so it is model-independent and says nothing about
        the spec. states_explored must instead report distinct semantic states,
        which differ between a correct spec and one whose release is a no-op."""
        good = backend.run_model_checker(SPECS / "spin-good.js", None, tmp_path / "g", timeout=300)
        broken = backend.run_model_checker(SPECS / "spin-neverrelease.js", None, tmp_path / "b", timeout=300)
        assert good.success, good.error_message
        assert broken.success, broken.error_message  # never-releasing is wrong, not crashing
        g = json.loads(good.raw_output)
        b = json.loads(broken.raw_output)
        # Identical work done: same intent domain, same depth => same step count...
        assert g["stepsExplored"] == b["stepsExplored"]
        # ...but the semantic state spaces differ, and that is what the outcome reports.
        assert good.states_explored != broken.states_explored
        assert 0 < good.states_explored < g["stepsExplored"]
        # The never-release spec strands the lock: strictly fewer reachable states.
        assert broken.states_explored < good.states_explored


@node_required
class TestPhase3Transitions:
    PRE_FREE = {
        "lockHeld": False, "lockHolder": None,
        "threadStatus": {"0": "idle", "1": "idle"},
        "callType": {"0": None, "1": None},
    }
    POST_HELD_0 = {
        "lockHeld": True, "lockHolder": 0,
        "threadStatus": {"0": "locked", "1": "idle"},
        "callType": {"0": None, "1": None},
    }

    def _windows(self):
        return [
            (
                {"name": "AcquireLock", "data": {"thread": 0, "callType": "lock"}},
                self.PRE_FREE,
                self.POST_HELD_0,
            ),
            (
                {"name": "ReleaseLock", "data": {"thread": 0}},
                self.POST_HELD_0,
                self.PRE_FREE,
            ),
        ]

    def test_good_spec_passes_all_windows(self, backend, tmp_path):
        outcome = backend.validate_transitions(
            SPECS / "spin-good.js", self._windows(), tmp_path, timeout=120
        )
        assert outcome.error_message is None
        assert outcome.total_windows == 2
        assert outcome.total_passed == 2
        assert outcome.per_action_pass_rates == {"AcquireLock": 1.0, "ReleaseLock": 1.0}

    def test_buggy_release_fails_only_release_windows(self, backend, tmp_path):
        outcome = backend.validate_transitions(
            SPECS / "spin-bad-release.js", self._windows(), tmp_path, timeout=120
        )
        assert outcome.error_message is None
        assert outcome.per_action_pass_rates["AcquireLock"] == 1.0
        assert outcome.per_action_pass_rates["ReleaseLock"] == 0.0
        failures = json.loads((tmp_path / "transition_failures.json").read_text(encoding="utf-8"))
        assert any(f["action"] == "ReleaseLock" for f in failures)

    def test_unknown_action_counts_as_failed_window(self, backend, tmp_path):
        windows = [("NotAnAction", self.PRE_FREE, self.PRE_FREE)]
        outcome = backend.validate_transitions(
            SPECS / "spin-good.js", windows, tmp_path, timeout=120
        )
        assert outcome.total_windows == 1
        assert outcome.total_passed == 0
        assert outcome.per_action_pass_rates["NotAnAction"] == 0.0

    def test_empty_windows_is_an_error(self, backend, tmp_path):
        outcome = backend.validate_transitions(SPECS / "spin-good.js", [], tmp_path, timeout=120)
        assert outcome.error_message


@node_required
class TestPhase4Invariants:
    def _templates(self):
        return [
            InvariantTemplate(
                name="MutualExclusion", type="safety",
                natural_language="At most one thread holds the lock",
                formal_description="", example="",
            ),
            InvariantTemplate(
                name="AlwaysFree", type="safety",
                natural_language="The lock is never held (deliberately false)",
                formal_description="", example="",
            ),
        ]

    def test_check_invariants_pass_and_fail(self, backend, tmp_path):
        translated = {
            "MutualExclusion":
                "(state) => Object.values(state.threadStatus || {})"
                ".filter((s) => s === 'locked').length <= 1",
            "AlwaysFree": "(state) => state.lockHeld === false",
        }
        outcome = backend.check_invariants(
            SPECS / "spin-good.js", None, self._templates(), translated, tmp_path, timeout=300
        )
        by_name = {c.name: c for c in outcome.cases}
        assert by_name["MutualExclusion"].success, by_name["MutualExclusion"].error_message
        assert not by_name["AlwaysFree"].success
        assert by_name["AlwaysFree"].metadata.get("counterexample")

    def test_missing_translation_is_a_failure_case(self, backend, tmp_path):
        outcome = backend.check_invariants(
            SPECS / "spin-good.js", None, self._templates()[:1], {}, tmp_path, timeout=120
        )
        assert len(outcome.cases) == 1
        assert not outcome.cases[0].success
        assert "No translated invariant" in outcome.cases[0].error_message

    def test_safety_only_phase4_passes_a_never_releasing_lock(self, backend, tmp_path):
        """CHARACTERIZATION of a documented weakness, not desired behavior: the
        shipped Phase-4 invariant set is safety-only, and a never-releasing lock
        satisfies every one of them BECAUSE it is broken (mutual exclusion holds
        trivially when the lock never changes hands). Phase 4 as implemented
        cannot fail this defect class in principle; the discriminating
        properties are liveness, which the bounded checker does not verify.
        If this test ever fails, Phase 4 gained a real capability — update
        docs/js_sam_vs_tla_comparison.md accordingly."""
        import yaml
        tpl_file = PROJECT_ROOT / "data" / "js_sam_invariant_templates" / "spin" / "invariants.yaml"
        tpl = yaml.safe_load(tpl_file.read_text(encoding="utf-8"))
        templates = [
            InvariantTemplate(
                name=i["name"], type=i["type"],
                natural_language=i["natural_language"],
                formal_description=i["formal_description"],
                example=i["javascript_example"],
            )
            for i in tpl["invariants"]
        ]
        translated = {i["name"]: i["javascript_example"].strip() for i in tpl["invariants"]}
        outcome = backend.check_invariants(
            SPECS / "spin-neverrelease.js", None, templates, translated, tmp_path, timeout=300
        )
        assert all(c.success for c in outcome.cases), (
            "Phase 4 unexpectedly FAILED the never-releasing lock — the "
            "safety-only weakness may have been fixed; update the docs."
        )
        assert len(outcome.cases) == 3


class TestTranslationParsing:
    def _templates(self):
        return [
            InvariantTemplate(
                name="MutualExclusion", type="safety",
                natural_language="", formal_description="", example="",
            ),
        ]

    def test_parses_plain_json(self):
        text = json.dumps({
            "invariants": [{"name": "MutualExclusion", "predicate": "(state) => true"}]
        })
        out = _parse_js_sam_translations(text, self._templates())
        assert out == {"MutualExclusion": "(state) => true"}

    def test_parses_fenced_json_and_case_insensitive_names(self):
        text = '```json\n{"invariants": [{"name": "mutualexclusion", "predicate": "(s) => true"}]}\n```'
        out = _parse_js_sam_translations(text, self._templates())
        assert out == {"MutualExclusion": "(s) => true"}

    def test_rejects_garbage(self):
        assert _parse_js_sam_translations("not json", self._templates()) == {}
        assert _parse_js_sam_translations('{"foo": 1}', self._templates()) == {}

    def test_unknown_translator_unsupported(self):
        backend = JsSamBackend()
        # An explicit unknown model name is forwarded to the model registry,
        # which fails as "not configured" — exercised via the error return.
        translated, error = backend.translate_invariants(
            self._templates(), "module.exports = {}", "spin",
            translator="definitely-not-a-model",
        )
        assert translated == {}
        assert error

    def test_agent_translator_routes_to_shared_core(self):
        # claude-code / codex route through the shared agent_translation core
        # instead of the direct API call. Mock the core (no CLI required).
        from unittest import mock

        backend = JsSamBackend()
        captured = {}

        def fake_run(**kwargs):
            captured.update(kwargs)
            return (
                True,
                '{"invariants":[{"name":"MutualExclusion","predicate":"(s)=>true"}]}',
                None,
            )

        with mock.patch(
            "tla_eval.evaluation.semantics.agent_translation.run_agent_translation",
            side_effect=fake_run,
        ):
            translated, error = backend.translate_invariants(
                self._templates(), "module.exports = {}", "spin",
                translator="claude-code",
            )
        assert error is None
        assert translated == {"MutualExclusion": "(s)=>true"}
        # It fed the generated spec to the agent and picked the claude CLI code.
        assert "specification.js" in captured["extra_files"]
        assert captured["model_name"] == "sonnet"
