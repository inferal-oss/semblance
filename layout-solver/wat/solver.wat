;; The WAT twin of src/layout/solver.ts, step for step: Cassowary in kiwi's shape with Dantzig's
;; entering rule (Bland's after STALL degenerate pivots) and a column index. Cells iterate in
;; insertion order (row.wat), rows touched together in the order they became basic, so the twins
;; pivot identically and agree bit for bit.
;;
;; Symbols are dense; each has a record: kind, its row when basic (0: not basic), when it became
;; basic (seq), and its column: the basic symbols whose rows use it. As in the Rust twin, a column
;; removes lazily: stale entries stay until it is half stale, and readers skip them ($uses).
;; Errors return -1 up the call chain (TS throws), leaving the state where TS leaves it.

(@define EXTERNAL 0)
(@define SLACK 1)
(@define ERROR 2)
(@define DUMMY 3)
(@define LE 0)
(@define GE 1)
(@define EQ 2)
(@define STALL 64)

(@define S_KIND 0)
(@define S_ROW 4)
(@define S_SEQ 8)
(@define S_COLP 12)
(@define S_COLL 16)
(@define S_COLC 20)
(@define S_COLLIVE 24)
(@define S_MARK 28)

;; constraint: marker, other, alive, strength; edit (by variable): alive, marker, other,
;; constraint, constant
(@define C_MARKER 0)
(@define C_OTHER 4)
(@define C_ALIVE 8)
(@define C_STRENGTH 16)
(@define E_ALIVE 0)
(@define E_MARKER 4)
(@define E_OTHER 8)
(@define E_CONSTRAINT 12)
(@define E_CONSTANT 16)

(global $syms (mut i32) (i32.const 0))
(global $nsyms (mut i32) (i32.const 0))
(global $symcap (mut i32) (i32.const 0))
(global $vars (mut i32) (i32.const 0))
(global $nvars (mut i32) (i32.const 0))
(global $varcap (mut i32) (i32.const 0))
(global $cons (mut i32) (i32.const 0))
(global $ncons (mut i32) (i32.const 0))
(global $concap (mut i32) (i32.const 0))
(global $edits (mut i32) (i32.const 0))
(global $editcap (mut i32) (i32.const 0))
(global $inf (mut i32) (i32.const 0))
(global $ninf (mut i32) (i32.const 0))
(global $infcap (mut i32) (i32.const 0))
(global $obj (mut i32) (i32.const 0))
(global $art (mut i32) (i32.const 0))
(global $stamp (mut i32) (i32.const 0))
(global $mark (mut i32) (i32.const 0))
(global $pivots (mut i64) (i64.const 0))
;; users(): (seq << 32 | symbol) per user, sorted
(global $scr (mut i32) (i32.const 0))
(global $scrcap (mut i32) (i32.const 0))
;; the tag createRow fills
(global $tm (mut i32) (i32.const -1))
(global $to (mut i32) (i32.const -1))

(func $solver_init
  (global.set $syms (i32.const 0)) (global.set $nsyms (i32.const 0)) (global.set $symcap (i32.const 0))
  (global.set $vars (i32.const 0)) (global.set $nvars (i32.const 0)) (global.set $varcap (i32.const 0))
  (global.set $cons (i32.const 0)) (global.set $ncons (i32.const 0)) (global.set $concap (i32.const 0))
  (global.set $edits (i32.const 0)) (global.set $editcap (i32.const 0))
  (global.set $inf (i32.const 0)) (global.set $ninf (i32.const 0)) (global.set $infcap (i32.const 0))
  (global.set $art (i32.const 0)) (global.set $stamp (i32.const 0)) (global.set $mark (i32.const 0))
  (global.set $pivots (i64.const 0))
  (global.set $scr (i32.const 0)) (global.set $scrcap (i32.const 0))
  (global.set $obj (call $row_new (f64.const 0))))

;; --- symbols ---------------------------------------------------------------------------------

(func $S (param $s i32) (result i32)
  (i32.add (global.get $syms) (i32.shl (local.get $s) (i32.const 5))))

(func $kind (param $s i32) (result i32)
  (i32.load offset=S_KIND (call $S (local.get $s))))

(func $row_of (param $s i32) (result i32)
  (i32.load offset=S_ROW (call $S (local.get $s))))

(func $symbol (param $kind i32) (result i32)
  (local $n i32) (local $cap i32)
  (local.set $n (global.get $nsyms))
  (if (i32.eq (local.get $n) (local.tee $cap (global.get $symcap))) (then
    (global.set $syms (call $realloc (global.get $syms) (i32.shl (local.get $cap) (i32.const 5))
      (i32.shl (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 64) (local.get $cap))) (i32.const 5))))
    (global.set $symcap (local.get $cap))))
  (i32.store offset=S_KIND (call $S (local.get $n)) (local.get $kind))
  (global.set $nsyms (i32.add (local.get $n) (i32.const 1)))
  (local.get $n))

(func $pivotable (param $s i32) (result i32)
  (local $k i32)
  (if (i32.eq (local.get $s) (i32.const -1)) (then (return (i32.const 0))))
  (local.set $k (call $kind (local.get $s)))
  (i32.or (i32.eq (local.get $k) (i32.const SLACK)) (i32.eq (local.get $k) (i32.const ERROR))))

