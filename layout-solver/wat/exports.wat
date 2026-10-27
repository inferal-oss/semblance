;; The ABI of layout-solver/rust/src/lib.rs, which src/layout/wasm.ts drives: one solver per
;; instance, numbers exchanged through buffers in linear memory.
;;
;; in:  f64 buffer (`buf`): terms as variable, coefficient pairs; suggestions as variable, value
;;      pairs; boxes for the checker
;; in:  i32 buffer (`prog`): the checker program
;; out: f64 buffer (`out`): values, or findings as invariant, member, by triples

(global $buf (mut i32) (i32.const 0))
(global $bufcap (mut i32) (i32.const 0))
(global $prog (mut i32) (i32.const 0))
(global $progcap (mut i32) (i32.const 0))
(global $proglen (mut i32) (i32.const 0))
(global $out (mut i32) (i32.const 0))
(global $outcap (mut i32) (i32.const 0))
(global $outlen (mut i32) (i32.const 0))

;; Room for n f64s in $out, keeping the first $outlen.
(func $out_reserve (param $n i32)
  (local $cap i32)
  (if (i32.le_u (local.get $n) (global.get $outcap)) (then (return)))
  (local.set $cap (i32.add (i32.shl (local.get $n) (i32.const 1)) (i32.const 16)))
  (global.set $out (call $realloc (global.get $out) (i32.shl (global.get $outcap) (i32.const 3)) (i32.shl (local.get $cap) (i32.const 3))))
  (global.set $outcap (local.get $cap)))

;; Reserve the f64 input buffer for n numbers; its address.
(func (export "buf") (param $n i32) (result i32)
  (if (i32.gt_u (local.get $n) (global.get $bufcap)) (then
    (call $free (global.get $buf) (i32.shl (global.get $bufcap) (i32.const 3)))
    (global.set $bufcap (local.get $n))
    (global.set $buf (call $alloc (i32.shl (local.get $n) (i32.const 3))))))
  (global.get $buf))

;; Reserve the i32 program buffer for n numbers; its address.
(func (export "prog") (param $n i32) (result i32)
  (if (i32.gt_u (local.get $n) (global.get $progcap)) (then
    (call $free (global.get $prog) (i32.shl (global.get $progcap) (i32.const 2)))
    (global.set $progcap (local.get $n))
    (global.set $prog (call $alloc (i32.shl (local.get $n) (i32.const 2))))))
  (global.set $proglen (local.get $n))
  (global.get $prog))

(func (export "out") (result i32) (global.get $out))

(func $reset
  (call $heap_reset)
  (global.set $buf (i32.const 0)) (global.set $bufcap (i32.const 0))
  (global.set $prog (i32.const 0)) (global.set $progcap (i32.const 0)) (global.set $proglen (i32.const 0))
  (global.set $out (i32.const 0)) (global.set $outcap (i32.const 0)) (global.set $outlen (i32.const 0))
  (call $solver_init))
(export "reset" (func $reset))
(start $reset)

(func (export "add_variable") (result i32) (call $add_variable))

;; Add `Σ terms + constant OP 0`, its n terms in buf; the constraint's id, or -1.
(func (export "add_constraint") (param $n i32) (param $constant f64) (param $op i32) (param $strength f64) (result i32)
  (call $add_constraint (global.get $buf) (local.get $n) (local.get $constant) (local.get $op) (local.get $strength)))

(func (export "remove_constraint") (param $id i32) (result i32) (call $remove_constraint (local.get $id)))
(func (export "add_edit_variable") (param $v i32) (param $strength f64) (result i32) (call $add_edit_variable (local.get $v) (local.get $strength)))
(func (export "remove_edit_variable") (param $v i32) (result i32) (call $remove_edit_variable (local.get $v)))

;; Suggest n values at once, as variable, value pairs in buf.
(func (export "suggest") (param $n i32) (result i32)
  (local $i i32) (local $p i32)
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $p (i32.add (global.get $buf) (i32.shl (local.get $i) (i32.const 4))))
    (if (i32.lt_s (call $suggest_value (i32.trunc_sat_f64_u (f64.load (local.get $p))) (f64.load offset=8 (local.get $p))) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each)))
  (i32.const 0))

;; Every variable's value into out; the count.
(func (export "values") (result i32)
  (local $i i32)
  (call $out_reserve (global.get $nvars))
  (block $done (loop $each
    (br_if $done (i32.ge_u (local.get $i) (global.get $nvars)))
    (f64.store (i32.add (global.get $out) (i32.shl (local.get $i) (i32.const 3))) (call $value (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each)))
  (global.get $nvars))

(func (export "pivots") (result f64) (f64.convert_i64_u (global.get $pivots)))

;; Run the checker program in prog over the boxes in buf; findings into out, their count back.
(func (export "check") (result i32) (call $check))
