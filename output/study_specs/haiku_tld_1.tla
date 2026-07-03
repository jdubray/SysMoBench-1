---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

\* AcquireLock models both lock() and try_lock() behavior
\* callType \in {"lock", "try"} distinguishes the two call paths
\* lock() spins until acquisition succeeds
\* try_lock() succeeds or fails immediately
AcquireLock(thread, callType) ==
    /\ lockHeld = FALSE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* ReleaseLock models the Drop impl of SpinLockGuard
\* Only the current holder can release
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