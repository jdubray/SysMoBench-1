---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

\* Acquire the lock. For both "lock" (blocking) and "try" (non-blocking),
\* a successful acquisition corresponds to the atomic compare_exchange
\* succeeding: it only happens when the lock is currently free. The
\* observable single-step effect is identical: the lock becomes held by
\* the acquiring thread.
AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ lockHeld = FALSE
    /\ lockHolder = NONE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* Release the lock (drop of the guard -> store(false, Release)).
\* Only the current holder can release.
ReleaseLock(thread) ==
    /\ lockHeld = TRUE
    /\ lockHolder = thread
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>

====