(func $push_inf (param $s i32)
  (local $cap i32)
  (if (i32.eq (global.get $ninf) (local.tee $cap (global.get $infcap))) (then
    (global.set $inf (call $realloc (global.get $inf) (i32.shl (local.get $cap) (i32.const 2))
      (i32.shl (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 64) (local.get $cap))) (i32.const 2))))
    (global.set $infcap (local.get $cap))))
  (i32.store (i32.add (global.get $inf) (i32.shl (global.get $ninf) (i32.const 2))) (local.get $s))
  (global.set $ninf (i32.add (global.get $ninf) (i32.const 1))))

;; --- the column index ------------------------------------------------------------------------

;; Whether `basic` is basic and its row uses `sym` (a column entry is current).
(func $uses (param $basic i32) (param $sym i32) (result i32)
  (local $r i32)
  (if (i32.eqz (local.tee $r (call $row_of (local.get $basic)))) (then (return (i32.const 0))))
  (i32.ge_s (call $row_find (local.get $r) (local.get $sym)) (i32.const 0)))

(func $link (param $sym i32) (param $basic i32)
  (local $a i32) (local $len i32) (local $cap i32)
  (local.set $a (call $S (local.get $sym)))
  (local.set $len (i32.load offset=S_COLL (local.get $a)))
  (if (i32.eq (local.get $len) (local.tee $cap (i32.load offset=S_COLC (local.get $a)))) (then
    (i32.store offset=S_COLP (local.get $a)
      (call $realloc (i32.load offset=S_COLP (local.get $a)) (i32.shl (local.get $cap) (i32.const 2))
        (i32.shl (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 4) (local.get $cap))) (i32.const 2))))
    (i32.store offset=S_COLC (local.get $a) (local.get $cap))))
  (i32.store (i32.add (i32.load offset=S_COLP (local.get $a)) (i32.shl (local.get $len) (i32.const 2))) (local.get $basic))
  (i32.store offset=S_COLL (local.get $a) (i32.add (local.get $len) (i32.const 1)))
  (i32.store offset=S_COLLIVE (local.get $a) (i32.add (i32.load offset=S_COLLIVE (local.get $a)) (i32.const 1))))

;; A row no longer uses `sym`: count it, and drop the stale entries once the column is half stale.
(func $unlink (param $sym i32)
  (local $a i32) (local $live i32) (local $len i32) (local $p i32) (local $end i32) (local $q i32) (local $s i32)
  (local.set $a (call $S (local.get $sym)))
  (local.set $live (i32.load offset=S_COLLIVE (local.get $a)))
  (if (local.get $live) (then (local.set $live (i32.sub (local.get $live) (i32.const 1)))))
  (local.set $len (i32.load offset=S_COLL (local.get $a)))
  (if (i32.gt_u (local.get $len) (i32.add (i32.shl (local.get $live) (i32.const 1)) (i32.const 8))) (then
    ;; keep the current entries, once each (marked)
    (global.set $mark (i32.add (global.get $mark) (i32.const 1)))
    (local.set $p (i32.load offset=S_COLP (local.get $a)))
    (local.set $q (local.get $p))
    (local.set $end (i32.add (local.get $p) (i32.shl (local.get $len) (i32.const 2))))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (local.set $s (i32.load (local.get $p)))
      (if (i32.and (call $uses (local.get $s) (local.get $sym))
                   (i32.ne (i32.load offset=S_MARK (call $S (local.get $s))) (global.get $mark))) (then
        (i32.store offset=S_MARK (call $S (local.get $s)) (global.get $mark))
        (i32.store (local.get $q) (local.get $s))
        (local.set $q (i32.add (local.get $q) (i32.const 4)))))
      (local.set $p (i32.add (local.get $p) (i32.const 4)))
      (br $each)))
    (local.set $len (i32.shr_u (i32.sub (local.get $q) (i32.load offset=S_COLP (local.get $a))) (i32.const 2)))
    (i32.store offset=S_COLL (local.get $a) (local.get $len))
    (local.set $live (local.get $len))))
  (i32.store offset=S_COLLIVE (local.get $a) (local.get $live)))

(func $col_clear (param $sym i32)
  (local $a i32)
  (local.set $a (call $S (local.get $sym)))
  (i32.store offset=S_COLL (local.get $a) (i32.const 0))
  (i32.store offset=S_COLLIVE (local.get $a) (i32.const 0)))

;; Sift a[root] down a max-heap of n i64s.
(func $sift (param $a i32) (param $root i32) (param $n i32)
  (local $x i64) (local $child i32)
  (local.set $x (i64.load (i32.add (local.get $a) (i32.shl (local.get $root) (i32.const 3)))))
  (block $done (loop $down
    (local.set $child (i32.add (i32.shl (local.get $root) (i32.const 1)) (i32.const 1)))
    (br_if $done (i32.ge_u (local.get $child) (local.get $n)))
    (if (i32.lt_u (i32.add (local.get $child) (i32.const 1)) (local.get $n)) (then
      (if (i64.gt_s (i64.load offset=8 (i32.add (local.get $a) (i32.shl (local.get $child) (i32.const 3))))
                    (i64.load (i32.add (local.get $a) (i32.shl (local.get $child) (i32.const 3)))))
        (then (local.set $child (i32.add (local.get $child) (i32.const 1)))))))
    (br_if $done (i64.le_s (i64.load (i32.add (local.get $a) (i32.shl (local.get $child) (i32.const 3)))) (local.get $x)))
    (i64.store (i32.add (local.get $a) (i32.shl (local.get $root) (i32.const 3)))
               (i64.load (i32.add (local.get $a) (i32.shl (local.get $child) (i32.const 3)))))
    (local.set $root (local.get $child))
    (br $down)))
  (i64.store (i32.add (local.get $a) (i32.shl (local.get $root) (i32.const 3))) (local.get $x)))

