---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

vars == <<lockHeld, lockHolder>>

Init == lockHeld = FALSE /\ lockHolder = NONE

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

\* Models compare_exchange(false -> true). On success the caller becomes the
\* holder. For callType "lock" (busy-wait) and "try" (one-shot), the observable
\* single-step effect of a *successful* acquisition is identical: the lock must
\* be free beforehand, and afterwards it is held by the acquiring thread.
AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ lockHeld = FALSE
    /\ lockHolder = NONE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* Models release_lock: store(false). Only the current holder releases.
ReleaseLock(thread) ==
    /\ lockHeld = TRUE
    /\ lockHolder = thread
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_vars

====