---- MODULE spin ----
\* Reference constrained spin spec (correct + deterministic): the TLA+ analogue of
\* the lean JS next(). Each action's one-step image from any pinned pre-state is a
\* SINGLE observable post-state (branching factor 1). Used to validate the
\* functional/branching-factor Phase-3 check in scripts/tla_direct_tv.py.
EXTENDS Naturals

CONSTANT Threads
NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

AcquireLock(t, ct) ==
    IF ~lockHeld
      THEN lockHeld' = TRUE /\ lockHolder' = t
      ELSE UNCHANGED <<lockHeld, lockHolder>>

ReleaseLock(t) ==
    IF lockHolder = t
      THEN lockHeld' = FALSE /\ lockHolder' = NONE
      ELSE UNCHANGED <<lockHeld, lockHolder>>

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>
====
