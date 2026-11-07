;; Bounded conservative required-triple proofs. No row allocations, frame
;; changes, shared scan buffers or countdown changes. Counters match Rust.
(global $gp_counts i32 (@words32 0 0 0 0 0 0))
(global $gp_tested (mut i32) (i32.const 0))

(func $gp_reset (memory.fill (global.get $gp_counts) (i32.const 0) (i32.const 24)))
(func $gp_add (param $i i32) (param $n i32)
  (local $p i32) (local $old i32) (local $sum i32)
  (local.set $p (i32.add (global.get $gp_counts) (i32.shl (local.get $i) (i32.const 2))))
  (local.set $sum (i32.add (local.tee $old (i32.load (local.get $p))) (local.get $n)))
  (i32.store (local.get $p) (select (i32.const -1) (local.get $sum) (i32.lt_u (local.get $sum) (local.get $old)))))
(func (export "cq_guard_count") (param $i i32) (result i32)
  (if (result i32) (i32.lt_u (local.get $i) (i32.const 6))
    (then (i32.load (i32.add (global.get $gp_counts) (i32.shl (local.get $i) (i32.const 2)))))
    (else (i32.const 0))))

;; A proof poll is not a row step and never restarts a run's budget.
(func $gp_poll (result i32)
  (local $now f64)
  (if (i32.eqz (global.get $bu_active)) (then (return (i32.const 0))))
  (if (global.get $bu_stop) (then (return (i32.const 1))))
  (if (f64.gt (global.get $bu_deadline) (f64.const 0)) (then
    (local.set $now (call $now_ms))
    (global.set $bu_stop (i32.or
      (i32.eqz (f64.lt (f64.abs (local.get $now)) (f64.const inf)))
      (f64.ge (local.get $now) (global.get $bu_deadline))))))
  (global.get $bu_stop))

;; -1 unknown, 0 complete absence, 1 present. Candidate work in gp_tested.
(func $gp_any (param $s i32) (param $p i32) (param $o i32) (param $g i32) (param $limit i32) (result i32)
  (local $k i32) (local $id i32) (local $list i32) (local $best i32)
  (local $n i32) (local $i i32) (local $q i32)
  (global.set $gp_tested (i32.const 0))
  (loop $positions
    (local.set $id (select (local.get $s)
      (select (local.get $p) (select (local.get $o) (local.get $g) (i32.eq (local.get $k) (i32.const 2)))
        (i32.eq (local.get $k) (i32.const 1))) (i32.eqz (local.get $k))))
    (if (local.get $id) (then
      (if (i32.eqz (call $kind (local.get $id))) (then (return (i32.const 0))))
      (local.set $list (i32.load (i32.add (call $post_of (local.get $id)) (i32.shl (local.get $k) (i32.const 2)))))
      (if (i32.eqz (local.get $list)) (then (return (i32.const 0))))
      (if (i32.or (i32.eqz (local.get $best)) (i32.lt_u (i32.load (local.get $list)) (i32.load (local.get $best))))
        (then (local.set $best (local.get $list))))))
    (br_if $positions (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 4))))
  (local.set $n (if (result i32) (local.get $best) (then (i32.load (local.get $best))) (else (global.get $qn))))
  (loop $candidates
    (if (i32.lt_u (local.get $i) (local.get $n)) (then
      (if (i32.eq (global.get $gp_tested) (local.get $limit)) (then (return (i32.const -1))))
      (local.set $q (call $quad (if (result i32) (local.get $best)
        (then (i32.load offset=8 (i32.add (local.get $best) (i32.shl (local.get $i) (i32.const 2)))))
        (else (local.get $i)))))
      (global.set $gp_tested (i32.add (global.get $gp_tested) (i32.const 1)))
      (if (i32.and (call $quad_is (local.get $q) (local.get $s) (local.get $p) (local.get $o))
        (i32.or (i32.eqz (local.get $g)) (i32.eq (i32.load offset=12 (local.get $q)) (local.get $g))))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $candidates))))
  (i32.const 0))

(func $gp_unknown (result i32) (call $gp_add (i32.const 4) (i32.const 1)) (i32.const 1))
(func (export "cq_may_match") (param $s i32) (param $p i32) (param $o i32) (result i32)
  (local $left i32) (local $gi i32) (local $result i32)
  (call $gp_add (i32.const 0) (i32.const 1))
  (if (call $gp_poll) (then (return (call $gp_unknown))))
  (local.set $left (i32.const 128))
  (loop $graphs
    (if (i32.lt_u (local.get $gi) (call $graph_count)) (then
      (if (i32.eqz (local.get $left)) (then (return (call $gp_unknown))))
      (local.set $left (i32.sub (local.get $left) (i32.const 1)))
      (call $gp_add (i32.const 1) (i32.const 1))
      (local.set $result (call $gp_any (local.get $s) (local.get $p) (local.get $o) (call $graph_at (local.get $gi)) (local.get $left)))
      (local.set $left (i32.sub (local.get $left) (global.get $gp_tested)))
      (call $gp_add (i32.const 2) (global.get $gp_tested))
      (if (i32.lt_s (local.get $result) (i32.const 0)) (then (return (call $gp_unknown))))
      (if (local.get $result) (then
        (if (call $gp_poll) (then (return (call $gp_unknown))))
        (call $gp_add (i32.const 5) (i32.const 1)) (return (i32.const 1))))
      (local.set $gi (i32.add (local.get $gi) (i32.const 1))) (br $graphs))))
  (if (call $gp_poll) (then (return (call $gp_unknown))))
  (call $gp_add (i32.const 3) (i32.const 1)) (i32.const 0))

;; Group entry is after its masking/substitution setup. Only the leading BGP
;; run is required; stop at all scope/optional/bind/union boundaries. Paths are
;; skipped, never tested as plain triples. One local block, up to four probes.
(func $group_guard (param $f i32) (param $el i32) (result i32)
  (local $n i32) (local $kind i32)
  (loop $elements
    (if (i32.and (i32.ne (local.get $el) (i32.const 0)) (i32.lt_u (local.get $n) (i32.const 4))) (then
      (local.set $kind (i32.load (local.get $el)))
      (if (i32.gt_u (i32.sub (local.get $kind) (i32.const P_TRIPLE)) (i32.const 1)) (then (return (i32.ne (local.get $n) (i32.const 0)))))
      (if (i32.eq (local.get $kind) (i32.const P_TRIPLE)) (then
        (if (i32.and (call $plain (i32.load offset=4 (local.get $el)))
          (i32.and (call $plain (i32.load offset=8 (local.get $el))) (call $plain (i32.load offset=12 (local.get $el))))) (then
          (if (i32.eqz (local.get $n)) (then (call $em0 (local.get $f) (@str "{"))))
          (call $push_ref (local.get $f) (i32.load offset=4 (local.get $el)))
          (call $push_ref (local.get $f) (i32.load offset=8 (local.get $el)))
          (call $push_ref (local.get $f) (i32.load offset=12 (local.get $el)))
          (call $em1 (local.get $f) (@str "CaEf0") (i32.const CX_MAY_MATCH))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))))
      (local.set $el (i32.load offset=28 (local.get $el))) (br $elements))))
  (i32.ne (local.get $n) (i32.const 0)))
