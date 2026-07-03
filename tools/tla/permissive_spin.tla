---- MODULE spin ----
\* PERMISSIVE negative control: a spec that passes the EXISTENTIAL Phase-3 replay
\* on windows it should not, because its AcquireLock is over-permissive — it sets
\* the holder to ANY thread, not the acquiring one. From a pinned pre-state the
\* action can therefore reach several observable post-states, one of which is the
\* trace post, so the existential check ("post is reachable") passes while the
\* branching factor is 2, not 1. This is the control the review asked for: the
\* replay failing a no-op (unreachable post) does NOT prove it fails a permissive
\* spec (post reachable among several). The functional check (branching factor
\* must be 1) rejects the over-permissive AcquireLock windows.
\*
\* (Kept type-clean: the maximally-permissive form lockHolder' \in Threads ∪ {NONE}
\* makes TLC throw on comparing the string sentinel with an integer thread id — so
\* over-permissiveness that MIXES the holder's types is caught as unscoreable, not
\* a false pass. The dangerous case is over-permissiveness WITHIN a type, below.)
EXTENDS Naturals

CONSTANT Threads
NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

\* Over-permissive: on acquire the lock is taken by SOME thread, not necessarily t.
AcquireLock(t, ct) ==
    /\ lockHeld' = TRUE
    /\ lockHolder' \in Threads

\* Release kept correct + deterministic (so release windows stay scoreable).
ReleaseLock(t) ==
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>
====
