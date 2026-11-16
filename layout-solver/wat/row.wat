;; A row of the tableau: `constant + Σ cells`, ordered as a JavaScript Map (src/layout/solver.ts's
;; Row): cells in insertion order, a removed cell's slot dead (symbol -1) until the list is
;; compacted, so a re-inserted symbol goes to the end. A row of more than 8 slots also has an
;; index symbol → slot (open addressing, linear probing, Fibonacci hashing, deletion by backward
;; shift): the objective holds every error symbol, so a lookup must not scan. A small row is
;; scanned (at most 8 slots).
;;
;; header: constant f64, cells, len (slots used), cap (slots), dead, hash (0: none), shift
;; (32 - log2 of the hash's capacity); a cell: symbol i32, pad, coefficient f64; a hash entry:
;; symbol i32 (-1: empty), slot i32.

(@define R_CELLS 8)
(@define R_LEN 12)
(@define R_CAP 16)
(@define R_DEAD 20)
(@define R_HASH 24)
(@define R_SHIFT 28)
(@define ROW_BYTES 32)
(@define SMALL 8)

(func $near_zero (param $n f64) (result i32)
  (f64.lt (f64.abs (local.get $n)) (f64.const 1e-8)))

(func $row_new (param $k f64) (result i32)
  (local $r i32)
  (local.set $r (call $alloc0 (i32.const ROW_BYTES)))
  (f64.store (local.get $r) (local.get $k))
  (local.get $r))

(func $row_free (param $r i32)
  (call $free (i32.load offset=R_CELLS (local.get $r)) (i32.shl (i32.load offset=R_CAP (local.get $r)) (i32.const 4)))
  (if (i32.load offset=R_HASH (local.get $r)) (then
    (call $free (i32.load offset=R_HASH (local.get $r))
      (i32.shl (i32.const 8) (i32.sub (i32.const 32) (i32.load offset=R_SHIFT (local.get $r)))))))
  (call $free (local.get $r) (i32.const ROW_BYTES)))

(func $row_live (param $r i32) (result i32)
  (i32.sub (i32.load offset=R_LEN (local.get $r)) (i32.load offset=R_DEAD (local.get $r))))

(func $hidx (param $sym i32) (param $shift i32) (result i32)
  (i32.shr_u (i32.mul (local.get $sym) (i32.const 0x9E3779B1)) (local.get $shift)))

;; Put sym → slot into a hash that does not hold sym.
(func $hash_put (param $h i32) (param $shift i32) (param $sym i32) (param $slot i32)
  (local $mask i32) (local $i i32) (local $p i32)
  (local.set $mask (i32.sub (i32.shl (i32.const 1) (i32.sub (i32.const 32) (local.get $shift))) (i32.const 1)))
  (local.set $i (call $hidx (local.get $sym) (local.get $shift)))
  (loop $probe
    (local.set $p (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const -1)) (then
      (local.set $i (i32.and (i32.add (local.get $i) (i32.const 1)) (local.get $mask)))
      (br $probe))))
  (i32.store (local.get $p) (local.get $sym))
  (i32.store offset=4 (local.get $p) (local.get $slot)))

;; (Re)build the row's hash with `cap` entries (a power of two) from its live cells.
(func $row_rehash (param $r i32) (param $cap i32)
  (local $h i32) (local $shift i32) (local $p i32) (local $end i32) (local $i i32) (local $s i32)
  (if (local.tee $h (i32.load offset=R_HASH (local.get $r))) (then
    (call $free (local.get $h) (i32.shl (i32.const 8) (i32.sub (i32.const 32) (i32.load offset=R_SHIFT (local.get $r)))))))
  (local.set $h (call $alloc (i32.shl (local.get $cap) (i32.const 3))))
  (memory.fill (local.get $h) (i32.const 0xff) (i32.shl (local.get $cap) (i32.const 3)))
  (local.set $shift (i32.add (i32.clz (local.get $cap)) (i32.const 1)))
  (i32.store offset=R_HASH (local.get $r) (local.get $h))
  (i32.store offset=R_SHIFT (local.get $r) (local.get $shift))
  (local.set $p (i32.load offset=R_CELLS (local.get $r)))
  (local.set $end (i32.load offset=R_LEN (local.get $r)))
  (local.set $i (i32.const 0))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
    (if (i32.ne (local.tee $s (i32.load (local.get $p))) (i32.const -1)) (then
      (call $hash_put (local.get $h) (local.get $shift) (local.get $s) (local.get $i))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each))))

