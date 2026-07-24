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

\* A thread acquires the lock. This models the observable effect of the
\* compare_exchange(false, true, Acquire) succeeding, which is the only way
\* either `lock()` (after spinning) or a successful `try_lock()` completes.
\* A failed `try_lock()` on a held lock is observable as a no-op step.
AcquireLock(thread, callType) ==
    \/ \* Successful acquisition: lock must be free (CAS false -> true succeeds)
       /\ lockHeld = FALSE
       /\ lockHolder = NONE
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ \* Failed try_lock: lock is held, state is unchanged.
       \* (A blocking lock() never completes while held; it spins.)
       /\ callType = "try"
       /\ lockHeld = TRUE
       /\ UNCHANGED <<lockHeld, lockHolder>>

\* Releasing the lock: models SpinLockGuard::drop -> release_lock, which
\* stores false. Only the current holder can release (guard is !Send and
\* exclusive), and the lock becomes free with no holder.
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