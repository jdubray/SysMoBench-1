---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

VARIABLES lockHeld, lockHolder

NONE == "none"

Init ==
    /\ lockHeld = FALSE
    /\ lockHolder = NONE

TypeOK ==
    /\ lockHeld \in BOOLEAN
    /\ lockHolder \in (Threads \union {NONE})

AcquireLock(thread, callType) ==
    \/ /\ ~lockHeld
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ /\ lockHeld
       /\ UNCHANGED <<lockHeld, lockHolder>>

ReleaseLock(thread) ==
    \/ /\ lockHolder = thread
       /\ lockHeld' = FALSE
       /\ lockHolder' = NONE
    \/ /\ lockHolder # thread
       /\ UNCHANGED <<lockHeld, lockHolder>>

Next ==
    \E t \in Threads :
        \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
        \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>

====