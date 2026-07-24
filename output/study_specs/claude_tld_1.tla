---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

VARIABLES lockHeld, lockHolder

NONE == "none"

Init == lockHeld = FALSE /\ lockHolder = NONE

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

\* Acquire models compare_exchange(false -> true).
\* For callType "lock" (blocking) the observable single step is the successful
\* acquisition; for "try" the successful acquisition is likewise the only step
\* that changes state. A failed attempt (lock already held) leaves state
\* unchanged and is not modeled as a state transition here.
AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ lockHeld = FALSE
    /\ lockHolder = NONE
    /\ lockHeld' = TRUE
    /\ lockHolder' = thread

\* Release models store(false, Release), performed by the holding thread.
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