;; Sort n i64s ascending: insertion sort when few, else heapsort.
(func $sort (param $a i32) (param $n i32)
  (local $i i32) (local $j i32) (local $x i64) (local $p i32) (local $y i64)
  (if (i32.le_u (local.get $n) (i32.const 24)) (then
    (local.set $i (i32.const 1))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $x (i64.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $j (local.get $i))
      (block $placed (loop $shift
        (br_if $placed (i32.eqz (local.get $j)))
        (local.set $p (i32.add (local.get $a) (i32.shl (local.get $j) (i32.const 3))))
        (br_if $placed (i64.le_s (local.tee $y (i64.load offset=0 (i32.sub (local.get $p) (i32.const 8)))) (local.get $x)))
        (i64.store (local.get $p) (local.get $y))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (br $shift)))
      (i64.store (i32.add (local.get $a) (i32.shl (local.get $j) (i32.const 3))) (local.get $x))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each)))
    (return)))
  (local.set $i (i32.shr_u (local.get $n) (i32.const 1)))
  (block $built (loop $build
    (br_if $built (i32.eqz (local.get $i)))
    (local.set $i (i32.sub (local.get $i) (i32.const 1)))
    (call $sift (local.get $a) (local.get $i) (local.get $n))
    (br $build)))
  (local.set $i (i32.sub (local.get $n) (i32.const 1)))
  (block $sorted (loop $pop
    (br_if $sorted (i32.eqz (local.get $i)))
    (local.set $p (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 3))))
    (local.set $x (i64.load (local.get $p)))
    (i64.store (local.get $p) (i64.load (local.get $a)))
    (i64.store (local.get $a) (local.get $x))
    (call $sift (local.get $a) (i32.const 0) (local.get $i))
    (local.set $i (i32.sub (local.get $i) (i32.const 1)))
    (br $pop))))

;; The basic symbols whose rows use `sym`, in the order they became basic, into $scr; their count.
;; Read the i-th with $user.
(func $users (param $sym i32) (result i32)
  (local $a i32) (local $p i32) (local $end i32) (local $s i32) (local $n i32) (local $i i32) (local $q i32) (local $prev i64) (local $x i64)
  (local.set $a (call $S (local.get $sym)))
  (if (i32.gt_u (local.tee $n (i32.load offset=S_COLL (local.get $a))) (global.get $scrcap)) (then
    (call $free (global.get $scr) (i32.shl (global.get $scrcap) (i32.const 3)))
    (global.set $scrcap (i32.shl (local.get $n) (i32.const 1)))
    (global.set $scr (call $alloc (i32.shl (global.get $scrcap) (i32.const 3))))))
  (local.set $p (i32.load offset=S_COLP (local.get $a)))
  (local.set $end (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 2))))
  (local.set $q (global.get $scr))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (if (call $uses (local.get $s) (local.get $sym)) (then
      (i64.store (local.get $q) (i64.or (i64.shl (i64.extend_i32_u (i32.load offset=S_SEQ (call $S (local.get $s)))) (i64.const 32))
                                        (i64.extend_i32_u (local.get $s))))
      (local.set $q (i32.add (local.get $q) (i32.const 8)))))
    (local.set $p (i32.add (local.get $p) (i32.const 4)))
    (br $each)))
  (local.set $n (i32.shr_u (i32.sub (local.get $q) (global.get $scr)) (i32.const 3)))
  (if (i32.le_u (local.get $n) (i32.const 1)) (then (return (local.get $n))))
  (call $sort (global.get $scr) (local.get $n))
  ;; drop duplicates (a symbol linked again before its stale entry went)
  (local.set $p (global.get $scr))
  (local.set $q (i32.add (global.get $scr) (i32.const 8)))
  (local.set $prev (i64.load (local.get $p)))
  (local.set $i (i32.const 1))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $x (i64.load (i32.add (global.get $scr) (i32.shl (local.get $i) (i32.const 3)))))
    (if (i64.ne (local.get $x) (local.get $prev)) (then
      (i64.store (local.get $q) (local.get $x))
      (local.set $q (i32.add (local.get $q) (i32.const 8)))
      (local.set $prev (local.get $x))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each)))
  (i32.shr_u (i32.sub (local.get $q) (global.get $scr)) (i32.const 3)))

(func $user (param $i i32) (result i32)
  (i32.load (i32.add (global.get $scr) (i32.shl (local.get $i) (i32.const 3)))))

;; A row becomes basic for `sym`: index its cells.
(func $attach (param $sym i32) (param $row i32)
  (local $a i32) (local $p i32) (local $end i32) (local $s i32)
  (local.set $a (call $S (local.get $sym)))
  (i32.store offset=S_ROW (local.get $a) (local.get $row))
  (i32.store offset=S_SEQ (local.get $a) (global.get $stamp))
  (global.set $stamp (i32.add (global.get $stamp) (i32.const 1)))
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (if (i32.ne (local.tee $s (i32.load (local.get $p))) (i32.const -1)) (then (call $link (local.get $s) (local.get $sym))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each))))

