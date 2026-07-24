---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

TypeOK == lockHeld \in BOOLEAN /\ lockHolder \in (Threads \union {NONE})

Init == lockHeld = FALSE /\ lockHolder = NONE

AcquireLock(thread, callType) ==
    /\ callType \in {"lock", "try"}
    /\ IF lockHeld = FALSE
       THEN /\ lockHeld' = TRUE
            /\ lockHolder' = thread
       ELSE /\ IF callType = "lock"
               THEN /\ lockHeld' = TRUE
                    /\ lockHolder' = thread
               ELSE /\ lockHeld' = lockHeld
                    /\ lockHolder' = lockHolder

ReleaseLock(thread) ==
    /\ lockHolder = thread
    /\ lockHeld = TRUE
    /\ lockHeld' = FALSE
    /\ lockHolder' = NONE

Next == \E t \in Threads :
          \/ \E ct \in {"lock", "try"} : AcquireLock(t, ct)
          \/ ReleaseLock(t)

Spec == Init /\ [][Next]_<<lockHeld, lockHolder>>

====