;; Bounded numeric input: full lexical validation, an 800-digit lower prefix
;; and sticky tail, then one nearest/ties-even IEEE rounding. Eight 256-u32
;; limb buffers (8192 bytes + 32 length bytes) are distinct from the formatter.
;; All scratch is per engine instance; official host import callbacks cannot
;; reenter that instance. No input-sized copy or change to evaluator row fuel.

(global $nu_work (mut i32) (i32.const 0))

(global $nu_units (mut i32) (i32.const 0))

(global $nu_stop (mut i32) (i32.const 0))

(global $nu_first (mut i32) (i32.const 0))

(global $nu_end (mut i32) (i32.const 0))

(global $nu_sig (mut i64) (i64.const 0))

(global $nu_frac (mut i64) (i64.const 0))

(global $nu_trail (mut i64) (i64.const 0))

(global $nu_exp (mut i64) (i64.const 0))

(global $nu_neg (mut i32) (i32.const 0))

(global $nu_special (mut i32) (i32.const 0))

(global $nu_value (mut f64) (f64.const 0))

(global $nu_integer (mut i64) (i64.const 0))

(global $nu_scale (mut i32) (i32.const 0))

(func $nu_poll  (result i32)

  (if (i32.eqz (global.get $nu_stop)) (then
  (global.set $nu_stop (call $bu_poll_deadline ))))
  (global.get $nu_stop))

(func $nu_tick  (result i32)

  (global.set $nu_units (i32.add (global.get $nu_units) (i32.const 1)))
  (if (i32.ge_u (global.get $nu_units) (i32.const 256)) (then
  (global.set $nu_units (i32.const 0))
  (drop (call $nu_poll ))))
  (global.get $nu_stop))

(func $nu_buffer (param $slot i32) (result i32)

  (if (i32.eqz (global.get $nu_work)) (then
  (global.set $nu_work (call $alloc (i32.const 8224)))))
  (i32.add (global.get $nu_work) (i32.mul (local.get $slot) (i32.const 1028))))

(func $nu_at (param $b i32) (param $i i32) (result i32)

  (i32.add (local.get $b) (i32.add (i32.const 4) (i32.shl (local.get $i) (i32.const 2)))))

(func $nu_small (param $b i32) (param $v i32)

  (i32.store (local.get $b) (i32.ne (local.get $v) (i32.const 0)))
  (i32.store offset=4 (local.get $b) (local.get $v)))