;; `sym` stops being basic: its row, unindexed (0 if it was not basic).
(func $detach (param $sym i32) (result i32)
  (local $a i32) (local $row i32) (local $p i32) (local $end i32) (local $s i32)
  (local.set $a (call $S (local.get $sym)))
  (if (i32.eqz (local.tee $row (i32.load offset=S_ROW (local.get $a)))) (then (return (i32.const 0))))
  (i32.store offset=S_ROW (local.get $a) (i32.const 0))
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (if (i32.ne (local.tee $s (i32.load (local.get $p))) (i32.const -1)) (then (call $unlink (local.get $s))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each)))
  (local.get $row))

;; Replace `sym` by `row` in the rows that use it (and the objectives), keeping the index.
(func $substitute (param $sym i32) (param $row i32)
  (local $n i32) (local $i i32) (local $s i32) (local $r i32) (local $slot i32) (local $c f64)
  (local $p i32) (local $end i32) (local $t i32) (local $res i32)
  (local.set $n (call $users (local.get $sym)))
  (call $col_clear (local.get $sym))
  (local.set $i (i32.const 0))
  (block $users_done (loop $each_user
    (br_if $users_done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $s (call $user (local.get $i)))
    (local.set $r (call $row_of (local.get $s)))
    (local.set $slot (call $row_find (local.get $r) (local.get $sym)))
    (local.set $c (f64.load offset=8 (call $cell (local.get $r) (local.get $slot))))
    (call $row_kill (local.get $r) (local.get $slot))
    (f64.store (local.get $r) (f64.add (f64.load (local.get $r)) (f64.mul (f64.load (local.get $row)) (local.get $c))))
    (local.set $p (i32.load offset=R_CELLS (local.get $row)))
    (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (if (i32.ne (local.tee $t (i32.load (local.get $p))) (i32.const -1)) (then
        (local.set $res (call $row_insert (local.get $r) (local.get $t) (f64.mul (f64.load offset=8 (local.get $p)) (local.get $c))))
        (if (i32.eq (local.get $res) (i32.const 1))
          (then (call $link (local.get $t) (local.get $s)))
          (else (if (i32.eq (local.get $res) (i32.const -1)) (then (call $unlink (local.get $t))))))))
      (local.set $p (i32.add (local.get $p) (i32.const 16)))
      (br $each)))
    (if (i32.and (i32.ne (call $kind (local.get $s)) (i32.const EXTERNAL)) (f64.lt (f64.load (local.get $r)) (f64.const 0)))
      (then (call $push_inf (local.get $s))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each_user)))
  (call $row_subst (global.get $obj) (local.get $sym) (local.get $row))
  (if (global.get $art) (then (call $row_subst (global.get $art) (local.get $sym) (local.get $row)))))

;; --- pivoting ----------------------------------------------------------------------------------

;; The symbol with the most negative objective coefficient (Bland: the lowest negative one).
(func $entering_symbol (param $objective i32) (param $bland i32) (result i32)
  (local $entering i32) (local $most f64) (local $p i32) (local $end i32) (local $s i32) (local $c f64)
  (local.set $entering (i32.const -1))
  (local.set $p (i32.load offset=R_CELLS (local.get $objective)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $objective)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (local.set $c (f64.load offset=8 (local.get $p)))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br_if $each (i32.eq (local.get $s) (i32.const -1)))
    (br_if $each (f64.ge (local.get $c) (f64.const 0)))
    (br_if $each (i32.eq (call $kind (local.get $s)) (i32.const DUMMY)))
    (if (if (result i32) (local.get $bland)
          (then (i32.lt_u (local.get $s) (local.get $entering)))
          (else (f64.lt (local.get $c) (local.get $most)))) (then
      (local.set $most (local.get $c))
      (local.set $entering (local.get $s))))
    (br $each)))
  (local.get $entering))

(func $dual_entering_symbol (param $row i32) (result i32)
  (local $entering i32) (local $ratio f64) (local $r f64) (local $p i32) (local $end i32) (local $s i32) (local $c f64)
  (local.set $entering (i32.const -1))
  (local.set $ratio (f64.const 0x1.fffffffffffffp+1023))
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (local.set $c (f64.load offset=8 (local.get $p)))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br_if $each (i32.eq (local.get $s) (i32.const -1)))
    (if (i32.and (f64.gt (local.get $c) (f64.const 0)) (i32.ne (call $kind (local.get $s)) (i32.const DUMMY))) (then
      (local.set $r (f64.div (call $row_coef (global.get $obj) (local.get $s)) (local.get $c)))
      (if (f64.lt (local.get $r) (local.get $ratio)) (then
        (local.set $ratio (local.get $r))
        (local.set $entering (local.get $s))))))
    (br $each)))
  (local.get $entering))

(func $any_pivotable_symbol (param $row i32) (result i32)
  (local $p i32) (local $end i32) (local $s i32)
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (if (i32.ne (local.get $s) (i32.const -1)) (then
      (if (call $pivotable (local.get $s)) (then (return (local.get $s))))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each)))
  (i32.const -1))

