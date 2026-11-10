;; Fetching (ABI.md, "Optional: fetching"): the requests a run made for SERVICE
;; results and LOADed documents, and the host's answers. A run that asks for
;; something not answered yet goes on as if it had no solutions there and ends
;; "waiting" (-3); the host answers and runs it again.
;;
;; A request (64 bytes): +0 state (FX_*), +4 kind, +8 target, +12 text, +16 its
;; length, +20 width, +24 names ((pointer, length) per variable), +28 binding
;; rows (a vector of width ids each, 0 = not sent), +32 their count, +36 answer,
;; +40 its bytes, +44 answer rows, +48 why, +52 its length, +56 asked by the
;; last run. Everything it holds is its own (allocated), not the query's.

(@define FX_WAITING 0) (@define FX_ANSWERED 1) (@define FX_FAILED 2)
(@define FX_SERVICE 1) (@define FX_LOAD 2)

(global $fx (mut i32) (i32.const 0))        ;; the requests (a vector of pointers)
(global $fx_wait (mut i32) (i32.const 0))   ;; this run asked for something not answered yet
(global $fx_err_p (mut i32) (i32.const 0))  ;; this run failed on a failed request: why
(global $fx_err_n (mut i32) (i32.const 0))

(func $fx_count (result i32)
  (if (result i32) (global.get $fx) (then (i32.load offset=4 (global.get $fx))) (else (i32.const 0))))

(func $fx_req (param $i i32) (result i32) (call $v_at (global.get $fx) (local.get $i)))

;; At the start of a run or update.
(func $fx_start
  (local $i i32)
  (global.set $fx_wait (i32.const 0))
  (if (global.get $fx_err_n) (then (call $free (global.get $fx_err_p) (global.get $fx_err_n))))
  (global.set $fx_err_n (i32.const 0))
  (loop $each (if (i32.lt_u (local.get $i) (call $fx_count)) (then
    (i32.store offset=56 (call $fx_req (local.get $i)) (i32.const 0))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))))

;; A run's or update's value n once its fetches are accounted for.
(func $fx_end (param $n i32) (result i32)
  (if (global.get $fx_err_n) (then (return (call $fail (global.get $fx_err_p) (global.get $fx_err_n)))))
  (if (global.get $fx_wait) (then
    (drop (call $fail (@str "waiting: SERVICE or LOAD needs the host to fetch (rdf-engine/ABI.md, fetching)")))
    (return (i32.const -3))))
  (local.get $n))

;; The run fails with prefix, the target's IRI, ">: " and why (the first failure wins).
(func $fx_fail (param $pp i32) (param $pn i32) (param $target i32) (param $wp i32) (param $wn i32)
  (local $n i32) (local $at i32) (local $r i32)
  (if (global.get $fx_err_n) (then (return)))
  (local.set $r (call $rec (local.get $target)))
  (local.set $n (i32.add (i32.add (local.get $pn) (i32.load offset=12 (local.get $r))) (i32.add (local.get $wn) (i32.const 3))))
  (local.set $at (local.tee $n (call $alloc (local.get $n))))
  (global.set $fx_err_p (local.get $n))
  (local.set $at (call $sv_put (local.get $at) (local.get $pp) (local.get $pn)))
  (local.set $at (call $sv_put (local.get $at) (i32.load offset=8 (local.get $r)) (i32.load offset=12 (local.get $r))))
  (local.set $at (call $sv_put (local.get $at) (@str ">: ")))
  (local.set $at (call $sv_put (local.get $at) (local.get $wp) (local.get $wn)))
  (global.set $fx_err_n (i32.sub (local.get $at) (global.get $fx_err_p))))