(func $nu_mul (param $b i32) (param $m i32) (param $add i32)
  (local $i i32) (local $n i32) (local $carry i64)
  (local.set $n (i32.load (local.get $b)))
  (local.set $carry (i64.extend_i32_u (local.get $add)))
  (loop $words
    (if (i32.lt_u (local.get $i) (local.get $n)) (then
      (local.set $carry (i64.add (i64.mul (i64.extend_i32_u (i32.load (call $nu_at (local.get $b) (local.get $i)))) (i64.extend_i32_u (local.get $m))) (local.get $carry)))
      (i32.store (call $nu_at (local.get $b) (local.get $i)) (i32.wrap_i64 (local.get $carry)))
      (local.set $carry (i64.shr_u (local.get $carry) (i64.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (call $nu_tick) (then (return)))
      (br $words))))
  (if (i64.ne (local.get $carry) (i64.const 0)) (then
  (if (i32.ge_u (local.get $n) (i32.const 256)) (then
  unreachable))
  (i32.store (call $nu_at (local.get $b) (local.get $n)) (i32.wrap_i64 (local.get $carry)))
  (i32.store (local.get $b) (i32.add (local.get $n) (i32.const 1))))))

(func $nu_shift (param $dst i32) (param $src i32) (param $shift i32)
  (local $n i32) (local $words i32) (local $bits i32) (local $i i32) (local $v i64) (local $carry i64)
  (local.set $n (i32.load (local.get $src)))
  (if (i32.eqz (local.get $n)) (then
  (i32.store (local.get $dst) (i32.const 0))
  (return)))
  (local.set $words (i32.shr_u (local.get $shift) (i32.const 5)))
  (local.set $bits (i32.and (local.get $shift) (i32.const 31)))
  (if (i32.gt_u (i32.add (local.get $n) (local.get $words)) (i32.const 256)) (then
  unreachable))
  (loop $zero
    (if (i32.lt_u (local.get $i) (local.get $words)) (then
      (i32.store (call $nu_at (local.get $dst) (local.get $i)) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (call $nu_tick) (then (return))) (br $zero))))
  (local.set $i (i32.const 0))
  (loop $copy
    (if (i32.lt_u (local.get $i) (local.get $n)) (then
      (local.set $v (i64.or (i64.shl (i64.extend_i32_u (i32.load (call $nu_at (local.get $src) (local.get $i)))) (i64.extend_i32_u (local.get $bits))) (local.get $carry)))
      (i32.store (call $nu_at (local.get $dst) (i32.add (local.get $words) (local.get $i))) (i32.wrap_i64 (local.get $v)))
      (local.set $carry (i64.shr_u (local.get $v) (i64.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (call $nu_tick) (then (return))) (br $copy))))
  (local.set $n (i32.add (local.get $n) (local.get $words)))
  (if (i64.ne (local.get $carry) (i64.const 0)) (then
  (if (i32.ge_u (local.get $n) (i32.const 256)) (then
  unreachable))
  (i32.store (call $nu_at (local.get $dst) (local.get $n)) (i32.wrap_i64 (local.get $carry)))
  (local.set $n (i32.add (local.get $n) (i32.const 1)))))
  (i32.store (local.get $dst) (local.get $n)))

(func $nu_bits (param $b i32) (result i32)
  (local $n i32)
  (local.set $n (i32.load (local.get $b)))
  (if (i32.eqz (local.get $n)) (then
  (return (i32.const 0))))
  (i32.sub (i32.shl (local.get $n) (i32.const 5)) (i32.clz (i32.load (call $nu_at (local.get $b) (i32.sub (local.get $n) (i32.const 1)))))))

(func $nu_cmp (param $a i32) (param $b i32) (result i32)
  (local $n i32) (local $m i32) (local $x i32) (local $y i32)
  (local.set $n (i32.load (local.get $a)))
  (local.set $m (i32.load (local.get $b)))
  (if (i32.ne (local.get $n) (local.get $m)) (then
  (return (i32.sub (i32.gt_u (local.get $n) (local.get $m)) (i32.lt_u (local.get $n) (local.get $m))))))
  (loop $cmp
    (if (local.get $n) (then
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (local.set $x (i32.load (call $nu_at (local.get $a) (local.get $n))))
      (local.set $y (i32.load (call $nu_at (local.get $b) (local.get $n))))
      (if (call $nu_tick) (then (return (i32.const 0))))
      (if (i32.ne (local.get $x) (local.get $y)) (then (return (i32.sub (i32.gt_u (local.get $x) (local.get $y)) (i32.lt_u (local.get $x) (local.get $y))))))
      (br $cmp))))
  (i32.const 0))

(func $nu_sub (param $a i32) (param $b i32)
  (local $i i32) (local $n i32) (local $m i32) (local $x i64) (local $y i64) (local $borrow i64)
  (local.set $n (i32.load (local.get $a)))
  (local.set $m (i32.load (local.get $b)))
  (loop $sub
    (if (i32.lt_u (local.get $i) (local.get $n)) (then
      (local.set $x (i64.extend_i32_u (i32.load (call $nu_at (local.get $a) (local.get $i)))))
      (local.set $y (local.get $borrow))
      (if (i32.lt_u (local.get $i) (local.get $m)) (then
        (local.set $y (i64.add (local.get $y) (i64.extend_i32_u (i32.load (call $nu_at (local.get $b) (local.get $i))))))))
      (i32.store (call $nu_at (local.get $a) (local.get $i)) (i32.wrap_i64 (i64.sub (local.get $x) (local.get $y))))
      (local.set $borrow (i64.extend_i32_u (i64.lt_u (local.get $x) (local.get $y))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (call $nu_tick) (then (return))) (br $sub))))
  (if (i64.ne (local.get $borrow) (i64.const 0)) (then
  unreachable))
  (block $done (loop $trim
    (br_if $done (i32.eqz (local.get $n)))
    (br_if $done (i32.load (call $nu_at (local.get $a) (i32.sub (local.get $n) (i32.const 1)))))
    (local.set $n (i32.sub (local.get $n) (i32.const 1)))
    (if (call $nu_tick) (then (return))) (br $trim)))
  (i32.store (local.get $a) (local.get $n)))

(func $nu_space (param $c i32) (result i32)

  (i32.or (i32.eq (local.get $c) (i32.const 32)) (i32.or (i32.eq (local.get $c) (i32.const 9)) (i32.or (i32.eq (local.get $c) (i32.const 10)) (i32.eq (local.get $c) (i32.const 13))))))

(func $nu_family (param $dt i32) (result i32)
  (local $p i32) (local $n i32)
  (if (i32.le_u (call $tlen (local.get $dt)) (i32.const 33)) (then
  (return (i32.const 0))))
  (if (i32.eqz (call $memeq (call $tval (local.get $dt)) (@str "http://www.w3.org/2001/XMLSchema#"))) (then
  (return (i32.const 0))))
  (local.set $p (i32.add (call $tval (local.get $dt)) (i32.const 33)))
  (local.set $n (i32.sub (call $tlen (local.get $dt)) (i32.const 33)))
  (if (call $same (local.get $p) (local.get $n) (@str "integer") (i32.const 0)) (then
  (return (i32.const 1))))
  (if (call $same (local.get $p) (local.get $n) (@str "decimal") (i32.const 0)) (then
  (return (i32.const 2))))
  (if (call $same (local.get $p) (local.get $n) (@str "float") (i32.const 0)) (then
  (return (i32.const 3))))
  (if (call $same (local.get $p) (local.get $n) (@str "double") (i32.const 0)) (then
  (return (i32.const 4))))
  (if (call $same (local.get $p) (local.get $n) (@str "long") (i32.const 0)) (then
  (return (i32.const 5))))
  (if (call $same (local.get $p) (local.get $n) (@str "int") (i32.const 0)) (then
  (return (i32.const 6))))
  (if (call $same (local.get $p) (local.get $n) (@str "short") (i32.const 0)) (then
  (return (i32.const 7))))
  (if (call $same (local.get $p) (local.get $n) (@str "byte") (i32.const 0)) (then
  (return (i32.const 8))))
  (if (call $same (local.get $p) (local.get $n) (@str "nonNegativeInteger") (i32.const 0)) (then
  (return (i32.const 9))))
  (if (call $same (local.get $p) (local.get $n) (@str "positiveInteger") (i32.const 0)) (then
  (return (i32.const 10))))
  (if (call $same (local.get $p) (local.get $n) (@str "nonPositiveInteger") (i32.const 0)) (then
  (return (i32.const 11))))
  (if (call $same (local.get $p) (local.get $n) (@str "negativeInteger") (i32.const 0)) (then
  (return (i32.const 12))))
  (if (call $same (local.get $p) (local.get $n) (@str "unsignedLong") (i32.const 0)) (then
  (return (i32.const 13))))
  (if (call $same (local.get $p) (local.get $n) (@str "unsignedInt") (i32.const 0)) (then
  (return (i32.const 14))))
  (if (call $same (local.get $p) (local.get $n) (@str "unsignedShort") (i32.const 0)) (then
  (return (i32.const 15))))
  (if (call $same (local.get $p) (local.get $n) (@str "unsignedByte") (i32.const 0)) (then
  (return (i32.const 16))))
  (i32.const 0))

;; Family range comparison operates on normalized decimal digits, before any
;; native i64 or IEEE conversion. Zero has no mathematical negative sign.
(func $nu_validate (param $p i32) (param $n i32) (param $family i32) (result i32)
  (local $end i32) (local $begin i32) (local $digits i32) (local $dot i32)
  (local $c i32) (local $floating i32) (local $eneg i32) (local $cap i64)
  (local $limit i32) (local $limit_n i32) (local $i i32)
  (global.set $nu_units (i32.const 0))
  (global.set $nu_stop (i32.const 0))
  (if (call $nu_poll) (then (return (i32.const 0))))
  (if (i32.gt_u (local.get $p) (i32.add (local.get $p) (local.get $n))) (then unreachable))
  (local.set $end (i32.add (local.get $p) (local.get $n)))
  (block $left (loop $trim
    (br_if $left (i32.ge_u (local.get $p) (local.get $end)))
    (br_if $left (i32.eqz (call $nu_space (i32.load8_u (local.get $p)))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (if (call $nu_tick) (then (return (i32.const 0)))) (br $trim)))
  (block $right (loop $trim
    (br_if $right (i32.ge_u (local.get $p) (local.get $end)))
    (br_if $right (i32.eqz (call $nu_space (i32.load8_u (i32.sub (local.get $end) (i32.const 1))))))
    (local.set $end (i32.sub (local.get $end) (i32.const 1)))
    (if (call $nu_tick) (then (return (i32.const 0)))) (br $trim)))
  (if (i32.ge_u (local.get $p) (local.get $end)) (then (return (i32.const 0))))
  (local.set $begin (local.get $p))
  (global.set $nu_neg (i32.const 0))
  (global.set $nu_special (i32.const 0))
  (global.set $nu_sig (i64.const 0))
  (global.set $nu_frac (i64.const 0))
  (global.set $nu_trail (i64.const 0))
  (global.set $nu_exp (i64.const 0))
  (global.set $nu_first (local.get $end))
  (local.set $floating (i32.le_u (i32.sub (local.get $family) (i32.const 3)) (i32.const 1)))
  (local.set $c (i32.load8_u (local.get $p)))
  (if (i32.or (i32.eq (local.get $c) (i32.const '+')) (i32.eq (local.get $c) (i32.const '-'))) (then
    (global.set $nu_neg (i32.eq (local.get $c) (i32.const '-')))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))))
  (if (i32.ge_u (local.get $p) (local.get $end)) (then (return (i32.const 0))))
  (if (local.get $floating) (then
    (if (call $same (local.get $p) (i32.sub (local.get $end) (local.get $p)) (@str "INF") (i32.const 0)) (then
      (global.set $nu_special (i32.const 1)) (return (i32.eqz (call $nu_poll)))))
    (if (i32.eq (local.get $p) (local.get $begin)) (then
      (if (call $same (local.get $p) (i32.sub (local.get $end) (local.get $p)) (@str "NaN") (i32.const 0)) (then
        (global.set $nu_special (i32.const 2)) (return (i32.eqz (call $nu_poll)))))))))
  (block $mantissa (loop $scan
    (br_if $mantissa (i32.ge_u (local.get $p) (local.get $end)))
    (local.set $c (i32.load8_u (local.get $p)))
    (if (call $is_digit (local.get $c)) (then
      (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
      (if (local.get $dot) (then
        (global.set $nu_frac (i64.add (global.get $nu_frac) (i64.const 1)))
        (global.set $nu_trail (select (i64.add (global.get $nu_trail) (i64.const 1)) (i64.const 0) (i32.eq (local.get $c) (i32.const '0'))))))
      (if (i32.or (i64.ne (global.get $nu_sig) (i64.const 0)) (i32.ne (local.get $c) (i32.const '0'))) (then
        (if (i64.eqz (global.get $nu_sig)) (then (global.set $nu_first (local.get $p))))
        (global.set $nu_sig (i64.add (global.get $nu_sig) (i64.const 1)))))
    ) (else
      (br_if $mantissa (i32.or (i32.ne (local.get $c) (i32.const '.'))
        (i32.or (local.get $dot) (i32.eqz (i32.or (local.get $floating) (i32.eq (local.get $family) (i32.const 2)))))))
      (local.set $dot (i32.const 1))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (if (call $nu_tick) (then (return (i32.const 0)))) (br $scan)))
  (if (i32.eqz (local.get $digits)) (then (return (i32.const 0))))
  (global.set $nu_end (local.get $p))
  (if (i32.lt_u (local.get $p) (local.get $end)) (then
    (if (i32.or (i32.eqz (local.get $floating)) (i32.ne (i32.or (i32.load8_u (local.get $p)) (i32.const 32)) (i32.const 'e'))) (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (if (i32.lt_u (local.get $p) (local.get $end)) (then
      (local.set $c (i32.load8_u (local.get $p)))
      (if (i32.or (i32.eq (local.get $c) (i32.const '+')) (i32.eq (local.get $c) (i32.const '-'))) (then
        (local.set $eneg (i32.eq (local.get $c) (i32.const '-')))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))))))
    (if (i32.ge_u (local.get $p) (local.get $end)) (then (return (i32.const 0))))
    (local.set $cap (i64.add (i64.extend_i32_u (local.get $n)) (i64.const 2048)))
    (loop $exponent
      (local.set $c (i32.load8_u (local.get $p)))
      (if (i32.eqz (call $is_digit (local.get $c))) (then (return (i32.const 0))))
      (if (i64.lt_u (global.get $nu_exp) (local.get $cap)) (then
        (global.set $nu_exp (i64.add (i64.mul (global.get $nu_exp) (i64.const 10)) (i64.extend_i32_u (i32.sub (local.get $c) (i32.const '0')))))
        (if (i64.gt_u (global.get $nu_exp) (local.get $cap)) (then (global.set $nu_exp (local.get $cap))))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (if (call $nu_tick) (then (return (i32.const 0))))
      (br_if $exponent (i32.lt_u (local.get $p) (local.get $end))))
    (if (local.get $eneg) (then (global.set $nu_exp (i64.sub (i64.const 0) (global.get $nu_exp)))))))
  (if (i32.eqz (local.get $floating)) (then
    (if (i32.eqz (i32.eq (local.get $family) (i32.const 2))) (then
      (if (i32.or
        (i32.and (i32.eq (local.get $family) (i32.const 10)) (i32.or (global.get $nu_neg) (i64.eqz (global.get $nu_sig))))
        (i32.and (i32.eq (local.get $family) (i32.const 12)) (i32.or (i32.eqz (global.get $nu_neg)) (i64.eqz (global.get $nu_sig))))) (then (return (i32.const 0))))
      (if (i64.ne (global.get $nu_sig) (i64.const 0)) (then
        (if (i32.and (global.get $nu_neg) (i32.or (i32.eq (local.get $family) (i32.const 9)) (i32.ge_u (local.get $family) (i32.const 13)))) (then (return (i32.const 0))))
        (if (i32.and (i32.eqz (global.get $nu_neg)) (i32.eq (local.get $family) (i32.const 11))) (then (return (i32.const 0))))
        (if (i32.eq (local.get $family) (i32.const 5)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 19)) (local.set $limit (call $nu_text_ptr (@str "9223372036854775808"))))
            (else (local.set $limit_n (i32.const 19)) (local.set $limit (call $nu_text_ptr (@str "9223372036854775807")))))))
        (if (i32.eq (local.get $family) (i32.const 6)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 10)) (local.set $limit (call $nu_text_ptr (@str "2147483648"))))
            (else (local.set $limit_n (i32.const 10)) (local.set $limit (call $nu_text_ptr (@str "2147483647")))))))
        (if (i32.eq (local.get $family) (i32.const 7)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 5)) (local.set $limit (call $nu_text_ptr (@str "32768"))))
            (else (local.set $limit_n (i32.const 5)) (local.set $limit (call $nu_text_ptr (@str "32767")))))))
        (if (i32.eq (local.get $family) (i32.const 8)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 3)) (local.set $limit (call $nu_text_ptr (@str "128"))))
            (else (local.set $limit_n (i32.const 3)) (local.set $limit (call $nu_text_ptr (@str "127")))))))
        (if (i32.eq (local.get $family) (i32.const 13)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 20)) (local.set $limit (call $nu_text_ptr (@str "18446744073709551615"))))
            (else (local.set $limit_n (i32.const 20)) (local.set $limit (call $nu_text_ptr (@str "18446744073709551615")))))))
        (if (i32.eq (local.get $family) (i32.const 14)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 10)) (local.set $limit (call $nu_text_ptr (@str "4294967295"))))
            (else (local.set $limit_n (i32.const 10)) (local.set $limit (call $nu_text_ptr (@str "4294967295")))))))
        (if (i32.eq (local.get $family) (i32.const 15)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 5)) (local.set $limit (call $nu_text_ptr (@str "65535"))))
            (else (local.set $limit_n (i32.const 5)) (local.set $limit (call $nu_text_ptr (@str "65535")))))))
        (if (i32.eq (local.get $family) (i32.const 16)) (then
          (if (global.get $nu_neg) (then (local.set $limit_n (i32.const 3)) (local.set $limit (call $nu_text_ptr (@str "255"))))
            (else (local.set $limit_n (i32.const 3)) (local.set $limit (call $nu_text_ptr (@str "255")))))))
        (if (local.get $limit) (then
          (if (i64.gt_u (global.get $nu_sig) (i64.extend_i32_u (local.get $limit_n))) (then (return (i32.const 0))))
          (if (i64.eq (global.get $nu_sig) (i64.extend_i32_u (local.get $limit_n))) (then
            (block $range_ok (loop $range
              (local.set $c (i32.load8_u (i32.add (global.get $nu_first) (local.get $i))))
              (if (i32.gt_u (local.get $c) (i32.load8_u (i32.add (local.get $limit) (local.get $i)))) (then (return (i32.const 0))))
              (br_if $range_ok (i32.lt_u (local.get $c) (i32.load8_u (i32.add (local.get $limit) (local.get $i)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (if (call $nu_tick) (then (return (i32.const 0))))
              (br_if $range (i32.lt_u (local.get $i) (local.get $limit_n)))))))))))))
    (if (i64.eqz (global.get $nu_sig)) (then (global.set $nu_neg (i32.const 0))))))
  (i32.eqz (call $nu_poll)))