;; The row the entering symbol replaces: the lowest ratio, ties to the first (Bland: lowest) row.
(func $leaving_row (param $entering i32) (param $bland i32) (result i32)
  (local $n i32) (local $i i32) (local $s i32) (local $row i32) (local $c f64) (local $r f64) (local $ratio f64) (local $found i32)
  (local.set $ratio (f64.const 0x1.fffffffffffffp+1023))
  (local.set $found (i32.const -1))
  (local.set $n (call $users (local.get $entering)))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $s (call $user (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br_if $each (i32.eq (call $kind (local.get $s)) (i32.const EXTERNAL)))
    (local.set $row (call $row_of (local.get $s)))
    (local.set $c (call $row_coef (local.get $row) (local.get $entering)))
    (if (f64.lt (local.get $c) (f64.const 0)) (then
      (local.set $r (f64.div (f64.neg (f64.load (local.get $row))) (local.get $c)))
      (if (i32.or (f64.lt (local.get $r) (local.get $ratio))
                  (i32.and (local.get $bland) (i32.and (f64.eq (local.get $r) (local.get $ratio)) (i32.lt_s (local.get $s) (local.get $found))))) (then
        (local.set $ratio (local.get $r))
        (local.set $found (local.get $s))))))
    (br $each)))
  (local.get $found))

(func $marker_leaving_row (param $marker i32) (result i32)
  (local $n i32) (local $i i32) (local $s i32) (local $row i32) (local $c f64) (local $r f64)
  (local $r1 f64) (local $r2 f64) (local $first i32) (local $second i32) (local $third i32)
  (local.set $r1 (f64.const 0x1.fffffffffffffp+1023))
  (local.set $r2 (f64.const 0x1.fffffffffffffp+1023))
  (local.set $first (i32.const -1))
  (local.set $second (i32.const -1))
  (local.set $third (i32.const -1))
  (local.set $n (call $users (local.get $marker)))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $s (call $user (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (local.set $row (call $row_of (local.get $s)))
    (local.set $c (call $row_coef (local.get $row) (local.get $marker)))
    (if (i32.eq (call $kind (local.get $s)) (i32.const EXTERNAL))
      (then (local.set $third (local.get $s)))
      (else (if (f64.lt (local.get $c) (f64.const 0))
        (then
          (local.set $r (f64.div (f64.neg (f64.load (local.get $row))) (local.get $c)))
          (if (f64.lt (local.get $r) (local.get $r1)) (then
            (local.set $r1 (local.get $r))
            (local.set $first (local.get $s)))))
        (else
          (local.set $r (f64.div (f64.load (local.get $row)) (local.get $c)))
          (if (f64.lt (local.get $r) (local.get $r2)) (then
            (local.set $r2 (local.get $r))
            (local.set $second (local.get $s))))))))
    (br $each)))
  (if (i32.ne (local.get $first) (i32.const -1)) (then (return (local.get $first))))
  (if (i32.ne (local.get $second) (i32.const -1)) (then (return (local.get $second))))
  (local.get $third))

;; 0, or -1 when the objective is unbounded.
(func $optimize (param $objective i32) (result i32)
  (local $stalled i32) (local $bland i32) (local $entering i32) (local $leaving i32) (local $row i32)
  (loop $pivot
    (local.set $bland (i32.gt_u (local.get $stalled) (i32.const STALL)))
    (if (i32.eq (local.tee $entering (call $entering_symbol (local.get $objective) (local.get $bland))) (i32.const -1))
      (then (return (i32.const 0))))
    (if (i32.eq (local.tee $leaving (call $leaving_row (local.get $entering) (local.get $bland))) (i32.const -1))
      (then (return (i32.const -1))))
    (local.set $row (call $detach (local.get $leaving)))
    (local.set $stalled (select (i32.add (local.get $stalled) (i32.const 1)) (i32.const 0) (call $near_zero (f64.load (local.get $row)))))
    (call $row_solve_pair (local.get $row) (local.get $leaving) (local.get $entering))
    (call $substitute (local.get $entering) (local.get $row))
    (call $attach (local.get $entering) (local.get $row))
    (global.set $pivots (i64.add (global.get $pivots) (i64.const 1)))
    (br $pivot))
  (unreachable))

(func $dual_optimize (result i32)
  (local $leaving i32) (local $row i32) (local $entering i32)
  (block $done (loop $each
    (br_if $done (i32.eqz (global.get $ninf)))
    (global.set $ninf (i32.sub (global.get $ninf) (i32.const 1)))
    (local.set $leaving (i32.load (i32.add (global.get $inf) (i32.shl (global.get $ninf) (i32.const 2)))))
    (local.set $row (call $row_of (local.get $leaving)))
    (br_if $each (i32.eqz (local.get $row)))
    (br_if $each (f64.ge (f64.load (local.get $row)) (f64.const 0)))
    (if (i32.eq (local.tee $entering (call $dual_entering_symbol (local.get $row))) (i32.const -1))
      (then (return (i32.const -1))))
    (drop (call $detach (local.get $leaving)))
    (call $row_solve_pair (local.get $row) (local.get $leaving) (local.get $entering))
    (call $substitute (local.get $entering) (local.get $row))
    (call $attach (local.get $entering) (local.get $row))
    (global.set $pivots (i64.add (global.get $pivots) (i64.const 1)))
    (br $each)))
  (i32.const 0))

;; --- constraints -------------------------------------------------------------------------------

(func $clip (param $s f64) (result f64)
  (f64.max (f64.const 0) (f64.min (f64.const 1001001000) (local.get $s))))