;; The slot of sym's cell, or -1.
(func $row_find (param $r i32) (param $sym i32) (result i32)
  (local $h i32) (local $mask i32) (local $i i32) (local $k i32) (local $p i32) (local $end i32)
  (if (local.tee $h (i32.load offset=R_HASH (local.get $r))) (then
    (local.set $mask (i32.sub (i32.shl (i32.const 1) (i32.sub (i32.const 32) (i32.load offset=R_SHIFT (local.get $r)))) (i32.const 1)))
    (local.set $i (call $hidx (local.get $sym) (i32.load offset=R_SHIFT (local.get $r))))
    (loop $probe
      (local.set $p (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (local.tee $k (i32.load (local.get $p))) (local.get $sym)) (then (return (i32.load offset=4 (local.get $p)))))
      (if (i32.eq (local.get $k) (i32.const -1)) (then (return (i32.const -1))))
      (local.set $i (i32.and (i32.add (local.get $i) (i32.const 1)) (local.get $mask)))
      (br $probe))))
  (local.set $p (i32.load offset=R_CELLS (local.get $r)))
  (local.set $end (i32.load offset=R_LEN (local.get $r)))
  (local.set $i (i32.const 0))
  (block $done (loop $scan
    (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
    (if (i32.eq (i32.load (local.get $p)) (local.get $sym)) (then (return (local.get $i))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $scan)))
  (i32.const -1))

(func $cell (param $r i32) (param $slot i32) (result i32)
  (i32.add (i32.load offset=R_CELLS (local.get $r)) (i32.shl (local.get $slot) (i32.const 4))))

(func $row_coef (param $r i32) (param $sym i32) (result f64)
  (local $slot i32)
  (if (i32.lt_s (local.tee $slot (call $row_find (local.get $r) (local.get $sym))) (i32.const 0))
    (then (return (f64.const 0))))
  (f64.load offset=8 (call $cell (local.get $r) (local.get $slot))))

;; Take sym out of the hash (it is there), shifting back the entries probed past it.
(func $hash_del (param $r i32) (param $sym i32)
  (local $h i32) (local $shift i32) (local $mask i32) (local $i i32) (local $j i32) (local $k i32)
  (local.set $h (i32.load offset=R_HASH (local.get $r)))
  (local.set $shift (i32.load offset=R_SHIFT (local.get $r)))
  (local.set $mask (i32.sub (i32.shl (i32.const 1) (i32.sub (i32.const 32) (local.get $shift))) (i32.const 1)))
  (local.set $i (call $hidx (local.get $sym) (local.get $shift)))
  (loop $probe
    (if (i32.ne (i32.load (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3)))) (local.get $sym)) (then
      (local.set $i (i32.and (i32.add (local.get $i) (i32.const 1)) (local.get $mask)))
      (br $probe))))
  (local.set $j (local.get $i))
  (block $done (loop $shift_back
    (local.set $j (i32.and (i32.add (local.get $j) (i32.const 1)) (local.get $mask)))
    (local.set $k (i32.load (i32.add (local.get $h) (i32.shl (local.get $j) (i32.const 3)))))
    (br_if $done (i32.eq (local.get $k) (i32.const -1)))
    ;; the entry at j may move to i when its home is not in (i, j]
    (if (i32.ge_u (i32.and (i32.sub (local.get $j) (call $hidx (local.get $k) (local.get $shift))) (local.get $mask))
                  (i32.and (i32.sub (local.get $j) (local.get $i)) (local.get $mask))) (then
      (i64.store (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3)))
                 (i64.load (i32.add (local.get $h) (i32.shl (local.get $j) (i32.const 3)))))
      (local.set $i (local.get $j))))
    (br $shift_back)))
  (i32.store (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3))) (i32.const -1)))