(func $nu_text_ptr (param $p i32) (param $n i32) (result i32) (local.get $p))

;; Convert validated lexical metadata into a native exact mantissa/scale. Wide
;; valid values return 0 here without losing their validity for floating casts.
(func $nu_native (param $decimal i32) (result i32)
  (local $p i32) (local $end i32) (local $c i32) (local $m i64) (local $limit i64) (local $digit i64) (local $scale i64)
  (local.set $end (global.get $nu_end))
  (if (local.get $decimal) (then
    (local.set $end (i32.sub (local.get $end) (i32.wrap_i64 (global.get $nu_trail))))
    (local.set $scale (i64.sub (global.get $nu_frac) (global.get $nu_trail)))
    (if (i64.gt_u (local.get $scale) (i64.const 18)) (then (return (i32.const 0))))))
  (local.set $limit (i64.add (i64.const 9223372036854775807) (i64.extend_i32_u (global.get $nu_neg))))
  (local.set $p (global.get $nu_first))
  (loop $digits
    (if (i32.lt_u (local.get $p) (local.get $end)) (then
      (local.set $c (i32.load8_u (local.get $p)))
      (if (i32.ne (local.get $c) (i32.const '.')) (then
        (local.set $digit (i64.extend_i32_u (i32.sub (local.get $c) (i32.const '0'))))
        (if (i64.gt_u (local.get $m) (i64.div_u (i64.sub (local.get $limit) (local.get $digit)) (i64.const 10))) (then (return (i32.const 0))))
        (local.set $m (i64.add (i64.mul (local.get $m) (i64.const 10)) (local.get $digit)))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (if (call $nu_tick) (then (return (i32.const 0)))) (br $digits))))
  (if (call $nu_poll) (then (return (i32.const 0))))
  (global.set $nu_integer (select (i64.sub (i64.const 0) (local.get $m)) (local.get $m) (global.get $nu_neg)))
  (global.set $nu_scale (i32.wrap_i64 (local.get $scale)))
  (i32.const 1))

;; Prefix A is in slot 0. The exact value is A*10^exp; sticky says the
;; discarded tail is nonzero. Remainder is compared with the SCALED divisor.
(func $nu_round (param $exp i32) (param $sticky i32) (param $neg i32) (param $single i32) (result f64)
  (local $n i32) (local $d i32) (local $sn i32) (local $sd i32) (local $tmp i32) (local $rem i32) (local $div i32)
  (local $power i32) (local $i i32) (local $e i32) (local $h i32) (local $shift i32) (local $fraction i32) (local $bias i32) (local $cmp i32)
  (local $q i64) (local $hidden i64) (local $bits i64) (local $inf i64) (local $sign i64)
  (local.set $fraction (select (i32.const 23) (i32.const 52) (local.get $single)))
  (local.set $bias (select (i32.const 127) (i32.const 1023) (local.get $single)))
  (local.set $inf (select (i64.const 2139095040) (i64.const 9218868437227405312) (local.get $single)))
  (local.set $sign (select (i64.const 2147483648) (i64.const -9223372036854775808) (local.get $single)))
  (if (i32.eqz (local.get $neg)) (then (local.set $sign (i64.const 0))))
  (if (i32.eqz (i32.load (call $nu_buffer (i32.const 0)))) (then (return (call $nu_ieee (local.get $sign) (local.get $single)))))
  (if (i32.or (i32.lt_s (local.get $exp) (i32.const -1123)) (i32.gt_s (local.get $exp) (i32.const 308))) (then unreachable))
  (local.set $n (call $nu_buffer (i32.const 1))) (local.set $d (call $nu_buffer (i32.const 2)))
  (local.set $sn (call $nu_buffer (i32.const 3))) (local.set $sd (call $nu_buffer (i32.const 4)))
  (local.set $tmp (call $nu_buffer (i32.const 5))) (local.set $rem (call $nu_buffer (i32.const 6))) (local.set $div (call $nu_buffer (i32.const 7)))
  (call $nu_shift (local.get $n) (call $nu_buffer (i32.const 0)) (i32.const 0))
  (if (global.get $nu_stop) (then (return (f64.const 0))))
  (call $nu_small (local.get $d) (i32.const 1))
  (local.set $power (select (local.get $n) (local.get $d) (i32.ge_s (local.get $exp) (i32.const 0))))
  (local.set $i (select (local.get $exp) (i32.sub (i32.const 0) (local.get $exp)) (i32.ge_s (local.get $exp) (i32.const 0))))
  (loop $power5
    (if (i32.gt_s (local.get $i) (i32.const 0)) (then
      (call $nu_mul (local.get $power) (i32.const 5) (i32.const 0))
      (if (global.get $nu_stop) (then (return (f64.const 0))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1))) (br $power5))))
  (local.set $e (i32.sub (call $nu_bits (local.get $n)) (call $nu_bits (local.get $d))))
  (if (i32.ge_s (local.get $e) (i32.const 0))
    (then (call $nu_shift (local.get $tmp) (local.get $d) (local.get $e)) (local.set $cmp (call $nu_cmp (local.get $n) (local.get $tmp))))
    (else (call $nu_shift (local.get $tmp) (local.get $n) (i32.sub (i32.const 0) (local.get $e))) (local.set $cmp (call $nu_cmp (local.get $tmp) (local.get $d)))))
  (if (global.get $nu_stop) (then (return (f64.const 0))))
  (if (i32.lt_s (local.get $cmp) (i32.const 0)) (then (local.set $e (i32.sub (local.get $e) (i32.const 1)))))
  (local.set $e (i32.add (local.get $e) (local.get $exp)))
  (if (i32.gt_s (local.get $e) (local.get $bias)) (then (return (call $nu_ieee (i64.or (local.get $sign) (local.get $inf)) (local.get $single)))))
  (local.set $h (i32.sub (local.get $e) (local.get $fraction)))
  (if (i32.lt_s (local.get $h) (i32.sub (i32.sub (i32.const 1) (local.get $bias)) (local.get $fraction))) (then
    (local.set $h (i32.sub (i32.sub (i32.const 1) (local.get $bias)) (local.get $fraction)))))
  (local.set $shift (i32.sub (local.get $exp) (local.get $h)))
  (call $nu_shift (local.get $sn) (local.get $n) (select (local.get $shift) (i32.const 0) (i32.gt_s (local.get $shift) (i32.const 0))))
  (call $nu_shift (local.get $sd) (local.get $d) (select (i32.sub (i32.const 0) (local.get $shift)) (i32.const 0) (i32.lt_s (local.get $shift) (i32.const 0))))
  (call $nu_shift (local.get $rem) (local.get $sn) (i32.const 0))
  (if (global.get $nu_stop) (then (return (f64.const 0))))
  (local.set $i (i32.sub (call $nu_bits (local.get $rem)) (call $nu_bits (local.get $sd))))
  (if (i32.gt_s (local.get $i) (i32.add (local.get $fraction) (i32.const 1))) (then unreachable))
  (loop $divide
    (if (i32.ge_s (local.get $i) (i32.const 0)) (then
      (call $nu_shift (local.get $div) (local.get $sd) (local.get $i))
      (if (i32.ge_s (call $nu_cmp (local.get $rem) (local.get $div)) (i32.const 0)) (then
        (call $nu_sub (local.get $rem) (local.get $div))
        (local.set $q (i64.or (local.get $q) (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $i)))))))
      (if (global.get $nu_stop) (then (return (f64.const 0))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1))) (br $divide))))
  (call $nu_shift (local.get $tmp) (local.get $rem) (i32.const 1))
  (local.set $cmp (call $nu_cmp (local.get $tmp) (local.get $sd)))
  (if (global.get $nu_stop) (then (return (f64.const 0))))
  (if (i32.or (i32.gt_s (local.get $cmp) (i32.const 0)) (i32.and (i32.eqz (local.get $cmp)) (i32.or (local.get $sticky) (i32.wrap_i64 (i64.and (local.get $q) (i64.const 1)))))) (then
    (local.set $q (i64.add (local.get $q) (i64.const 1)))))
  (if (i64.eqz (local.get $q)) (then (return (call $nu_ieee (local.get $sign) (local.get $single)))))
  (local.set $hidden (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $fraction))))
  (if (i64.ge_u (local.get $q) (i64.shl (local.get $hidden) (i64.const 1))) (then
    (local.set $q (i64.shr_u (local.get $q) (i64.const 1))) (local.set $h (i32.add (local.get $h) (i32.const 1)))))
  (if (i64.lt_u (local.get $q) (local.get $hidden)) (then (return (call $nu_ieee (i64.or (local.get $sign) (local.get $q)) (local.get $single)))))
  (local.set $e (i32.add (local.get $h) (local.get $fraction)))
  (if (i32.gt_s (local.get $e) (local.get $bias)) (then (return (call $nu_ieee (i64.or (local.get $sign) (local.get $inf)) (local.get $single)))))
  (if (i32.or (i64.ge_u (local.get $q) (i64.shl (local.get $hidden) (i64.const 1))) (i32.lt_s (local.get $e) (i32.sub (i32.const 1) (local.get $bias)))) (then unreachable))
  (local.set $bits (i64.or (local.get $sign) (i64.or (i64.shl (i64.extend_i32_u (i32.add (local.get $e) (local.get $bias))) (i64.extend_i32_u (local.get $fraction))) (i64.sub (local.get $q) (local.get $hidden)))))
  (call $nu_ieee (local.get $bits) (local.get $single)))

