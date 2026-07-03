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

\* A thread acquires the lock via lock() or try_lock().
\* Both paths reduce to a compare_exchange(false, true):
\*   - success is only possible when the lock is free;
\*   - a failed try_lock ("try" on a held lock) observably changes nothing.
\* A blocking lock() call is only observed at the moment it succeeds
\* (the busy-wait loop produces no observable state change until then).
AcquireLock(thread, callType) ==
    \/ /\ lockHeld = FALSE
       /\ lockHolder = NONE
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ /\ callType = "try"
       /\ lockHeld = TRUE
       /\ UNCHANGED <<lockHeld, lockHolder>>

\* Dropping the guard stores false with release ordering; only the
\* current holder can release, and the lock becomes free.
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