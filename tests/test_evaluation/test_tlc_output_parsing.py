"""TLC output parsing — states_explored must be DISTINCT states, not generated.

Regression for the Phase-2 metric audit: TLC prints
    "574 states generated, 159 distinct states found, 0 states left on queue."
and the parser used to capture the *generated* count (a work counter that
includes duplicate visits) as states_explored. The semantic state-space size is
the *distinct* count; generated stays available as a separate value.
"""

from tla_eval.evaluation.semantics.runtime_check import TLCRunner

TLC_TAIL = """\
Model checking completed. No error has been found.
  Estimates of the probability that TLC did not check all reachable states
  because two distinct states had the same fingerprint:
574 states generated, 159 distinct states found, 0 states left on queue.
Finished in 03s at (2026-07-01 21:39:47)
"""


def _runner() -> TLCRunner:
    return TLCRunner.__new__(TLCRunner)  # parse_tlc_output needs no runner state


class TestParseTlcStates:
    def test_states_explored_is_distinct_not_generated(self):
        violations, deadlock, states = _runner().parse_tlc_output(TLC_TAIL)
        assert violations == []
        assert deadlock is False
        assert states == 159  # distinct states found — NOT the 574 generated

    def test_falls_back_to_generated_when_no_distinct_line(self):
        out = "12 states generated.\nFinished in 00s"
        _v, _d, states = _runner().parse_tlc_output(out)
        assert states == 12