(func $nu_ieee (param $bits i64) (param $single i32) (result f64)
  (if (result f64) (local.get $single)
    (then (f64.promote_f32 (f32.reinterpret_i32 (i32.wrap_i64 (local.get $bits)))))
    (else (f64.reinterpret_i64 (local.get $bits)))))

(func $nu_float (param $single i32) (result i32)
  (local $p i32) (local $c i32) (local $kept i64) (local $count i64) (local $exp i64) (local $order i64) (local $sticky i32) (local $value f64)
  (if (i32.eq (global.get $nu_special) (i32.const 2)) (then (local.set $value (f64.const nan)))
    (else (if (i32.eq (global.get $nu_special) (i32.const 1)) (then (local.set $value (f64.const inf)))
    (else (if (i64.ne (global.get $nu_sig) (i64.const 0)) (then
      (local.set $kept (select (global.get $nu_sig) (i64.const 800) (i64.lt_u (global.get $nu_sig) (i64.const 800))))
      (local.set $exp (i64.add (i64.sub (global.get $nu_exp) (global.get $nu_frac)) (i64.sub (global.get $nu_sig) (local.get $kept))))
      (local.set $order (i64.add (i64.sub (local.get $kept) (i64.const 1)) (local.get $exp)))
      (if (i64.ge_s (local.get $order) (select (i64.const 39) (i64.const 309) (local.get $single))) (then (local.set $value (f64.const inf)))
        (else (if (i64.ge_s (local.get $order) (select (i64.const -46) (i64.const -324) (local.get $single))) (then
          (call $nu_small (call $nu_buffer (i32.const 0)) (i32.const 0))
          (local.set $p (global.get $nu_first))
          (loop $prefix
            (if (i32.lt_u (local.get $p) (global.get $nu_end)) (then
              (local.set $c (i32.load8_u (local.get $p)))
              (if (i32.ne (local.get $c) (i32.const '.')) (then
                (if (i64.lt_u (local.get $count) (i64.const 800))
                  (then (call $nu_mul (call $nu_buffer (i32.const 0)) (i32.const 10) (i32.sub (local.get $c) (i32.const '0'))))
                  (else (if (i32.ne (local.get $c) (i32.const '0')) (then (local.set $sticky (i32.const 1))))))
                (local.set $count (i64.add (local.get $count) (i64.const 1)))))
              (local.set $p (i32.add (local.get $p) (i32.const 1)))
              (if (call $nu_tick) (then (return (i32.const 0)))) (br $prefix))))
          (local.set $value (call $nu_round (i32.wrap_i64 (local.get $exp)) (local.get $sticky) (i32.const 0) (local.get $single)))))))))))))
  (if (global.get $nu_neg) (then (local.set $value (f64.neg (local.get $value)))))
  (if (call $nu_poll) (then (return (i32.const 0))))
  (global.set $nu_value (local.get $value))
  (i32.const 1))

;; A computed i64/decimal goes directly to its target precision.
(func $nu_from_native (param $m i64) (param $scale i32) (param $single i32) (result i32)
  (local $b i32) (local $neg i32) (local $value f64)
  (global.set $nu_units (i32.const 0)) (global.set $nu_stop (i32.const 0))
  (if (call $nu_poll) (then (return (i32.const 0))))
  (local.set $b (call $nu_buffer (i32.const 0)))
  (local.set $neg (i64.lt_s (local.get $m) (i64.const 0)))
  (if (local.get $neg) (then (local.set $m (i64.sub (i64.const 0) (local.get $m)))))
  (i64.store offset=4 (local.get $b) (local.get $m))
  (i32.store (local.get $b) (select (i32.const 2) (i32.ne (i32.wrap_i64 (local.get $m)) (i32.const 0)) (i64.ne (i64.shr_u (local.get $m) (i64.const 32)) (i64.const 0))))
  (local.set $value (call $nu_round (i32.sub (i32.const 0) (local.get $scale)) (i32.const 0) (local.get $neg) (local.get $single)))
  (if (call $nu_poll) (then (return (i32.const 0))))
  (global.set $nu_value (local.get $value)) (i32.const 1))