;; The row of `Σ terms + constant OP 0` (terms: n variable, coefficient f64 pairs at `terms`),
;; its tag into $tm, $to.
(func $create_row (param $terms i32) (param $n i32) (param $constant f64) (param $op i32) (param $strength f64) (result i32)
  (local $row i32) (local $i i32) (local $p i32) (local $coef f64) (local $sym i32) (local $r i32)
  (local $coeff f64) (local $slack i32) (local $error i32) (local $plus i32) (local $minus i32) (local $dummy i32)
  (local.set $row (call $row_new (local.get $constant)))
  (global.set $tm (i32.const -1))
  (global.set $to (i32.const -1))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $p (i32.add (local.get $terms) (i32.shl (local.get $i) (i32.const 4))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (local.set $coef (f64.load offset=8 (local.get $p)))
    (br_if $each (call $near_zero (local.get $coef)))
    (local.set $sym (i32.load (i32.add (global.get $vars) (i32.shl (i32.trunc_sat_f64_u (f64.load (local.get $p))) (i32.const 2)))))
    (if (local.tee $r (call $row_of (local.get $sym)))
      (then (call $row_insert_row (local.get $row) (local.get $r) (local.get $coef)))
      (else (drop (call $row_insert (local.get $row) (local.get $sym) (local.get $coef)))))
    (br $each)))
  (if (i32.or (i32.eq (local.get $op) (i32.const LE)) (i32.eq (local.get $op) (i32.const GE)))
    (then
      (local.set $coeff (select (f64.const 1) (f64.const -1) (i32.eq (local.get $op) (i32.const LE))))
      (local.set $slack (call $symbol (i32.const SLACK)))
      (global.set $tm (local.get $slack))
      (drop (call $row_insert (local.get $row) (local.get $slack) (local.get $coeff)))
      (if (f64.lt (local.get $strength) (f64.const 1001001000)) (then
        (local.set $error (call $symbol (i32.const ERROR)))
        (global.set $to (local.get $error))
        (drop (call $row_insert (local.get $row) (local.get $error) (f64.neg (local.get $coeff))))
        (drop (call $row_insert (global.get $obj) (local.get $error) (local.get $strength))))))
    (else (if (f64.lt (local.get $strength) (f64.const 1001001000))
      (then
        (local.set $plus (call $symbol (i32.const ERROR)))
        (local.set $minus (call $symbol (i32.const ERROR)))
        (global.set $tm (local.get $plus))
        (global.set $to (local.get $minus))
        (drop (call $row_insert (local.get $row) (local.get $plus) (f64.const -1)))
        (drop (call $row_insert (local.get $row) (local.get $minus) (f64.const 1)))
        (drop (call $row_insert (global.get $obj) (local.get $plus) (local.get $strength)))
        (drop (call $row_insert (global.get $obj) (local.get $minus) (local.get $strength))))
      (else
        (local.set $dummy (call $symbol (i32.const DUMMY)))
        (global.set $tm (local.get $dummy))
        (drop (call $row_insert (local.get $row) (local.get $dummy) (f64.const 1)))))))
  (if (f64.lt (f64.load (local.get $row)) (f64.const 0)) (then (call $row_reverse (local.get $row))))
  (local.get $row))

(func $choose_subject (param $row i32) (result i32)
  (local $p i32) (local $end i32) (local $s i32)
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (if (i32.ne (local.get $s) (i32.const -1)) (then
      (if (i32.eq (call $kind (local.get $s)) (i32.const EXTERNAL)) (then (return (local.get $s))))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each)))
  (if (call $pivotable (global.get $tm)) (then
    (if (f64.lt (call $row_coef (local.get $row) (global.get $tm)) (f64.const 0)) (then (return (global.get $tm))))))
  (if (call $pivotable (global.get $to)) (then
    (if (f64.lt (call $row_coef (local.get $row) (global.get $to)) (f64.const 0)) (then (return (global.get $to))))))
  (i32.const -1))

(func $all_dummies (param $row i32) (result i32)
  (local $p i32) (local $end i32) (local $s i32)
  (local.set $p (i32.load offset=R_CELLS (local.get $row)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $row)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $s (i32.load (local.get $p)))
    (if (i32.ne (local.get $s) (i32.const -1)) (then
      (if (i32.ne (call $kind (local.get $s)) (i32.const DUMMY)) (then (return (i32.const 0))))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each)))
  (i32.const 1))

;; 1 on success, 0 when unsatisfiable, -1 on an error. Takes `row` (it becomes the artificial
;; objective, then is freed).
(func $add_with_artificial_variable (param $row i32) (result i32)
  (local $art i32) (local $success i32) (local $r i32) (local $entering i32) (local $n i32) (local $i i32)
  (local.set $art (call $symbol (i32.const SLACK)))
  (call $attach (local.get $art) (call $row_copy (local.get $row)))
  (global.set $art (local.get $row))
  (if (i32.lt_s (call $optimize (local.get $row)) (i32.const 0)) (then
    (global.set $art (i32.const 0))
    (return (i32.const -1))))
  (local.set $success (call $near_zero (f64.load (local.get $row))))
  (global.set $art (i32.const 0))
  (call $row_free (local.get $row))
  (if (local.tee $r (call $detach (local.get $art))) (then
    (if (i32.eqz (call $row_live (local.get $r))) (then
      (call $row_free (local.get $r))
      (return (local.get $success))))
    (if (i32.eq (local.tee $entering (call $any_pivotable_symbol (local.get $r))) (i32.const -1))
      (then (return (i32.const 0))))
    (call $row_solve_pair (local.get $r) (local.get $art) (local.get $entering))
    (call $substitute (local.get $entering) (local.get $r))
    (call $attach (local.get $entering) (local.get $r))))
  (local.set $n (call $users (local.get $art)))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (call $row_remove (call $row_of (call $user (local.get $i))) (local.get $art))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each)))
  (call $col_clear (local.get $art))
  (call $row_remove (global.get $obj) (local.get $art))
  (local.get $success))

