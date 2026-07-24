---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

\* Acquire the lock. For callType "lock", the thread busy-waits until the
\* lock is free, so the observable single successful step requires the lock
\* to be free (compare_exchange false -> true succeeds). For callType "try",
\* try_lock also only succeeds when the lock is free; a failed try_lock
\* leaves the state unchanged.
AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ lockHeld = FALSE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* Release the lock. Only the holding thread can release it (Drop of its guard),
\* setting the atomic bool back to false.
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