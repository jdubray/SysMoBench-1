---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

AcquireLock(thread, callType) ==
    /\ thread \in Threads
    /\ callType \in {"lock", "try"}
    /\ IF ~lockHeld
       THEN /\ lockHeld' = TRUE
            /\ lockHolder' = thread
       ELSE /\ lockHeld' = lockHeld
            /\ lockHolder' = lockHolder

ReleaseLock(thread) ==
    /\ thread \in Threads
    /\ IF lockHolder = thread
       THEN /\ lockHeld' = FALSE
            /\ lockHolder' = NONE
       ELSE /\ lockHeld' = lockHeld
            /\ lockHolder' = lockHolder

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>

====