;; Add `Σ terms + constant OP 0`; its id, or -1.
(func $add_constraint (param $terms i32) (param $n i32) (param $constant f64) (param $op i32) (param $strength f64) (result i32)
  (local $row i32) (local $subject i32) (local $marker i32) (local $other i32) (local $id i32) (local $cap i32) (local $c i32) (local $ok i32)
  (local.set $strength (call $clip (local.get $strength)))
  (local.set $row (call $create_row (local.get $terms) (local.get $n) (local.get $constant) (local.get $op) (local.get $strength)))
  (local.set $marker (global.get $tm))
  (local.set $other (global.get $to))
  (local.set $subject (call $choose_subject (local.get $row)))
  (if (i32.and (i32.eq (local.get $subject) (i32.const -1)) (call $all_dummies (local.get $row))) (then
    (if (i32.eqz (call $near_zero (f64.load (local.get $row)))) (then (return (i32.const -1))))
    (local.set $subject (local.get $marker))))
  (if (i32.eq (local.get $subject) (i32.const -1))
    (then
      (if (i32.le_s (call $add_with_artificial_variable (local.get $row)) (i32.const 0)) (then (return (i32.const -1)))))
    (else
      (call $row_solve_for (local.get $row) (local.get $subject))
      (call $substitute (local.get $subject) (local.get $row))
      (call $attach (local.get $subject) (local.get $row))))
  (local.set $id (global.get $ncons))
  (if (i32.eq (local.get $id) (local.tee $cap (global.get $concap))) (then
    (global.set $cons (call $realloc (global.get $cons) (i32.mul (local.get $cap) (i32.const 24))
      (i32.mul (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 64) (local.get $cap))) (i32.const 24))))
    (global.set $concap (local.get $cap))))
  (local.set $c (i32.add (global.get $cons) (i32.mul (local.get $id) (i32.const 24))))
  (i32.store offset=C_MARKER (local.get $c) (local.get $marker))
  (i32.store offset=C_OTHER (local.get $c) (local.get $other))
  (i32.store offset=C_ALIVE (local.get $c) (i32.const 1))
  (f64.store offset=C_STRENGTH (local.get $c) (local.get $strength))
  (global.set $ncons (i32.add (local.get $id) (i32.const 1)))
  (if (i32.lt_s (call $optimize (global.get $obj)) (i32.const 0)) (then (return (i32.const -1))))
  (local.get $id))

(func $remove_marker_effects (param $marker i32) (param $strength f64)
  (local $row i32)
  (if (local.tee $row (call $row_of (local.get $marker)))
    (then (call $row_insert_row (global.get $obj) (local.get $row) (f64.neg (local.get $strength))))
    (else (drop (call $row_insert (global.get $obj) (local.get $marker) (f64.neg (local.get $strength)))))))

(func $remove_constraint (param $id i32) (result i32)
  (local $c i32) (local $marker i32) (local $other i32) (local $strength f64) (local $row i32) (local $leaving i32)
  (if (i32.ge_u (local.get $id) (global.get $ncons)) (then (return (i32.const -1))))
  (local.set $c (i32.add (global.get $cons) (i32.mul (local.get $id) (i32.const 24))))
  (if (i32.eqz (i32.load offset=C_ALIVE (local.get $c))) (then (return (i32.const -1))))
  (i32.store offset=C_ALIVE (local.get $c) (i32.const 0))
  (local.set $marker (i32.load offset=C_MARKER (local.get $c)))
  (local.set $other (i32.load offset=C_OTHER (local.get $c)))
  (local.set $strength (f64.load offset=C_STRENGTH (local.get $c)))
  (if (i32.eq (call $kind (local.get $marker)) (i32.const ERROR))
    (then (call $remove_marker_effects (local.get $marker) (local.get $strength))))
  (if (i32.ne (local.get $other) (i32.const -1)) (then
    (if (i32.eq (call $kind (local.get $other)) (i32.const ERROR))
      (then (call $remove_marker_effects (local.get $other) (local.get $strength))))))
  (if (local.tee $row (call $detach (local.get $marker)))
    (then (call $row_free (local.get $row)))
    (else
      (if (i32.eq (local.tee $leaving (call $marker_leaving_row (local.get $marker))) (i32.const -1))
        (then (return (i32.const -1))))
      (local.set $row (call $detach (local.get $leaving)))
      (call $row_solve_pair (local.get $row) (local.get $leaving) (local.get $marker))
      (call $substitute (local.get $marker) (local.get $row))
      (call $row_free (local.get $row))))
  (call $optimize (global.get $obj)))

(func $edit (param $v i32) (result i32)
  (i32.add (global.get $edits) (i32.mul (local.get $v) (i32.const 24))))

(func $has_edit (param $v i32) (result i32)
  (if (i32.ge_u (local.get $v) (global.get $editcap)) (then (return (i32.const 0))))
  (i32.load offset=E_ALIVE (call $edit (local.get $v))))