(func $fx_free (param $r i32)
  (local $i i32) (local $w i32) (local $names i32)
  (local.set $w (i32.load offset=20 (local.get $r)))
  (local.set $names (i32.load offset=24 (local.get $r)))
  (loop $each (if (i32.lt_u (local.get $i) (local.get $w)) (then
    (call $free (i32.load (i32.add (local.get $names) (i32.shl (local.get $i) (i32.const 3))))
                (i32.load offset=4 (i32.add (local.get $names) (i32.shl (local.get $i) (i32.const 3)))))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
  (if (local.get $w) (then (call $free (local.get $names) (i32.shl (local.get $w) (i32.const 3)))))
  (if (i32.load offset=16 (local.get $r)) (then (call $free (i32.load offset=12 (local.get $r)) (i32.load offset=16 (local.get $r)))))
  (call $v_free (i32.load offset=28 (local.get $r)))
  (call $fx_drop_answer (local.get $r))
  (call $free (local.get $r) (i32.const 64)))

(func $fx_drop_answer (param $r i32)
  (if (i32.load offset=40 (local.get $r)) (then (call $free (i32.load offset=36 (local.get $r)) (i32.load offset=40 (local.get $r)))))
  (if (i32.load offset=52 (local.get $r)) (then (call $free (i32.load offset=48 (local.get $r)) (i32.load offset=52 (local.get $r)))))
  (i32.store offset=40 (local.get $r) (i32.const 0))
  (i32.store offset=44 (local.get $r) (i32.const 0))
  (i32.store offset=52 (local.get $r) (i32.const 0)))

(func $fx_clear
  (local $i i32)
  (loop $each (if (i32.lt_u (local.get $i) (call $fx_count)) (then
    (call $fx_free (call $fx_req (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
  (if (global.get $fx) (then (i32.store offset=4 (global.get $fx) (i32.const 0))))
  (global.set $fx_wait (i32.const 0))
  (if (global.get $fx_err_n) (then (call $free (global.get $fx_err_p) (global.get $fx_err_n))))
  (global.set $fx_err_n (i32.const 0)))

;; A new request, waiting and asked; its row vector empty.
(func $fx_new (param $kind i32) (param $target i32) (result i32)
  (local $r i32)
  (local.set $r (call $alloc0 (i32.const 64)))
  (i32.store offset=4 (local.get $r) (local.get $kind))
  (i32.store offset=8 (local.get $r) (local.get $target))
  (i32.store offset=28 (local.get $r) (call $v_new))
  (i32.store offset=56 (local.get $r) (i32.const 1))
  (if (i32.eqz (global.get $fx)) (then (global.set $fx (call $v_new))))
  (call $v_push1 (global.get $fx) (local.get $r))
  (local.get $r))

;; Binding row i of request r.
(func $fx_row (param $r i32) (param $i i32) (result i32)
  (i32.add (i32.load (i32.load offset=28 (local.get $r))) (i32.shl (i32.mul (local.get $i) (i32.load offset=20 (local.get $r))) (i32.const 2))))

;; Whether request r holds binding row (w ids).
(func $fx_holds (param $r i32) (param $row i32) (result i32)
  (local $i i32) (local $w i32)
  (local.set $w (i32.load offset=20 (local.get $r)))
  (loop $rows (if (i32.lt_u (local.get $i) (i32.load offset=32 (local.get $r))) (then
    (if (call $memeq (call $fx_row (local.get $r) (local.get $i)) (local.get $row) (i32.shl (local.get $w) (i32.const 2))) (then (return (i32.const 1))))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $rows))))
  (i32.const 0))

;; Whether r is the SERVICE request (target, text, the domain of row): its rows bind the positions row binds.
(func $fx_key (param $r i32) (param $target i32) (param $tp i32) (param $tn i32) (param $row i32) (result i32)
  (local $j i32) (local $first i32)
  (if (i32.or (i32.ne (i32.load offset=4 (local.get $r)) (i32.const FX_SERVICE)) (i32.ne (i32.load offset=8 (local.get $r)) (local.get $target)))
    (then (return (i32.const 0))))
  (if (i32.ne (i32.load offset=16 (local.get $r)) (local.get $tn)) (then (return (i32.const 0))))
  (if (i32.eqz (call $memeq (i32.load offset=12 (local.get $r)) (local.get $tp) (local.get $tn))) (then (return (i32.const 0))))
  (if (i32.eqz (i32.load offset=32 (local.get $r))) (then (return (i32.const 1))))
  (local.set $first (call $fx_row (local.get $r) (i32.const 0)))
  (loop $slots (if (i32.lt_u (local.get $j) (i32.load offset=20 (local.get $r))) (then
    (if (i32.ne (i32.eqz (i32.load (i32.add (local.get $first) (i32.shl (local.get $j) (i32.const 2)))))
                (i32.eqz (i32.load (i32.add (local.get $row) (i32.shl (local.get $j) (i32.const 2))))))
      (then (return (i32.const 0))))
    (local.set $j (i32.add (local.get $j) (i32.const 1))) (br $slots))))
  (i32.const 1))

(func $fx_add_row (param $r i32) (param $row i32)
  (local $j i32)
  (loop $ids (if (i32.lt_u (local.get $j) (i32.load offset=20 (local.get $r))) (then
    (call $v_push1 (i32.load offset=28 (local.get $r)) (i32.load (i32.add (local.get $row) (i32.shl (local.get $j) (i32.const 2)))))
    (local.set $j (i32.add (local.get $j) (i32.const 1))) (br $ids))))
  (i32.store offset=32 (local.get $r) (i32.add (i32.load offset=32 (local.get $r)) (i32.const 1)))
  (i32.store offset=56 (local.get $r) (i32.const 1)))

;; The request answering binding row (of SERVICE el, to target) if it was answered or
;; failed; otherwise it is asked for (the run then waits) and 0.
(func $fx_service (param $target i32) (param $el i32) (param $row i32) (result i32)
  (local $i i32) (local $r i32) (local $tp i32) (local $tn i32) (local $w i32) (local $names i32) (local $e i32) (local $p i32)
  (local.set $tp (i32.load offset=12 (local.get $el)))
  (local.set $tn (i32.load offset=16 (local.get $el)))
  (loop $done (if (i32.lt_u (local.get $i) (call $fx_count)) (then
    (local.set $r (call $fx_req (local.get $i)))
    (if (i32.and (i32.ne (i32.load (local.get $r)) (i32.const FX_WAITING))
                 (call $fx_key (local.get $r) (local.get $target) (local.get $tp) (local.get $tn) (local.get $row)))
      (then (if (call $fx_holds (local.get $r) (local.get $row)) (then (return (local.get $r))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $done))))
  (global.set $fx_wait (i32.const 1))
  ;; a waiting request with this key: this row joins it, if it is not there yet
  (local.set $i (i32.const 0))
  (loop $waiting (if (i32.lt_u (local.get $i) (call $fx_count)) (then
    (local.set $r (call $fx_req (local.get $i)))
    (if (i32.and (i32.eqz (i32.load (local.get $r)))
                 (call $fx_key (local.get $r) (local.get $target) (local.get $tp) (local.get $tn) (local.get $row))) (then
      (i32.store offset=56 (local.get $r) (i32.const 1))
      (if (i32.eqz (call $fx_holds (local.get $r) (local.get $row))) (then (call $fx_add_row (local.get $r) (local.get $row))))
      (return (i32.const 0))))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $waiting))))
  ;; a new request: the text and the variables' names are copied
  (local.set $r (call $fx_new (i32.const FX_SERVICE) (local.get $target)))
  (memory.copy (local.tee $p (call $alloc (local.get $tn))) (local.get $tp) (local.get $tn))
  (i32.store offset=12 (local.get $r) (local.get $p))
  (i32.store offset=16 (local.get $r) (local.get $tn))
  (local.set $w (i32.load offset=24 (local.get $el)))
  (i32.store offset=20 (local.get $r) (local.get $w))
  (if (local.get $w) (then
    (local.set $names (call $alloc (i32.shl (local.get $w) (i32.const 3))))
    (local.set $i (i32.const 0))
    (loop $each (if (i32.lt_u (local.get $i) (local.get $w)) (then
      (local.set $e (i32.load (i32.add (i32.load offset=56 (global.get $q))
        (i32.shl (i32.load (i32.add (i32.load offset=20 (local.get $el)) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 2)))))
      (memory.copy (local.tee $p (call $alloc (i32.load offset=4 (local.get $e)))) (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))
      (i32.store (i32.add (local.get $names) (i32.shl (local.get $i) (i32.const 3))) (local.get $p))
      (i32.store offset=4 (i32.add (local.get $names) (i32.shl (local.get $i) (i32.const 3))) (i32.load offset=4 (local.get $e)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
    (i32.store offset=24 (local.get $r) (local.get $names))))
  (call $fx_add_row (local.get $r) (local.get $row))
  (i32.const 0))

;; The request for this document, if answered or failed; otherwise it is asked for and 0.
(func $fx_load (param $target i32) (result i32)
  (local $i i32) (local $r i32)
  (loop $each (if (i32.lt_u (local.get $i) (call $fx_count)) (then
    (local.set $r (call $fx_req (local.get $i)))
    (if (i32.and (i32.eq (i32.load offset=4 (local.get $r)) (i32.const FX_LOAD)) (i32.eq (i32.load offset=8 (local.get $r)) (local.get $target))) (then
      (if (i32.load (local.get $r)) (then (return (local.get $r))))
      (global.set $fx_wait (i32.const 1))
      (i32.store offset=56 (local.get $r) (i32.const 1))
      (return (i32.const 0))))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
  (global.set $fx_wait (i32.const 1))
  (drop (call $fx_new (i32.const FX_LOAD) (local.get $target)))
  (i32.const 0))

;; --- evaluation -----------------------------------------------------------------------

;; SERVICE el joined with t, onto out: for each row, the answer rows compatible with it, merged.
(func $service_elem (param $el i32) (param $t i32) (param $out i32)
  (local $i i32) (local $mu i32) (local $ref i32) (local $ep i32) (local $w i32) (local $row i32) (local $j i32)
  (local $x i32) (local $r i32) (local $k i32) (local $ans i32) (local $at i32) (local $cur i32) (local $m i32) (local $ok i32)
  (local.set $ref (i32.load offset=4 (local.get $el)))
  (local.set $w (i32.load offset=24 (local.get $el)))
  (local.set $row (call $rs_alloc (i32.shl (i32.add (local.get $w) (i32.const 1)) (i32.const 2))))
  (block $stop
    (loop $rows
      (br_if $stop (i32.ge_u (local.get $i) (i32.load offset=4 (local.get $t))))
      (local.set $mu (call $t_row (local.get $t) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      ;; the endpoint: from the row, or (a variable not in scope before it) a parameter
      (local.set $ep (if (result i32) (i32.or (i32.gt_s (local.get $ref) (i32.const 0)) (i32.and (i32.load offset=8 (local.get $el)) (i32.const SV_LOCAL)))
        (then (call $resolve_ref (local.get $ref) (local.get $mu)))
        (else (i32.load (i32.add (global.get $params) (i32.shl (i32.sub (i32.const -1) (local.get $ref)) (i32.const 2)))))))
      ;; no IRI to ask (unbound, a literal, a blank node): no solutions, not an error, so the result
      ;; does not depend on whether a FILTER on the endpoint ran before SERVICE or after
      (if (i32.or (i32.le_s (local.get $ep) (i32.const 0)) (i32.ne (call $kind (local.get $ep)) (i32.const 1))) (then
        (if (i32.and (i32.load offset=8 (local.get $el)) (i32.const SV_SILENT)) (then (call $t_push (local.get $out) (local.get $mu))))
        (br $rows)))
      ;; the binding row: blank nodes and triple terms are not sent
      (local.set $j (i32.const 0))
      (loop $slots (if (i32.lt_u (local.get $j) (local.get $w)) (then
        (local.set $x (i32.load (i32.add (local.get $mu) (i32.shl (i32.load (i32.add (i32.load offset=20 (local.get $el)) (i32.shl (local.get $j) (i32.const 2)))) (i32.const 2)))))
        (if (i32.ge_u (i32.sub (call $kind (local.get $x)) (i32.const 1)) (i32.const 3)) (then (local.set $x (i32.const 0))))
        (if (i32.eq (call $kind (local.get $x)) (i32.const 2)) (then (local.set $x (i32.const 0))))
        (i32.store (i32.add (local.get $row) (i32.shl (local.get $j) (i32.const 2))) (local.get $x))
        (local.set $j (i32.add (local.get $j) (i32.const 1))) (br $slots))))
      (br_if $rows (i32.eqz (local.tee $r (call $fx_service (local.get $ep) (local.get $el) (local.get $row)))))
      (if (i32.eq (i32.load (local.get $r)) (i32.const FX_FAILED)) (then
        (if (i32.and (i32.load offset=8 (local.get $el)) (i32.const SV_SILENT))
          (then (call $t_push (local.get $out) (local.get $mu)))
          (else (call $fx_fail (@str "SERVICE <") (local.get $ep) (i32.load offset=48 (local.get $r)) (i32.load offset=52 (local.get $r)))))
        (br $rows)))
      (local.set $k (i32.const 0))
      (local.set $ans (i32.load offset=36 (local.get $r)))
      (loop $answers (if (i32.lt_u (local.get $k) (i32.load offset=44 (local.get $r))) (then
        (br_if $stop (call $step))
        (local.set $m (call $t_add (local.get $out)))
        (memory.copy (local.get $m) (local.get $mu) (global.get $W))
        (local.set $ok (i32.const 1))
        (local.set $j (i32.const 0))
        (loop $slots (if (i32.and (local.get $ok) (i32.lt_u (local.get $j) (local.get $w))) (then
          (if (local.tee $x (i32.load (i32.add (local.get $ans) (i32.shl (i32.add (i32.mul (local.get $k) (local.get $w)) (local.get $j)) (i32.const 2))))) (then
            (local.set $at (i32.add (local.get $m) (i32.shl (i32.load (i32.add (i32.load offset=20 (local.get $el)) (i32.shl (local.get $j) (i32.const 2)))) (i32.const 2))))
            (if (i32.eqz (local.tee $cur (i32.load (local.get $at))))
              (then (i32.store (local.get $at) (local.get $x)))
              (else (local.set $ok (i32.eq (local.get $cur) (local.get $x)))))))
          (local.set $j (i32.add (local.get $j) (i32.const 1))) (br $slots))))
        ;; incompatible: the row added is taken back
        (if (i32.eqz (local.get $ok)) (then (i32.store offset=4 (local.get $out) (i32.sub (i32.load offset=4 (local.get $out)) (i32.const 1)))))
        (local.set $k (i32.add (local.get $k) (i32.const 1))) (br $answers))))
      (br $rows)))
  (call $row_put (local.get $row)))

;; LOAD (update op q): answered, the document's triples added to its graph; failed, an error
;; unless SILENT; not answered, nothing (the update waits). 0, or -1 after an error.
(func $load_op (param $q i32) (result i32)
  (local $r i32) (local $i i32) (local $at i32)
  (if (i32.eqz (local.tee $r (call $fx_load (i32.load offset=212 (local.get $q))))) (then (return (i32.const 0))))
  (if (i32.eq (i32.load (local.get $r)) (i32.const FX_FAILED)) (then
    (if (i32.load offset=208 (local.get $q)) (then (return (i32.const 0))))
    (call $fx_fail (@str "LOAD <") (i32.load offset=212 (local.get $q)) (i32.load offset=48 (local.get $r)) (i32.load offset=52 (local.get $r)))
    (return (i32.const -1))))
  (local.set $at (i32.load offset=36 (local.get $r)))
  (loop $triples (if (i32.lt_u (local.get $i) (i32.load offset=44 (local.get $r))) (then
    (call $u_add (i32.load (local.get $at)) (i32.load offset=4 (local.get $at)) (i32.load offset=8 (local.get $at)) (i32.load offset=216 (local.get $q)))
    (local.set $at (i32.add (local.get $at) (i32.const 12)))
    (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $triples))))
  (i32.const 0))

;; --- exports ---------------------------------------------------------------------------

(func (export "fetch_count") (result i32) (call $fx_count))

(func (export "fetch_request") (param $i i32) (result i32)
  (local $r i32) (local $n i32)
  (if (i32.ge_u (local.get $i) (call $fx_count)) (then (return (call $fail (@str "no such request")))))
  (local.set $r (call $fx_req (local.get $i)))
  (local.set $n (i32.mul (i32.load offset=32 (local.get $r)) (i32.load offset=20 (local.get $r))))
  (call $res_reserve (i32.shl (i32.add (local.get $n) (i32.const 5)) (i32.const 2)))
  (i32.store (global.get $res) (i32.load (local.get $r)))
  (i32.store offset=4 (global.get $res) (i32.load offset=4 (local.get $r)))
  (i32.store offset=8 (global.get $res) (i32.load offset=8 (local.get $r)))
  (i32.store offset=12 (global.get $res) (i32.load offset=20 (local.get $r)))
  (i32.store offset=16 (global.get $res) (i32.load offset=56 (local.get $r)))
  (memory.copy (i32.add (global.get $res) (i32.const 20)) (i32.load (i32.load offset=28 (local.get $r))) (i32.shl (local.get $n) (i32.const 2)))
  (i32.load offset=32 (local.get $r)))

(func (export "fetch_text_ptr") (param $i i32) (result i32)
  (if (result i32) (i32.lt_u (local.get $i) (call $fx_count)) (then (i32.load offset=12 (call $fx_req (local.get $i)))) (else (i32.const 0))))
(func (export "fetch_text_len") (param $i i32) (result i32)
  (if (result i32) (i32.lt_u (local.get $i) (call $fx_count)) (then (i32.load offset=16 (call $fx_req (local.get $i)))) (else (i32.const 0))))

(func $fx_name (param $i i32) (param $j i32) (result i32)
  (local $r i32)
  (if (i32.ge_u (local.get $i) (call $fx_count)) (then (return (i32.const 0))))
  (local.set $r (call $fx_req (local.get $i)))
  (if (i32.ge_u (local.get $j) (i32.load offset=20 (local.get $r))) (then (return (i32.const 0))))
  (i32.add (i32.load offset=24 (local.get $r)) (i32.shl (local.get $j) (i32.const 3))))
(func (export "fetch_var_ptr") (param $i i32) (param $j i32) (result i32)
  (local $p i32)
  (if (result i32) (local.tee $p (call $fx_name (local.get $i) (local.get $j))) (then (i32.load (local.get $p))) (else (i32.const 0))))
(func (export "fetch_var_len") (param $i i32) (param $j i32) (result i32)
  (local $p i32)
  (if (result i32) (local.tee $p (call $fx_name (local.get $i) (local.get $j))) (then (i32.load offset=4 (local.get $p))) (else (i32.const 0))))

;; Every id an answer gives must be a live term, and a LOAD triple a valid one:
;; an answer is the host's, but its terms come from elsewhere.
(func (export "fetch_answer") (param $i i32) (param $n i32) (result i32)
  (local $r i32) (local $w i32) (local $bytes i32) (local $k i32) (local $id i32) (local $at i32) (local $p i32)
  (if (i32.ge_u (local.get $i) (call $fx_count)) (then (return (call $fail (@str "no such request")))))
  (local.set $r (call $fx_req (local.get $i)))
  (local.set $w (select (i32.const 3) (i32.load offset=20 (local.get $r)) (i32.eq (i32.load offset=4 (local.get $r)) (i32.const FX_LOAD))))
  (if (local.get $w) (then
    (if (i32.gt_u (local.get $n) (i32.div_u (global.get $in_cap) (i32.shl (local.get $w) (i32.const 2))))
      (then (return (call $fail (@str "answer larger than the input buffer")))))))
  (local.set $bytes (i32.shl (i32.mul (local.get $n) (local.get $w)) (i32.const 2)))
  (if (i32.eq (local.get $w) (i32.const 3))
    (then
      (if (i32.eq (i32.load offset=4 (local.get $r)) (i32.const FX_LOAD)) (then
        (loop $triples (if (i32.lt_u (local.get $k) (local.get $bytes)) (then
          (local.set $at (i32.add (global.get $in) (local.get $k)))
          (local.set $p (call $kind (i32.load (local.get $at))))
          (if (i32.or (i32.or (i32.eqz (local.get $p)) (i32.eq (local.get $p) (i32.const 3))) (i32.eq (local.get $p) (i32.const 5)))
            (then (return (call $fail (@str "an answer triple is not a valid triple")))))
          (if (i32.ne (call $kind (i32.load offset=4 (local.get $at))) (i32.const 1))
            (then (return (call $fail (@str "an answer triple is not a valid triple")))))
          (local.set $p (call $kind (i32.load offset=8 (local.get $at))))
          (if (i32.or (i32.eqz (local.get $p)) (i32.eq (local.get $p) (i32.const 5)))
            (then (return (call $fail (@str "an answer triple is not a valid triple")))))
          (local.set $k (i32.add (local.get $k) (i32.const 12))) (br $triples))))
        (local.set $k (local.get $bytes))))))
  (loop $ids (if (i32.lt_u (local.get $k) (local.get $bytes)) (then
    (if (local.tee $id (i32.load (i32.add (global.get $in) (local.get $k)))) (then
      (local.set $p (call $kind (local.get $id)))
      (if (i32.or (i32.eqz (local.get $p)) (i32.eq (local.get $p) (i32.const 5)))
        (then (return (call $fail (@str "an answer holds an id that is not a term")))))))
    (local.set $k (i32.add (local.get $k) (i32.const 4))) (br $ids))))
  (call $fx_drop_answer (local.get $r))
  (if (local.get $bytes) (then
    (memory.copy (local.tee $p (call $alloc (local.get $bytes))) (global.get $in) (local.get $bytes))
    (i32.store offset=36 (local.get $r) (local.get $p))
    (i32.store offset=40 (local.get $r) (local.get $bytes))))
  (i32.store offset=44 (local.get $r) (local.get $n))
  (i32.store (local.get $r) (i32.const FX_ANSWERED))
  (i32.const 0))

(func (export "fetch_fail") (param $i i32) (param $n i32) (result i32)
  (local $r i32) (local $p i32)
  (if (i32.ge_u (local.get $i) (call $fx_count)) (then (return (call $fail (@str "no such request")))))
  (if (i32.gt_u (local.get $n) (global.get $in_cap)) (then (return (call $fail (@str "message larger than the input buffer")))))
  (local.set $r (call $fx_req (local.get $i)))
  (call $fx_drop_answer (local.get $r))
  (if (local.get $n) (then
    (memory.copy (local.tee $p (call $alloc (local.get $n))) (global.get $in) (local.get $n))
    (i32.store offset=48 (local.get $r) (local.get $p))
    (i32.store offset=52 (local.get $r) (local.get $n))))
  (i32.store (local.get $r) (i32.const FX_FAILED))
  (i32.const 0))

(func (export "fetch_clear") (result i32)
  (call $fx_clear)
  (i32.const 0))