;; Kill the cell in `slot`; compact the cells when more than half of them (and over 8) are dead.
(func $row_kill (param $r i32) (param $slot i32)
  (local $p i32) (local $q i32) (local $end i32) (local $dead i32) (local $len i32)
  (local.set $p (call $cell (local.get $r) (local.get $slot)))
  (if (i32.load offset=R_HASH (local.get $r)) (then (call $hash_del (local.get $r) (i32.load (local.get $p)))))
  (i32.store (local.get $p) (i32.const -1))
  (i32.store offset=R_DEAD (local.get $r) (local.tee $dead (i32.add (i32.load offset=R_DEAD (local.get $r)) (i32.const 1))))
  (local.set $len (i32.load offset=R_LEN (local.get $r)))
  (if (i32.and (i32.gt_u (local.get $dead) (i32.const 8)) (i32.gt_u (i32.shl (local.get $dead) (i32.const 1)) (local.get $len))) (then
    (local.set $p (i32.load offset=R_CELLS (local.get $r)))
    (local.set $q (local.get $p))
    (local.set $end (i32.add (local.get $p) (i32.shl (local.get $len) (i32.const 4))))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (if (i32.ne (i32.load (local.get $p)) (i32.const -1)) (then
        (i32.store (local.get $q) (i32.load (local.get $p)))
        (f64.store offset=8 (local.get $q) (f64.load offset=8 (local.get $p)))
        (local.set $q (i32.add (local.get $q) (i32.const 16)))))
      (local.set $p (i32.add (local.get $p) (i32.const 16)))
      (br $each)))
    (i32.store offset=R_LEN (local.get $r) (i32.sub (local.get $len) (local.get $dead)))
    (i32.store offset=R_DEAD (local.get $r) (i32.const 0))
    (if (i32.load offset=R_HASH (local.get $r)) (then
      (call $row_rehash (local.get $r) (i32.shl (i32.const 1) (i32.sub (i32.const 32) (i32.load offset=R_SHIFT (local.get $r))))))))))

;; Append a cell for sym (not in the row).
(func $row_append (param $r i32) (param $sym i32) (param $c f64)
  (local $len i32) (local $cap i32) (local $p i32) (local $hcap i32)
  (local.set $len (i32.load offset=R_LEN (local.get $r)))
  (if (i32.eq (local.get $len) (local.tee $cap (i32.load offset=R_CAP (local.get $r)))) (then
    (i32.store offset=R_CELLS (local.get $r)
      (call $realloc (i32.load offset=R_CELLS (local.get $r)) (i32.shl (local.get $cap) (i32.const 4))
        (i32.shl (local.tee $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 4) (local.get $cap))) (i32.const 4))))
    (i32.store offset=R_CAP (local.get $r) (local.get $cap))))
  (local.set $p (call $cell (local.get $r) (local.get $len)))
  (i32.store (local.get $p) (local.get $sym))
  (f64.store offset=8 (local.get $p) (local.get $c))
  (i32.store offset=R_LEN (local.get $r) (i32.add (local.get $len) (i32.const 1)))
  (if (i32.load offset=R_HASH (local.get $r))
    (then
      (local.set $hcap (i32.shl (i32.const 1) (i32.sub (i32.const 32) (i32.load offset=R_SHIFT (local.get $r)))))
      (if (i32.gt_u (i32.shl (call $row_live (local.get $r)) (i32.const 1)) (local.get $hcap))
        (then (call $row_rehash (local.get $r) (i32.shl (local.get $hcap) (i32.const 1))))
        (else (call $hash_put (i32.load offset=R_HASH (local.get $r)) (i32.load offset=R_SHIFT (local.get $r)) (local.get $sym) (local.get $len)))))
    (else
      (if (i32.gt_u (local.get $len) (i32.const SMALL)) (then (call $row_rehash (local.get $r) (i32.const 32)))))))

;; Add c to sym's cell (TS Row.insert): 1 if that added the cell, -1 if it removed it, else 0.
(func $row_insert (param $r i32) (param $sym i32) (param $c f64) (result i32)
  (local $slot i32) (local $p i32) (local $v f64)
  (if (i32.ge_s (local.tee $slot (call $row_find (local.get $r) (local.get $sym))) (i32.const 0)) (then
    (local.set $p (call $cell (local.get $r) (local.get $slot)))
    (local.set $v (f64.add (f64.load offset=8 (local.get $p)) (local.get $c)))
    (if (call $near_zero (local.get $v)) (then
      (call $row_kill (local.get $r) (local.get $slot))
      (return (i32.const -1))))
    (f64.store offset=8 (local.get $p) (local.get $v))
    (return (i32.const 0))))
  ;; absent: the value is 0 + c
  (local.set $v (f64.add (f64.const 0) (local.get $c)))
  (if (call $near_zero (local.get $v)) (then (return (i32.const 0))))
  (call $row_append (local.get $r) (local.get $sym) (local.get $v))
  (i32.const 1))

