---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

vars == <<lockHeld, lockHolder>>

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

\* Acquiring the lock corresponds to a successful compare_exchange(false -> true).
\* For callType "lock", the busy loop eventually succeeds only when the lock is free.
\* For callType "try", try_lock succeeds only when the lock is free (otherwise no
\* observable state change occurs).
AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ lockHeld = FALSE
    /\ lockHolder = NONE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* Releasing the lock corresponds to store(false, Release) by the holder.
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