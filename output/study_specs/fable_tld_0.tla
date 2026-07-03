---- MODULE spin ----
EXTENDS Naturals

CONSTANT Threads

NONE == "none"

VARIABLES lockHeld, lockHolder

vars == <<lockHeld, lockHolder>>

TypeOK ==
    /\ lockHeld \in BOOLEAN
    /\ lockHolder \in (Threads \union {NONE})

Init ==
    /\ lockHeld = FALSE
    /\ lockHolder = NONE

(***************************************************************************)
(* AcquireLock models both `lock()` and `try_lock()`.                      *)
(*                                                                         *)
(* Successful acquisition (compare_exchange false -> true succeeds):       *)
(* possible for both call types, but only when the lock is free.           *)
(*                                                                         *)
(* Failed `try_lock()` (compare_exchange fails because the lock is held):  *)
(* returns immediately and leaves the observable state unchanged.          *)
(*                                                                         *)
(* A blocking `lock()` call spins internally until the lock is free, so    *)
(* its only observable transition is the successful acquisition step.      *)
(***************************************************************************)
AcquireLock(thread, callType) ==
    \/ /\ lockHeld = FALSE
       /\ lockHeld' = TRUE
       /\ lockHolder' = thread
    \/ /\ callType = "try"
       /\ lockHeld = TRUE
       /\ UNCHANGED <<lockHeld, lockHolder>>

(***************************************************************************)
(* ReleaseLock models dropping the SpinLockGuard: the holder stores false. *)
(* Only the thread that holds the lock can release it (guards are !Send).  *)
(***************************************************************************)
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