(func $add_edit_variable (param $v i32) (param $strength f64) (result i32)
  (local $id i32) (local $c i32) (local $e i32) (local $cap i32)
  (if (call $has_edit (local.get $v)) (then (return (i32.const -1))))
  (local.set $strength (call $clip (local.get $strength)))
  (if (f64.eq (local.get $strength) (f64.const 1001001000)) (then (return (i32.const -1))))
  (f64.store (i32.const EDIT_TERM) (f64.convert_i32_u (local.get $v)))
  (f64.store offset=8 (i32.const EDIT_TERM) (f64.const 1))
  (if (i32.lt_s (local.tee $id (call $add_constraint (i32.const EDIT_TERM) (i32.const 1) (f64.const 0) (i32.const EQ) (local.get $strength))) (i32.const 0))
    (then (return (i32.const -1))))
  (if (i32.ge_u (local.get $v) (local.tee $cap (global.get $editcap))) (then
    (global.set $edits (call $realloc (global.get $edits) (i32.mul (local.get $cap) (i32.const 24))
      (i32.mul (local.tee $cap (i32.add (i32.shl (local.get $v) (i32.const 1)) (i32.const 16))) (i32.const 24))))
    (global.set $editcap (local.get $cap))))
  (local.set $c (i32.add (global.get $cons) (i32.mul (local.get $id) (i32.const 24))))
  (local.set $e (call $edit (local.get $v)))
  (i32.store offset=E_ALIVE (local.get $e) (i32.const 1))
  (i32.store offset=E_MARKER (local.get $e) (i32.load offset=C_MARKER (local.get $c)))
  (i32.store offset=E_OTHER (local.get $e) (i32.load offset=C_OTHER (local.get $c)))
  (i32.store offset=E_CONSTRAINT (local.get $e) (local.get $id))
  (f64.store offset=E_CONSTANT (local.get $e) (f64.const 0))
  (i32.const 0))

(func $remove_edit_variable (param $v i32) (result i32)
  (if (i32.eqz (call $has_edit (local.get $v))) (then (return (i32.const -1))))
  (if (i32.lt_s (call $remove_constraint (i32.load offset=E_CONSTRAINT (call $edit (local.get $v)))) (i32.const 0))
    (then (return (i32.const -1))))
  (i32.store offset=E_ALIVE (call $edit (local.get $v)) (i32.const 0))
  (i32.const 0))

(func $suggest_value (param $v i32) (param $value f64) (result i32)
  (local $e i32) (local $delta f64) (local $marker i32) (local $other i32) (local $row i32) (local $n i32) (local $i i32) (local $s i32)
  (if (i32.eqz (call $has_edit (local.get $v))) (then (return (i32.const -1))))
  (local.set $e (call $edit (local.get $v)))
  (local.set $delta (f64.sub (local.get $value) (f64.load offset=E_CONSTANT (local.get $e))))
  (f64.store offset=E_CONSTANT (local.get $e) (local.get $value))
  (local.set $marker (i32.load offset=E_MARKER (local.get $e)))
  (local.set $other (i32.load offset=E_OTHER (local.get $e)))
  (if (local.tee $row (call $row_of (local.get $marker)))
    (then
      (f64.store (local.get $row) (f64.add (f64.load (local.get $row)) (f64.neg (local.get $delta))))
      (if (f64.lt (f64.load (local.get $row)) (f64.const 0)) (then (call $push_inf (local.get $marker)))))
    (else (if (local.tee $row (call $row_of (local.get $other)))
      (then
        (f64.store (local.get $row) (f64.add (f64.load (local.get $row)) (local.get $delta)))
        (if (f64.lt (f64.load (local.get $row)) (f64.const 0)) (then (call $push_inf (local.get $other)))))
      (else
        (local.set $n (call $users (local.get $marker)))
        (block $done (loop $each
          (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
          (local.set $s (call $user (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $row (call $row_of (local.get $s)))
          (f64.store (local.get $row) (f64.add (f64.load (local.get $row)) (f64.mul (local.get $delta) (call $row_coef (local.get $row) (local.get $marker)))))
          (if (i32.and (f64.lt (f64.load (local.get $row)) (f64.const 0)) (i32.ne (call $kind (local.get $s)) (i32.const EXTERNAL)))
            (then (call $push_inf (local.get $s))))
          (br $each)))))))
  (call $dual_optimize))

(func $value (param $v i32) (result f64)
  (local $row i32)
  (if (local.tee $row (call $row_of (i32.load (i32.add (global.get $vars) (i32.shl (local.get $v) (i32.const 2))))))
    (then (return (f64.load (local.get $row)))))
  (f64.const 0))

(func $add_variable (result i32)
  (local $cap i32) (local $n i32)
  (local.set $n (global.get $nvars))
  (if (i32.eq (local.get $n) (local.tee $cap (global.get $varcap))) (then
    (global.set $vars (call $realloc (global.get $vars) (i32.shl (local.get $cap) (i32.const 2))
      (i32.shl (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 64) (local.get $cap))) (i32.const 2))))
    (global.set $varcap (local.get $cap))))
  (i32.store (i32.add (global.get $vars) (i32.shl (local.get $n) (i32.const 2))) (call $symbol (i32.const EXTERNAL)))
  (global.set $nvars (i32.add (local.get $n) (i32.const 1)))
  (local.get $n))