;; r += o · c
(func $row_insert_row (param $r i32) (param $o i32) (param $c f64)
  (local $p i32) (local $end i32) (local $s i32)
  (f64.store (local.get $r) (f64.add (f64.load (local.get $r)) (f64.mul (f64.load (local.get $o)) (local.get $c))))
  (local.set $p (i32.load offset=R_CELLS (local.get $o)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $o)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (if (i32.ne (local.tee $s (i32.load (local.get $p))) (i32.const -1)) (then
      (drop (call $row_insert (local.get $r) (local.get $s) (f64.mul (f64.load offset=8 (local.get $p)) (local.get $c))))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each))))

(func $row_remove (param $r i32) (param $sym i32)
  (local $slot i32)
  (if (i32.ge_s (local.tee $slot (call $row_find (local.get $r) (local.get $sym))) (i32.const 0))
    (then (call $row_kill (local.get $r) (local.get $slot)))))

;; Multiply the constant and every cell by m.
(func $row_scale (param $r i32) (param $m f64)
  (local $p i32) (local $end i32)
  (f64.store (local.get $r) (f64.mul (f64.load (local.get $r)) (local.get $m)))
  (local.set $p (i32.load offset=R_CELLS (local.get $r)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $r)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (f64.store offset=8 (local.get $p) (f64.mul (f64.load offset=8 (local.get $p)) (local.get $m)))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each))))

(func $row_reverse (param $r i32)
  (local $p i32) (local $end i32)
  (f64.store (local.get $r) (f64.neg (f64.load (local.get $r))))
  (local.set $p (i32.load offset=R_CELLS (local.get $r)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $r)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (f64.store offset=8 (local.get $p) (f64.neg (f64.load offset=8 (local.get $p))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each))))

;; Solve `0 = r` for sym (in the row): r becomes `sym = …`, without sym.
(func $row_solve_for (param $r i32) (param $sym i32)
  (local $slot i32) (local $m f64)
  (local.set $slot (call $row_find (local.get $r) (local.get $sym)))
  (local.set $m (f64.div (f64.const -1) (f64.load offset=8 (call $cell (local.get $r) (local.get $slot)))))
  (call $row_kill (local.get $r) (local.get $slot))
  (call $row_scale (local.get $r) (local.get $m)))

;; Solve `lhs = r` for rhs.
(func $row_solve_pair (param $r i32) (param $lhs i32) (param $rhs i32)
  (drop (call $row_insert (local.get $r) (local.get $lhs) (f64.const -1)))
  (call $row_solve_for (local.get $r) (local.get $rhs)))

;; Replace sym in r by o.
(func $row_subst (param $r i32) (param $sym i32) (param $o i32)
  (local $slot i32) (local $c f64)
  (if (i32.lt_s (local.tee $slot (call $row_find (local.get $r) (local.get $sym))) (i32.const 0)) (then (return)))
  (local.set $c (f64.load offset=8 (call $cell (local.get $r) (local.get $slot))))
  (call $row_kill (local.get $r) (local.get $slot))
  (call $row_insert_row (local.get $r) (local.get $o) (local.get $c)))

(func $row_copy (param $r i32) (result i32)
  (local $n i32) (local $p i32) (local $end i32) (local $s i32)
  (local.set $n (call $row_new (f64.load (local.get $r))))
  (local.set $p (i32.load offset=R_CELLS (local.get $r)))
  (local.set $end (i32.add (local.get $p) (i32.shl (i32.load offset=R_LEN (local.get $r)) (i32.const 4))))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
    (if (i32.ne (local.tee $s (i32.load (local.get $p))) (i32.const -1)) (then
      (call $row_append (local.get $n) (local.get $s) (f64.load offset=8 (local.get $p)))))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (br $each)))
  (local.get $n))
