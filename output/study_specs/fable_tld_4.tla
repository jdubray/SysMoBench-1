---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

VARIABLES lockHeld, lockHolder

NONE == "none"

vars == <<lockHeld, lockHolder>>

Init ==
    /\ lockHeld = FALSE
    /\ lockHolder = NONE

TypeOK ==
    /\ lockHeld \in BOOLEAN
    /\ lockHolder \in (Threads \union {NONE})

\* AcquireLock models both `lock()` (busy-waits until the CAS succeeds) and
\* `try_lock()` (a single CAS attempt). The observable successful step is
\* identical for both: the CAS flips the lock from free to held. A failed
\* `try_lock()` is observable as a step that leaves the state unchanged.
AcquireLock(thread, callType) ==
    \/ /\ callType \in {"lock", "try"}
       /\ lockHeld = FALSE
       /\ lockHolder = NONE
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ /\ callType = "try"
       /\ lockHeld = TRUE
       /\ UNCHANGED <<lockHeld, lockHolder>>

\* ReleaseLock models `SpinLockGuard::drop` -> `release_lock`: the holder
\* stores FALSE, freeing the lock.
ReleaseLock(thread) ==
    /\ lockHeld = TRUE
    /\ lockHolder = thread
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next ==
    \E t \in Threads :
        \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
        \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>

====