;; Memory and the allocator (rdf-engine/wat/alloc.wat's scheme, on its own here).
;;
;; Layout: [0, 272) free-list heads, one i32 per size class; [272, 288) the one term of an edit
;; variable's constraint (exports.wat); the heap from HEAP, growing by bumping $top. Blocks have
;; no header: callers pass the size back to $free. Size classes are 2^k and 3*2^(k-1) bytes from
;; 16 up (16, 24, 32, 48, ...), all multiples of 8, so every block is aligned for f64.
;; reset() drops the whole heap at once.

(@define HEADS 272)
(@define EDIT_TERM 272)
(@define HEAP 512)

(memory (export "memory") 2)

(global $top (mut i32) (i32.const HEAP))

;; The size class of an n-byte request.
(func $class (param $n i32) (result i32)
  (local $k i32)
  (if (i32.lt_u (local.get $n) (i32.const 16)) (then (local.set $n (i32.const 16))))
  ;; k = ceil(log2 n); the class is 2k, or 2k-1 when 3*2^(k-2) bytes suffice
  (local.set $k (i32.sub (i32.const 32) (i32.clz (i32.sub (local.get $n) (i32.const 1)))))
  (i32.sub (i32.shl (local.get $k) (i32.const 1))
           (i32.le_u (local.get $n) (i32.shl (i32.const 3) (i32.sub (local.get $k) (i32.const 2))))))

(func $class_size (param $c i32) (result i32)
  (if (result i32) (i32.and (local.get $c) (i32.const 1))
    (then (i32.shl (i32.const 3) (i32.shr_u (i32.sub (local.get $c) (i32.const 3)) (i32.const 1))))
    (else (i32.shl (i32.const 1) (i32.shr_u (local.get $c) (i32.const 1))))))

(func $alloc (param $n i32) (result i32)
  (local $head i32) (local $p i32) (local $need i32) (local $pages i32)
  (local.set $head (i32.shl (call $class (local.get $n)) (i32.const 2)))
  (local.set $p (i32.load (local.get $head)))
  (if (local.get $p) (then
    (i32.store (local.get $head) (i32.load (local.get $p)))
    (return (local.get $p))))
  (local.set $p (global.get $top))
  (global.set $top (i32.add (local.get $p) (call $class_size (i32.shr_u (local.get $head) (i32.const 2)))))
  (local.set $pages (memory.size))
  (if (i32.gt_u (global.get $top) (i32.shl (local.get $pages) (i32.const 16))) (then
    ;; grow by what is needed, or by half the memory when that is more
    (local.set $need (i32.shr_u (i32.add (i32.sub (global.get $top) (i32.shl (local.get $pages) (i32.const 16))) (i32.const 0xffff)) (i32.const 16)))
    (local.set $pages (i32.shr_u (local.get $pages) (i32.const 1)))
    (if (i32.lt_s (memory.grow (select (local.get $pages) (local.get $need) (i32.gt_u (local.get $pages) (local.get $need)))) (i32.const 0))
      (then (if (i32.lt_s (memory.grow (local.get $need)) (i32.const 0)) (then unreachable))))))
  (local.get $p))

(func $alloc0 (param $n i32) (result i32)
  (local $p i32)
  (memory.fill (local.tee $p (call $alloc (local.get $n))) (i32.const 0) (local.get $n))
  (local.get $p))

(func $free (param $p i32) (param $n i32)
  (local $head i32)
  (if (i32.eqz (local.get $p)) (then (return)))
  (local.set $head (i32.shl (call $class (local.get $n)) (i32.const 2)))
  (i32.store (local.get $p) (i32.load (local.get $head)))
  (i32.store (local.get $head) (local.get $p)))

;; A block of `new` bytes holding the first `old` bytes of `p` (freed), the rest zero.
(func $realloc (param $p i32) (param $old i32) (param $new i32) (result i32)
  (local $q i32)
  (local.set $q (call $alloc (local.get $new)))
  (if (local.get $old) (then
    (memory.copy (local.get $q) (local.get $p) (local.get $old))
    (call $free (local.get $p) (local.get $old))))
  (memory.fill (i32.add (local.get $q) (local.get $old)) (i32.const 0) (i32.sub (local.get $new) (local.get $old)))
  (local.get $q))

;; Forget every block.
(func $heap_reset
  (memory.fill (i32.const 0) (i32.const 0) (i32.const HEADS))
  (global.set $top (i32.const HEAP)))
