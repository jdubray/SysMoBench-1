---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

VARIABLES lockHeld, lockHolder

NONE == "none"

vars == <<lockHeld, lockHolder>>

TypeOK ==
    /\ lockHeld \in BOOLEAN
    /\ lockHolder \in (Threads \union {NONE})

Init ==
    /\ lockHeld = FALSE
    /\ lockHolder = NONE

\* Acquiring the lock: both `lock()` (busy-wait until CAS succeeds) and
\* `try_lock()` (single CAS attempt) change the observable state only at
\* the moment the compare_exchange(false, true) succeeds, which requires
\* the lock to be free. A failed `try_lock()` leaves the state unchanged.
AcquireLock(thread, callType) ==
    \/ /\ lockHeld = FALSE
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ /\ callType = "try"
       /\ lockHeld = TRUE
       /\ UNCHANGED <<lockHeld, lockHolder>>

\* Releasing the lock: the guard's Drop performs store(false, Release).
\* Only the current holder can drop its guard.
ReleaseLock(thread) ==
    /\ lockHeld = TRUE
    /\ lockHolder = thread
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next ==
    \E t \in Threads :
        \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
        \/ ReleaseLock(t)

Spec == Init /\ [][Next]_vars

====