;; Semblance's SPARQL extensions (EXTENSIONS.md): extension functions (sx:Math,
;; sx:Text, sx:Locale) and magic relations (sx:matches, sx:chars, sx:json).
;;
;; Functions are recognised by IRI at parse time (F_SX_*; $sx_fn evaluates
;; them). A magic relation is a triple pattern between two collections written
;; in a pattern: the parser folds it into one P_MAGIC element (inputs, outputs),
;; held on its group (+24) until the basic graph pattern ends, so it is joined
;; after that pattern's triples ($eval_magic, per input row).

(@define MR_MATCHES 1) (@define MR_CHARS 2) (@define MR_JSON 3)

;; --- names ---------------------------------------------------------------------

(global $sx_n (mut i32) (i32.const 0))

;; The local name of IRI id in the sx: namespace: its address ($sx_n bytes), or 0.
(func $sx_local (param $id i32) (result i32)
  (local $r i32) (local $n i32)
  (if (i32.or (i32.le_s (local.get $id) (i32.const 0)) (i32.ne (call $kind (local.get $id)) (i32.const 1))) (then (return (i32.const 0))))
  (local.set $r (call $rec (local.get $id)))
  (local.set $n (i32.load offset=12 (local.get $r)))
  (if (i32.le_u (local.get $n) (i32.const 32)) (then (return (i32.const 0))))
  (if (i32.eqz (call $memeq (i32.load offset=8 (local.get $r)) (@str "https://semblance.dev/ns/sparql#"))) (then (return (i32.const 0))))
  (global.set $sx_n (i32.sub (local.get $n) (i32.const 32)))
  (i32.add (i32.load offset=8 (local.get $r)) (i32.const 32)))

(func $sx_is (param $p i32) (param $s i32) (param $k i32) (result i32)
  (call $same (local.get $p) (global.get $sx_n) (local.get $s) (local.get $k) (i32.const 0)))

;; The extension function IRI id names, called with argc arguments: its code, or 0.
(func $sx_fn_code (param $id i32) (param $argc i32) (result i32)
  (local $p i32) (local $c i32) (local $min i32) (local $max i32)
  (if (i32.eqz (local.tee $p (call $sx_local (local.get $id)))) (then (return (i32.const 0))))
  (local.set $min (i32.const 1))
  (local.set $max (i32.const 1))
  (block $found
    (if (call $sx_is (local.get $p) (@str "log")) (then (local.set $c (i32.const 100)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "log10")) (then (local.set $c (i32.const 101)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "log2")) (then (local.set $c (i32.const 102)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "exp")) (then (local.set $c (i32.const 103)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "pow")) (then (local.set $c (i32.const 104)) (local.set $min (i32.const 2)) (local.set $max (i32.const 2)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "sin")) (then (local.set $c (i32.const 105)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "cos")) (then (local.set $c (i32.const 106)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "tan")) (then (local.set $c (i32.const 107)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "asin")) (then (local.set $c (i32.const 108)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "acos")) (then (local.set $c (i32.const 109)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "atan")) (then (local.set $c (i32.const 110)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "atan2")) (then (local.set $c (i32.const 111)) (local.set $min (i32.const 2)) (local.set $max (i32.const 2)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "sqrt")) (then (local.set $c (i32.const F_SX_SQRT)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "pi")) (then (local.set $c (i32.const F_SX_PI)) (local.set $min (i32.const 0)) (local.set $max (i32.const 0)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "codepoint")) (then (local.set $c (i32.const F_SX_CODEPOINT)) (local.set $min (i32.const 2)) (local.set $max (i32.const 2)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "char")) (then (local.set $c (i32.const F_SX_CHAR)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "utf8Hex")) (then (local.set $c (i32.const F_SX_UTF8HEX)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "decodeURI")) (then (local.set $c (i32.const F_SX_DECODEURI)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "fnv1a")) (then (local.set $c (i32.const F_SX_FNV1A)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "formatNumber")) (then (local.set $c (i32.const F_SX_FORMATNUMBER)) (local.set $min (i32.const 2)) (local.set $max (i32.const 3)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "formatDateTime")) (then (local.set $c (i32.const F_SX_FORMATDATETIME)) (local.set $min (i32.const 2)) (local.set $max (i32.const 3)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "collated")) (then (local.set $c (i32.const F_SX_COLLATED)) (local.set $min (i32.const 2)) (local.set $max (i32.const 2)) (br $found)))
    (if (call $sx_is (local.get $p) (@str "sortKey")) (then (local.set $c (i32.const F_SX_SORTKEY)) (local.set $min (i32.const 2)) (local.set $max (i32.const 2)) (br $found)))
    (return (i32.const 0)))
  (if (i32.or (i32.lt_u (local.get $argc) (local.get $min)) (i32.gt_u (local.get $argc) (local.get $max))) (then (return (i32.const 0))))
  (local.get $c))

;; The magic relation IRI id names: MR_*, or 0.
(func $sx_rel (param $id i32) (result i32)
  (local $p i32)
  (if (i32.eqz (local.tee $p (call $sx_local (local.get $id)))) (then (return (i32.const 0))))
  (if (call $sx_is (local.get $p) (@str "matches")) (then (return (i32.const MR_MATCHES))))
  (if (call $sx_is (local.get $p) (@str "chars")) (then (return (i32.const MR_CHARS))))
  (if (call $sx_is (local.get $p) (@str "json")) (then (return (i32.const MR_JSON))))
  (i32.const 0))

;; --- byte buffers ----------------------------------------------------------------
;; 12 bytes: +0 data, +4 length, +8 capacity.

(func $gb_new (result i32)
  (local $b i32)
  (local.set $b (call $alloc0 (i32.const 12)))
  (i32.store (local.get $b) (call $alloc (i32.const 64)))
  (i32.store offset=8 (local.get $b) (i32.const 64))
  (local.get $b))

(func $gb_room (param $b i32) (param $n i32)
  (local $need i32) (local $cap i32)
  (local.set $need (i32.add (i32.load offset=4 (local.get $b)) (local.get $n)))
  (if (i32.gt_u (local.get $need) (local.tee $cap (i32.load offset=8 (local.get $b)))) (then
    (local.set $need (i32.add (i32.shl (local.get $need) (i32.const 1)) (i32.const 64)))
    (i32.store (local.get $b) (call $realloc (i32.load (local.get $b)) (local.get $cap) (local.get $need) (i32.load offset=4 (local.get $b))))
    (i32.store offset=8 (local.get $b) (local.get $need)))))

(func $gb_put (param $b i32) (param $p i32) (param $n i32)
  (call $gb_room (local.get $b) (local.get $n))
  (memory.copy (i32.add (i32.load (local.get $b)) (i32.load offset=4 (local.get $b))) (local.get $p) (local.get $n))
  (i32.store offset=4 (local.get $b) (i32.add (i32.load offset=4 (local.get $b)) (local.get $n))))

(func $gb_byte (param $b i32) (param $c i32)
  (call $gb_room (local.get $b) (i32.const 1))
  (i32.store8 (i32.add (i32.load (local.get $b)) (i32.load offset=4 (local.get $b))) (local.get $c))
  (i32.store offset=4 (local.get $b) (i32.add (i32.load offset=4 (local.get $b)) (i32.const 1))))

(func $gb_cp (param $b i32) (param $cp i32)
  (call $gb_room (local.get $b) (i32.const 4))
  (i32.store offset=4 (local.get $b)
    (i32.sub (call $encode (i32.add (i32.load (local.get $b)) (i32.load offset=4 (local.get $b))) (local.get $cp)) (i32.load (local.get $b)))))

;; --- the host's Intl -----------------------------------------------------------------

(global $ix_in (mut i32) (i32.const 0))
(global $ix_out (mut i32) (i32.const 0))

;; Start the arguments of an intl call.
(func $ix_reset
  (if (i32.eqz (global.get $ix_in)) (then
    (global.set $ix_in (call $gb_new))
    (global.set $ix_out (call $gb_new))))
  (i32.store offset=4 (global.get $ix_in) (i32.const 0)))

;; One more argument: bytes [p, p+n), after a NUL unless the first.
(func $ix_arg (param $p i32) (param $n i32)
  (if (i32.load offset=4 (global.get $ix_in)) (then (call $gb_byte (global.get $ix_in) (i32.const 0))))
  (call $gb_put (global.get $ix_in) (local.get $p) (local.get $n)))

(func $ix_term (param $id i32)
  (call $ix_arg (call $tval (local.get $id)) (call $tlen (local.get $id))))

;; intl op on the arguments: the result as a simple literal, or 0 (an error).
(func $ix_call (param $op i32) (result i32)
  (local $r i32)
  (loop $again
    (local.set $r (call $intl (local.get $op) (i32.load (global.get $ix_in)) (i32.load offset=4 (global.get $ix_in))
                              (i32.load (global.get $ix_out)) (i32.load offset=8 (global.get $ix_out))))
    (if (i32.eq (local.get $r) (i32.const -2147483648)) (then (return (i32.const 0))))
    (if (i32.lt_s (local.get $r) (i32.const 0)) (then
      ;; room for -r bytes
      (i32.store offset=4 (global.get $ix_out) (i32.const 0))
      (call $gb_room (global.get $ix_out) (i32.sub (i32.const 0) (local.get $r)))
      (br $again))))
  (call $simple (i32.load (global.get $ix_out)) (local.get $r)))

;; Intl.Collator(lang).compare(a, b) for string literals: -1, 0 or 1.
(func $sx_collate (param $lang i32) (param $a i32) (param $b i32) (result i32)
  (call $ix_reset)
  (call $ix_term (local.get $lang))
  (call $ix_term (local.get $a))
  (call $ix_term (local.get $b))
  (call $intl (i32.const 2) (i32.load (global.get $ix_in)) (i32.load offset=4 (global.get $ix_in)) (i32.const 0) (i32.const 0)))

;; --- functions ------------------------------------------------------------------------

(func $hex_val (param $c i32) (result i32)
  (if (call $is_digit (local.get $c)) (then (return (i32.sub (local.get $c) (i32.const '0')))))
  (if (call $in (local.get $c) (i32.const 'a') (i32.const 'f')) (then (return (i32.sub (local.get $c) (i32.const 87)))))
  (if (call $in (local.get $c) (i32.const 'A') (i32.const 'F')) (then (return (i32.sub (local.get $c) (i32.const 55)))))
  (i32.const -1))

;; An integer argument (xsd:integer or derived): whether it is one; the value in $ni.
(func $sx_int (param $id i32) (result i32)
  (if (i32.ne (call $dtc (call $tdt (local.get $id))) (i32.const C_INTEGER)) (then (return (i32.const 0))))
  (i32.eq (call $num (local.get $id)) (i32.const 1)))

;; Whether [p, p+n) is well-formed UTF-8 (no overlong forms, surrogates or values past U+10FFFF).
(func $utf8_ok (param $p i32) (param $n i32) (result i32)
  (local $e i32) (local $c i32) (local $k i32) (local $cp i32) (local $min i32)
  (local.set $e (i32.add (local.get $p) (local.get $n)))
  (loop $chars
    (if (i32.lt_u (local.get $p) (local.get $e)) (then
      (local.set $c (i32.load8_u (local.get $p)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (if (i32.lt_u (local.get $c) (i32.const 0x80)) (then (br $chars)))
      (if (i32.lt_u (local.get $c) (i32.const 0xc0)) (then (return (i32.const 0))))
      (if (i32.lt_u (local.get $c) (i32.const 0xe0))
        (then (local.set $k (i32.const 1)) (local.set $cp (i32.and (local.get $c) (i32.const 0x1f))) (local.set $min (i32.const 0x80)))
        (else (if (i32.lt_u (local.get $c) (i32.const 0xf0))
          (then (local.set $k (i32.const 2)) (local.set $cp (i32.and (local.get $c) (i32.const 0x0f))) (local.set $min (i32.const 0x800)))
          (else (if (i32.lt_u (local.get $c) (i32.const 0xf8))
            (then (local.set $k (i32.const 3)) (local.set $cp (i32.and (local.get $c) (i32.const 0x07))) (local.set $min (i32.const 0x10000)))
            (else (return (i32.const 0))))))))
      (loop $more
        (if (local.get $k) (then
          (if (i32.ge_u (local.get $p) (local.get $e)) (then (return (i32.const 0))))
          (local.set $c (i32.load8_u (local.get $p)))
          (if (i32.ne (i32.and (local.get $c) (i32.const 0xc0)) (i32.const 0x80)) (then (return (i32.const 0))))
          (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 6)) (i32.and (local.get $c) (i32.const 0x3f))))
          (local.set $p (i32.add (local.get $p) (i32.const 1)))
          (local.set $k (i32.sub (local.get $k) (i32.const 1)))
          (br $more))))
      (if (i32.or (i32.lt_u (local.get $cp) (local.get $min))
                  (i32.or (i32.gt_u (local.get $cp) (i32.const 0x10ffff)) (call $in (local.get $cp) (i32.const 0xd800) (i32.const 0xdfff))))
        (then (return (i32.const 0))))
      (br $chars))))
  (i32.const 1))

;; Whether literal id is an xsd:dateTime, xsd:dateTimeStamp or xsd:date.
(func $sx_datetime (param $id i32) (result i32)
  (local $dt i32) (local $c i32)
  (if (i32.ne (call $kind (local.get $id)) (i32.const 3)) (then (return (i32.const 0))))
  (local.set $c (call $dtc (local.tee $dt (call $tdt (local.get $id)))))
  (if (i32.or (i32.eq (local.get $c) (i32.const C_DATETIME)) (i32.eq (local.get $c) (i32.const C_DATE))) (then (return (i32.const 1))))
  (call $same (call $tval (local.get $dt)) (call $tlen (local.get $dt)) (@str "http://www.w3.org/2001/XMLSchema#dateTimeStamp") (i32.const 0)))

;; Extension function f of evaluated (bound) arguments a, b, c: a term, or 0.
(func $sx_fn (param $f i32) (param $argc i32) (param $a i32) (param $b i32) (param $c i32) (result i32)
  (local $x f64) (local $y f64) (local $r f64) (local $p i32) (local $e i32) (local $i i32) (local $v i32) (local $h i32) (local $n i32)
  ;; sx:Math
  (if (i32.le_u (local.get $f) (i32.const F_SX_SQRT)) (then
    (if (i32.eqz (call $num (local.get $a))) (then (return (i32.const 0))))
    (local.set $x (global.get $nf))
    (if (i32.or (i32.eq (local.get $f) (i32.const F_SX_POW)) (i32.eq (local.get $f) (i32.const F_SX_ATAN2))) (then
      (if (i32.eqz (call $num (local.get $b))) (then (return (i32.const 0))))
      (local.set $y (global.get $nf))))
    (if (i32.eq (local.get $f) (i32.const F_SX_SQRT))
      (then
        (if (f64.lt (local.get $x) (f64.const 0)) (then (return (i32.const 0))))
        (local.set $r (f64.sqrt (local.get $x))))
      (else
        (if (i32.le_u (local.get $f) (i32.const F_SX_LOG2)) (then
          (if (f64.le (local.get $x) (f64.const 0)) (then (return (i32.const 0))))))
        (local.set $r (call $math (i32.sub (local.get $f) (i32.const F_SX_LOG)) (local.get $x) (local.get $y)))))
    (if (f64.ne (local.get $r) (local.get $r)) (then (return (i32.const 0))))
    (return (call $dbl_term (local.get $r) (call $known (i32.const K_DOUBLE))))))
  (if (i32.eq (local.get $f) (i32.const F_SX_PI)) (then (return (call $dbl_term (f64.const 3.141592653589793) (call $known (i32.const K_DOUBLE))))))
  ;; sx:Text
  (if (i32.eq (local.get $f) (i32.const F_SX_CODEPOINT)) (then
    (if (i32.eqz (call $is_str (local.get $a))) (then (return (i32.const 0))))
    (if (i32.eqz (call $sx_int (local.get $b))) (then (return (i32.const 0))))
    (local.set $n (call $cp_count (call $tval (local.get $a)) (call $tlen (local.get $a))))
    (if (i32.or (i64.lt_s (global.get $ni) (i64.const 1)) (i64.gt_s (global.get $ni) (i64.extend_i32_u (local.get $n)))) (then (return (i32.const 0))))
    (local.set $p (call $tval (local.get $a)))
    (local.set $p (i32.add (local.get $p) (call $cp_offset (local.get $p) (call $tlen (local.get $a)) (i32.sub (i32.wrap_i64 (global.get $ni)) (i32.const 1)))))
    (return (call $int_term (i64.extend_i32_u (call $decode (local.get $p)))))))
  (if (i32.eq (local.get $f) (i32.const F_SX_CHAR)) (then
    (if (i32.eqz (call $sx_int (local.get $a))) (then (return (i32.const 0))))
    (if (i32.or (i64.lt_s (global.get $ni) (i64.const 0)) (i64.gt_s (global.get $ni) (i64.const 0x10ffff))) (then (return (i32.const 0))))
    (local.set $v (i32.wrap_i64 (global.get $ni)))
    (if (call $in (local.get $v) (i32.const 0xd800) (i32.const 0xdfff)) (then (return (i32.const 0))))
    (return (call $simple (global.get $nbuf) (i32.sub (call $encode (global.get $nbuf) (local.get $v)) (global.get $nbuf))))))
  (if (i32.eq (local.get $f) (i32.const F_SX_UTF8HEX)) (then
    (if (i32.eqz (call $is_str (local.get $a))) (then (return (i32.const 0))))
    (call $xb_reset)
    (local.set $p (call $tval (local.get $a)))
    (local.set $e (i32.add (local.get $p) (call $tlen (local.get $a))))
    (loop $bytes
      (if (i32.lt_u (local.get $p) (local.get $e)) (then
        (if (call $xb_n) (then (call $xb_byte (i32.const ' '))))
        (local.set $v (i32.load8_u (local.get $p)))
        (call $xb_byte (call $hex_lower (i32.shr_u (local.get $v) (i32.const 4))))
        (call $xb_byte (call $hex_lower (i32.and (local.get $v) (i32.const 15))))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $bytes))))
    (return (call $xb_string (i32.const 0)))))
  (if (i32.eq (local.get $f) (i32.const F_SX_DECODEURI)) (then
    (if (i32.eqz (call $is_str (local.get $a))) (then (return (i32.const 0))))
    (call $xb_reset)
    (local.set $p (call $tval (local.get $a)))
    (local.set $e (i32.add (local.get $p) (call $tlen (local.get $a))))
    (loop $bytes
      (if (i32.lt_u (local.get $p) (local.get $e)) (then
        (local.set $v (i32.load8_u (local.get $p)))
        (if (i32.eq (local.get $v) (i32.const '%'))
          (then
            (if (i32.gt_u (i32.add (local.get $p) (i32.const 3)) (local.get $e)) (then (return (i32.const 0))))
            (local.set $h (call $hex_val (i32.load8_u offset=1 (local.get $p))))
            (local.set $i (call $hex_val (i32.load8_u offset=2 (local.get $p))))
            (if (i32.or (i32.lt_s (local.get $h) (i32.const 0)) (i32.lt_s (local.get $i) (i32.const 0))) (then (return (i32.const 0))))
            (call $xb_byte (i32.or (i32.shl (local.get $h) (i32.const 4)) (local.get $i)))
            (local.set $p (i32.add (local.get $p) (i32.const 3))))
          (else
            (call $xb_byte (local.get $v))
            (local.set $p (i32.add (local.get $p) (i32.const 1)))))
        (br $bytes))))
    (if (i32.eqz (call $utf8_ok (call $xb_ptr) (call $xb_n))) (then (return (i32.const 0))))
    (return (call $xb_string (i32.const 0)))))
  (if (i32.eq (local.get $f) (i32.const F_SX_FNV1A)) (then
    (if (i32.eqz (call $is_str (local.get $a))) (then (return (i32.const 0))))
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $p (call $tval (local.get $a)))
    (local.set $e (i32.add (local.get $p) (call $tlen (local.get $a))))
    (loop $bytes
      (if (i32.lt_u (local.get $p) (local.get $e)) (then
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.load8_u (local.get $p))) (i32.const 0x01000193)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $bytes))))
    (local.set $i (i32.const 0))
    (loop $digits
      (i32.store8 (i32.add (global.get $nbuf) (local.get $i))
        (call $hex_lower (i32.and (i32.shr_u (local.get $h) (i32.sub (i32.const 28) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 15))))
      (br_if $digits (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 8))))
    (return (call $simple (global.get $nbuf) (i32.const 8)))))
  ;; sx:Locale
  (if (i32.eq (local.get $f) (i32.const F_SX_COLLATED)) (then (return (local.get $a))))
  (if (i32.eqz (call $is_str (local.get $b))) (then (return (i32.const 0))))
  (if (i32.and (i32.eq (local.get $argc) (i32.const 3)) (i32.eqz (call $is_str (local.get $c)))) (then (return (i32.const 0))))
  (if (i32.eq (local.get $f) (i32.const F_SX_SORTKEY)) (then
    (if (i32.eqz (call $is_str (local.get $a))) (then (return (i32.const 0))))
    (call $ix_reset)
    (call $ix_term (local.get $a))
    (call $ix_term (local.get $b))
    (return (call $ix_call (i32.const 3)))))
  (if (i32.eq (local.get $f) (i32.const F_SX_FORMATNUMBER))
    (then (if (i32.eqz (call $num (local.get $a))) (then (return (i32.const 0)))))
    (else (if (i32.eqz (call $sx_datetime (local.get $a))) (then (return (i32.const 0))))))
  (call $ix_reset)
  (call $ix_term (local.get $a))
  (call $ix_term (local.get $b))
  (if (i32.eq (local.get $argc) (i32.const 3))
    (then (call $ix_term (local.get $c)))
    (else (call $ix_arg (i32.const 0) (i32.const 0))))
  (call $ix_call (select (i32.const 0) (i32.const 1) (i32.eq (local.get $f) (i32.const F_SX_FORMATNUMBER)))))

;; --- magic relations: parsing ----------------------------------------------------------

(global $fold (mut i32) (i32.const 0))    ;; folding magic relations (a pattern's triples)
(global $colls (mut i32) (i32.const 0))   ;; collections written in the triples being parsed

;; A collection with head ref `head`: its items and the triples it expanded to
;; (vectors, freed here). Record (arena): +0 head, +4 items (+0 count, refs), +8 triples (same), +12 next.
(func $coll_add (param $head i32) (param $items i32) (param $tps i32)
  (local $r i32)
  (local.set $r (call $anew (i32.const 16)))
  (i32.store (local.get $r) (local.get $head))
  (i32.store offset=4 (local.get $r) (call $vec_arena (local.get $items)))
  (i32.store offset=8 (local.get $r) (call $vec_arena (local.get $tps)))
  (i32.store offset=12 (local.get $r) (global.get $colls))
  (global.set $colls (local.get $r)))

;; A vector as an arena array (+0 count, then the words); the vector is freed.
(func $vec_arena (param $v i32) (result i32)
  (local $a i32) (local $n i32)
  (local.set $n (i32.load offset=4 (local.get $v)))
  (local.set $a (call $anew (i32.shl (i32.add (local.get $n) (i32.const 1)) (i32.const 2))))
  (i32.store (local.get $a) (local.get $n))
  (memory.copy (i32.add (local.get $a) (i32.const 4)) (i32.load (local.get $v)) (i32.shl (local.get $n) (i32.const 2)))
  (call $v_free (local.get $v))
  (local.get $a))

(func $coll_find (param $ref i32) (result i32)
  (local $r i32)
  (if (i32.ge_s (local.get $ref) (i32.const 0)) (then (return (i32.const 0))))
  (local.set $r (global.get $colls))
  (loop $each
    (if (local.get $r) (then
      (if (i32.eq (i32.load (local.get $r)) (local.get $ref)) (then (return (local.get $r))))
      (local.set $r (i32.load offset=12 (local.get $r)))
      (br $each))))
  (i32.const 0))

;; Remove the triples of collection record c from g's elements.
(func $coll_unlink (param $g i32) (param $c i32)
  (local $tps i32) (local $i i32) (local $prev i32) (local $el i32) (local $next i32) (local $j i32) (local $hit i32)
  (local.set $tps (i32.load offset=8 (local.get $c)))
  (local.set $el (i32.load offset=4 (local.get $g)))
  (loop $elements
    (if (local.get $el) (then
      (local.set $next (i32.load offset=28 (local.get $el)))
      (local.set $hit (i32.const 0))
      (local.set $j (i32.const 0))
      (loop $find
        (if (i32.lt_u (local.get $j) (i32.load (local.get $tps))) (then
          (if (i32.eq (i32.load offset=4 (i32.add (local.get $tps) (i32.shl (local.get $j) (i32.const 2)))) (local.get $el))
            (then (local.set $hit (i32.const 1))))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $find))))
      (if (local.get $hit)
        (then
          (if (local.get $prev)
            (then (i32.store offset=28 (local.get $prev) (local.get $next)))
            (else (i32.store offset=4 (local.get $g) (local.get $next))))
          (i32.store offset=28 (local.get $el) (i32.const 0)))
        (else (local.set $prev (local.get $el))))
      (local.set $el (local.get $next))
      (br $elements))))
  (i32.store offset=16 (local.get $g) (local.get $prev)))

;; (s p o) with p a magic relation and s, o collections written in the triples:
;; one P_MAGIC, held on g until its basic graph pattern ends. Whether folded.
(func $magic_fold (param $g i32) (param $s i32) (param $p i32) (param $o i32) (result i32)
  (local $rel i32) (local $cs i32) (local $co i32) (local $n i32) (local $l i32)
  (if (i32.eqz (local.tee $rel (call $sx_rel (local.get $p)))) (then (return (i32.const 0))))
  (if (i32.eqz (local.tee $cs (call $coll_find (local.get $s)))) (then (return (i32.const 0))))
  (if (i32.eqz (local.tee $co (call $coll_find (local.get $o)))) (then (return (i32.const 0))))
  (call $coll_unlink (local.get $g) (local.get $cs))
  (call $coll_unlink (local.get $g) (local.get $co))
  (local.set $n (call $node3 (i32.const P_MAGIC) (local.get $rel) (i32.load offset=4 (local.get $cs)) (i32.load offset=4 (local.get $co))))
  ;; pending, in order
  (if (local.tee $l (i32.load offset=24 (local.get $g)))
    (then
      (loop $last (if (i32.load offset=28 (local.get $l)) (then (local.set $l (i32.load offset=28 (local.get $l))) (br $last))))
      (i32.store offset=28 (local.get $l) (local.get $n)))
    (else (i32.store offset=24 (local.get $g) (local.get $n))))
  (i32.const 1))

;; The pending magic relations of g joined to its elements.
(func $magic_flush (param $g i32)
  (local $n i32) (local $next i32)
  (local.set $n (i32.load offset=24 (local.get $g)))
  (i32.store offset=24 (local.get $g) (i32.const 0))
  (loop $each
    (if (local.get $n) (then
      (local.set $next (i32.load offset=28 (local.get $n)))
      (i32.store offset=28 (local.get $n) (i32.const 0))
      (call $append (i32.add (local.get $g) (i32.const 4)) (i32.add (local.get $g) (i32.const 16)) (local.get $n))
      (local.set $n (local.get $next))
      (br $each)))))

;; Whether a ref list (+0 count, then refs) has slot.
(func $refs_have (param $l i32) (param $slot i32) (result i32)
  (local $i i32)
  (loop $each
    (if (i32.lt_u (local.get $i) (i32.load (local.get $l))) (then
      (if (call $ref_has (i32.load offset=4 (i32.add (local.get $l) (i32.shl (local.get $i) (i32.const 2)))) (local.get $slot)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each))))
  (i32.const 0))

;; Set in bitset b the variables of a ref list.
(func $refs_bits (param $b i32) (param $l i32)
  (local $i i32)
  (loop $each
    (if (i32.lt_u (local.get $i) (i32.load (local.get $l))) (then
      (call $an_ref (local.get $b) (i32.load offset=4 (i32.add (local.get $l) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each)))))

;; --- magic relations: evaluation ---------------------------------------------------------

(global $mg_row (mut i32) (i32.const 0))    ;; the input row
(global $mg_outs (mut i32) (i32.const 0))   ;; the output refs
(global $mg_out (mut i32) (i32.const 0))    ;; the table rows go to
(global $mg_tmp (mut i32) (i32.const 0))    ;; a scratch row
(global $mg_vals (mut i32) (i32.const 0))   ;; the values of one relation row (36 words)

;; One row of the relation (nv values from $mg_vals, 0 unbound) joined with the
;; input row: an unbound value leaves a variable as it is and fails a term.
(func $mg_emit (param $nv i32)
  (local $j i32) (local $ref i32) (local $v i32)
  (memory.copy (global.get $mg_tmp) (global.get $mg_row) (global.get $W))
  (loop $outs
    (if (i32.lt_u (local.get $j) (i32.load (global.get $mg_outs))) (then
      (local.set $ref (i32.load offset=4 (i32.add (global.get $mg_outs) (i32.shl (local.get $j) (i32.const 2)))))
      (local.set $v (if (result i32) (i32.lt_u (local.get $j) (local.get $nv))
        (then (i32.load (i32.add (global.get $mg_vals) (i32.shl (local.get $j) (i32.const 2))))) (else (i32.const 0))))
      (if (local.get $v)
        (then (if (i32.eqz (call $unify (local.get $ref) (local.get $v) (global.get $mg_tmp))) (then (return))))
        (else (if (i32.gt_s (local.get $ref) (i32.const 0)) (then (return)))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $outs))))
  (call $t_push (global.get $mg_out) (global.get $mg_tmp)))

(func $mg_val (param $i i32) (param $v i32)
  (i32.store (i32.add (global.get $mg_vals) (i32.shl (local.get $i) (i32.const 2))) (local.get $v)))

;; Magic relation el joined with t, into out.
(func $eval_magic (param $el i32) (param $t i32) (param $out i32)
  (local $i i32) (local $j i32) (local $ins i32) (local $nin i32) (local $rel i32) (local $v i32) (local $a i32) (local $b i32) (local $c i32)
  (local $s_row i32) (local $s_outs i32) (local $s_out i32) (local $s_tmp i32) (local $s_vals i32)
  (local.set $rel (i32.load offset=4 (local.get $el)))
  (local.set $ins (i32.load offset=8 (local.get $el)))
  (local.set $nin (i32.load (local.get $ins)))
  ;; nested evaluation (EXISTS in a FILTER is not reached from here, but keep it safe)
  (local.set $s_row (global.get $mg_row))
  (local.set $s_outs (global.get $mg_outs))
  (local.set $s_out (global.get $mg_out))
  (local.set $s_tmp (global.get $mg_tmp))
  (local.set $s_vals (global.get $mg_vals))
  (global.set $mg_outs (i32.load offset=12 (local.get $el)))
  (global.set $mg_out (local.get $out))
  (global.set $mg_tmp (call $row_get))
  (global.set $mg_vals (call $rs_alloc (i32.const 144)))
  (block $none
    ;; the relation's shape of inputs
    (br_if $none (i32.eqz (if (result i32) (i32.eq (local.get $rel) (i32.const MR_MATCHES))
      (then (i32.le_u (i32.sub (local.get $nin) (i32.const 2)) (i32.const 1)))
      (else (i32.eq (local.get $nin) (i32.const 1))))))
    (loop $rows
      (if (i32.and (i32.lt_u (local.get $i) (i32.load offset=4 (local.get $t))) (i32.eqz (global.get $bu_stop))) (then
        (global.set $mg_row (call $t_row (local.get $t) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        ;; inputs: bound, of the right kind
        (local.set $a (call $resolve_ref (i32.load offset=4 (local.get $ins)) (global.get $mg_row)))
        (br_if $rows (i32.le_s (local.get $a) (i32.const 0)))
        (br_if $rows (i32.eqz (call $is_str (local.get $a))))
        (if (i32.eq (local.get $rel) (i32.const MR_MATCHES)) (then
          (local.set $b (call $resolve_ref (i32.load offset=8 (local.get $ins)) (global.get $mg_row)))
          (br_if $rows (i32.le_s (local.get $b) (i32.const 0)))
          (br_if $rows (i32.eqz (call $is_plain (local.get $b))))
          (local.set $c (i32.const 0))
          (if (i32.eq (local.get $nin) (i32.const 3)) (then
            (local.set $c (call $resolve_ref (i32.load offset=12 (local.get $ins)) (global.get $mg_row)))
            (br_if $rows (i32.le_s (local.get $c) (i32.const 0)))
            (br_if $rows (i32.eqz (call $is_plain (local.get $c))))))
          (call $mg_matches (local.get $a) (local.get $b) (local.get $c))
          (br $rows)))
        (if (i32.eq (local.get $rel) (i32.const MR_CHARS)) (then
          (call $mg_chars (local.get $a))
          (br $rows)))
        (call $mg_json (local.get $a))
        (br $rows)))))
  (call $row_put (global.get $mg_tmp))
  (global.set $mg_row (local.get $s_row))
  (global.set $mg_outs (local.get $s_outs))
  (global.set $mg_out (local.get $s_out))
  (global.set $mg_tmp (local.get $s_tmp))
  (global.set $mg_vals (local.get $s_vals)))

;; sx:matches: (match, start, groups ...) per non-overlapping match, as JavaScript's matchAll.
(func $mg_matches (param $text i32) (param $pat i32) (param $flags i32)
  (local $prog i32) (local $s i32) (local $n i32) (local $from i32) (local $m i32) (local $e i32) (local $cur i32) (local $cpos i32)
  (local $ng i32) (local $g i32) (local $x i32) (local $y i32)
  (if (i32.eqz (local.tee $prog (call $re_compile (local.get $pat) (local.get $flags)))) (then (return)))
  (if (i32.eqz (global.get $caps)) (then (global.set $caps (call $alloc (i32.const 272)))))
  (local.set $ng (i32.load (local.get $prog)))
  (if (i32.gt_u (local.get $ng) (i32.const 32)) (then (local.set $ng (i32.const 32))))
  (local.set $s (call $tval (local.get $text)))
  (local.set $n (call $tlen (local.get $text)))
  (loop $matches
    (if (i32.le_u (local.get $from) (local.get $n)) (then
      (if (i32.lt_s (local.tee $m (call $re_find (local.get $prog) (local.get $s) (local.get $n) (local.get $from))) (i32.const 0)) (then (return)))
      (local.set $e (global.get $m_end))
      (local.set $cpos (i32.add (local.get $cpos) (call $cp_count (i32.add (local.get $s) (local.get $cur)) (i32.sub (local.get $m) (local.get $cur)))))
      (local.set $cur (local.get $m))
      (call $mg_val (i32.const 0) (call $simple (i32.add (local.get $s) (local.get $m)) (i32.sub (local.get $e) (local.get $m))))
      (call $mg_val (i32.const 1) (call $int_term (i64.extend_i32_u (i32.add (local.get $cpos) (i32.const 1)))))
      (local.set $g (i32.const 1))
      (loop $groups
        (if (i32.le_u (local.get $g) (local.get $ng)) (then
          (local.set $x (i32.load (i32.add (global.get $caps) (i32.shl (local.get $g) (i32.const 3)))))
          (local.set $y (i32.load offset=4 (i32.add (global.get $caps) (i32.shl (local.get $g) (i32.const 3)))))
          (call $mg_val (i32.add (local.get $g) (i32.const 1))
            (if (result i32) (i32.and (i32.ge_s (local.get $x) (i32.const 0)) (i32.ge_s (local.get $y) (local.get $x)))
              (then (call $simple (i32.add (local.get $s) (local.get $x)) (i32.sub (local.get $y) (local.get $x))))
              (else (i32.const 0))))
          (local.set $g (i32.add (local.get $g) (i32.const 1)))
          (br $groups))))
      (call $mg_emit (i32.add (local.get $ng) (i32.const 2)))
      (if (i32.gt_u (local.get $e) (local.get $m))
        (then (local.set $from (local.get $e)))
        (else
          ;; an empty match: the next search one code point further
          (if (i32.ge_u (local.get $m) (local.get $n)) (then (return)))
          (drop (call $decode (i32.add (local.get $s) (local.get $m))))
          (local.set $from (i32.add (local.get $m) (global.get $cplen)))))
      (br $matches)))))

;; sx:chars: (char, index) per code point.
(func $mg_chars (param $text i32)
  (local $p i32) (local $e i32) (local $i i32)
  (local.set $p (call $tval (local.get $text)))
  (local.set $e (i32.add (local.get $p) (call $tlen (local.get $text))))
  (loop $cps
    (if (i32.lt_u (local.get $p) (local.get $e)) (then
      (drop (call $decode (local.get $p)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (call $mg_val (i32.const 0) (call $simple (local.get $p) (global.get $cplen)))
      (call $mg_val (i32.const 1) (call $int_term (i64.extend_i32_u (local.get $i))))
      (call $mg_emit (i32.const 2))
      (local.set $p (i32.add (local.get $p) (global.get $cplen)))
      (br $cps)))))

;; sx:json: (path, parent, key, kind, value) per value, in document order.
(func $mg_json (param $text i32)
  (local $v i32) (local $i i32) (local $j i32)
  (if (i32.eqz (local.tee $v (call $js_parse (call $tval (local.get $text)) (call $tlen (local.get $text))))) (then (return)))
  (loop $values
    (if (i32.lt_u (local.get $i) (i32.load offset=4 (local.get $v))) (then
      (local.set $j (i32.const 0))
      (loop $cols
        (call $mg_val (local.get $j) (call $v_at (local.get $v) (i32.add (local.get $i) (local.get $j))))
        (br_if $cols (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const 5))))
      (call $mg_emit (i32.const 5))
      (local.set $i (i32.add (local.get $i) (i32.const 5)))
      (br $values))))
  (call $v_free (local.get $v)))

;; --- JSON (RFC 8259) -------------------------------------------------------------------

(global $js_p (mut i32) (i32.const 0))
(global $js_e (mut i32) (i32.const 0))
(global $js_rows (mut i32) (i32.const 0))   ;; vector: 5 ids per value
(global $js_path (mut i32) (i32.const 0))   ;; the current pointer (a byte buffer)
(global $js_str (mut i32) (i32.const 0))    ;; the last string read (a byte buffer)

;; Parse [p, p+n): a vector of rows, or 0 when it is not JSON.
(func $js_parse (param $p i32) (param $n i32) (result i32)
  (local $ok i32)
  (if (i32.eqz (global.get $js_path)) (then
    (global.set $js_path (call $gb_new))
    (global.set $js_str (call $gb_new))))
  (i32.store offset=4 (global.get $js_path) (i32.const 0))
  (global.set $js_p (local.get $p))
  (global.set $js_e (i32.add (local.get $p) (local.get $n)))
  (global.set $js_rows (call $v_new))
  (local.set $ok (call $js_value (i32.const 0) (i32.const 0) (i32.const 0)))
  (call $js_ws)
  (if (i32.and (local.get $ok) (i32.eq (global.get $js_p) (global.get $js_e))) (then (return (global.get $js_rows))))
  (call $v_free (global.get $js_rows))
  (i32.const 0))

(func $js_ws
  (loop $spaces
    (if (i32.lt_u (global.get $js_p) (global.get $js_e)) (then
      (if (call $one_of (i32.load8_u (global.get $js_p)) (@str " \t\n\r")) (then
        (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
        (br $spaces)))))))

(func $js_peek (result i32)
  (if (result i32) (i32.lt_u (global.get $js_p) (global.get $js_e)) (then (i32.load8_u (global.get $js_p))) (else (i32.const -1))))

;; Consume byte c after white space: whether it was there.
(func $js_eat (param $c i32) (result i32)
  (call $js_ws)
  (if (i32.ne (call $js_peek) (local.get $c)) (then (return (i32.const 0))))
  (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
  (i32.const 1))

(func $js_word (param $s i32) (param $n i32) (result i32)
  (if (i32.gt_u (i32.add (global.get $js_p) (local.get $n)) (global.get $js_e)) (then (return (i32.const 0))))
  (if (i32.eqz (call $memeq (global.get $js_p) (local.get $s) (local.get $n))) (then (return (i32.const 0))))
  (global.set $js_p (i32.add (global.get $js_p) (local.get $n)))
  (i32.const 1))

;; A value (after white space) with its parent's pointer and its key (0 for the
;; root); depth: the containers around it.
(func $js_value (param $parent i32) (param $key i32) (param $depth i32) (result i32)
  (local $c i32) (local $path i32) (local $at i32) (local $i i32) (local $len i32) (local $start i32) (local $dt i32)
  (call $js_ws)
  (local.set $c (call $js_peek))
  (local.set $path (call $simple (i32.load (global.get $js_path)) (i32.load offset=4 (global.get $js_path))))
  (local.set $len (i32.load offset=4 (global.get $js_path)))
  (if (i32.or (i32.eq (local.get $c) (i32.const '{')) (i32.eq (local.get $c) (i32.const '['))) (then
    (if (i32.ge_u (local.get $depth) (i32.const 512)) (then (return (i32.const 0))))
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (call $js_row (local.get $path) (local.get $parent) (local.get $key)
      (if (result i32) (i32.eq (local.get $c) (i32.const '{')) (then (call $simple (@str "object"))) (else (call $simple (@str "array"))))
      (i32.const 0))
    (if (call $js_eat (i32.add (local.get $c) (i32.const 2))) (then (return (i32.const 1))))   ;; '}' or ']'
    (loop $members
      (if (i32.eq (local.get $c) (i32.const '{'))
        (then
          (call $js_ws)
          (if (i32.eqz (call $js_string)) (then (return (i32.const 0))))
          (local.set $at (call $simple (i32.load (global.get $js_str)) (i32.load offset=4 (global.get $js_str))))
          (if (i32.eqz (call $js_eat (i32.const ':'))) (then (return (i32.const 0))))
          (call $js_token (i32.load (global.get $js_str)) (i32.load offset=4 (global.get $js_str))))
        (else
          (local.set $at (call $int_term (i64.extend_i32_u (local.get $i))))
          (call $gb_byte (global.get $js_path) (i32.const '/'))
          (i32.store offset=4 (global.get $js_path)
            (i32.sub (call $u64_digits (call $js_path_room) (i64.extend_i32_u (local.get $i))) (i32.load (global.get $js_path))))))
      (if (i32.eqz (call $js_value (local.get $path) (local.get $at) (i32.add (local.get $depth) (i32.const 1)))) (then (return (i32.const 0))))
      (i32.store offset=4 (global.get $js_path) (local.get $len))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (call $js_eat (i32.const ',')) (then (br $members))))
    (return (call $js_eat (i32.add (local.get $c) (i32.const 2))))))
  (if (i32.eq (local.get $c) (i32.const '"')) (then
    (if (i32.eqz (call $js_string)) (then (return (i32.const 0))))
    (call $js_row (local.get $path) (local.get $parent) (local.get $key) (call $simple (@str "string"))
      (call $simple (i32.load (global.get $js_str)) (i32.load offset=4 (global.get $js_str))))
    (return (i32.const 1))))
  (if (call $js_word (@str "true")) (then
    (call $js_row (local.get $path) (local.get $parent) (local.get $key) (call $simple (@str "boolean")) (call $bool (i32.const 1)))
    (return (i32.const 1))))
  (if (call $js_word (@str "false")) (then
    (call $js_row (local.get $path) (local.get $parent) (local.get $key) (call $simple (@str "boolean")) (call $bool (i32.const 0)))
    (return (i32.const 1))))
  (if (call $js_word (@str "null")) (then
    (call $js_row (local.get $path) (local.get $parent) (local.get $key) (call $simple (@str "null")) (i32.const 0))
    (return (i32.const 1))))
  ;; a number: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?
  (local.set $start (global.get $js_p))
  (local.set $dt (i32.const K_INTEGER))
  (if (i32.eq (local.get $c) (i32.const '-')) (then
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (local.set $c (call $js_peek))))
  (if (i32.eq (local.get $c) (i32.const '0'))
    (then (global.set $js_p (i32.add (global.get $js_p) (i32.const 1))))
    (else (if (i32.eqz (call $js_digits)) (then (return (i32.const 0))))))
  (if (i32.eq (call $js_peek) (i32.const '.')) (then
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (if (i32.eqz (call $js_digits)) (then (return (i32.const 0))))
    (local.set $dt (i32.const K_DECIMAL))))
  (if (i32.eq (i32.or (call $js_peek) (i32.const 32)) (i32.const 'e')) (then
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (if (i32.or (i32.eq (call $js_peek) (i32.const '+')) (i32.eq (call $js_peek) (i32.const '-')))
      (then (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))))
    (if (i32.eqz (call $js_digits)) (then (return (i32.const 0))))
    (local.set $dt (i32.const K_DOUBLE))))
  (call $js_row (local.get $path) (local.get $parent) (local.get $key) (call $simple (@str "number"))
    (call $typed (local.get $start) (i32.sub (global.get $js_p) (local.get $start)) (call $known (local.get $dt))))
  (i32.const 1))

;; One or more digits: whether there were any.
(func $js_digits (result i32)
  (local $start i32)
  (local.set $start (global.get $js_p))
  (loop $digits
    (if (call $is_digit (call $js_peek)) (then
      (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
      (br $digits))))
  (i32.ne (global.get $js_p) (local.get $start)))

;; Room for 20 more bytes at the end of the pointer: the address there.
(func $js_path_room (result i32)
  (call $gb_room (global.get $js_path) (i32.const 20))
  (i32.add (i32.load (global.get $js_path)) (i32.load offset=4 (global.get $js_path))))

;; "/" and the member name [p, p+n) as a pointer token (~ as ~0, / as ~1).
(func $js_token (param $p i32) (param $n i32)
  (local $c i32) (local $e i32)
  (local.set $e (i32.add (local.get $p) (local.get $n)))
  (call $gb_byte (global.get $js_path) (i32.const '/'))
  (loop $bytes
    (if (i32.lt_u (local.get $p) (local.get $e)) (then
      (local.set $c (i32.load8_u (local.get $p)))
      (if (i32.eq (local.get $c) (i32.const '~'))
        (then (call $gb_byte (global.get $js_path) (i32.const '~')) (call $gb_byte (global.get $js_path) (i32.const '0')))
        (else (if (i32.eq (local.get $c) (i32.const '/'))
          (then (call $gb_byte (global.get $js_path) (i32.const '~')) (call $gb_byte (global.get $js_path) (i32.const '1')))
          (else (call $gb_byte (global.get $js_path) (local.get $c))))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $bytes)))))

(func $js_row (param $path i32) (param $parent i32) (param $key i32) (param $kind i32) (param $value i32)
  (call $v_push1 (global.get $js_rows) (local.get $path))
  (call $v_push1 (global.get $js_rows) (local.get $parent))
  (call $v_push1 (global.get $js_rows) (local.get $key))
  (call $v_push1 (global.get $js_rows) (local.get $kind))
  (call $v_push1 (global.get $js_rows) (local.get $value)))

;; Four hex digits: their value, or -1.
(func $js_hex4 (result i32)
  (local $v i32) (local $i i32) (local $d i32)
  (if (i32.gt_u (i32.add (global.get $js_p) (i32.const 4)) (global.get $js_e)) (then (return (i32.const -1))))
  (loop $digits
    (if (i32.lt_s (local.tee $d (call $hex_val (i32.load8_u (i32.add (global.get $js_p) (local.get $i))))) (i32.const 0)) (then (return (i32.const -1))))
    (local.set $v (i32.or (i32.shl (local.get $v) (i32.const 4)) (local.get $d)))
    (br_if $digits (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 4))))
  (global.set $js_p (i32.add (global.get $js_p) (i32.const 4)))
  (local.get $v))

;; A string (on '"'), its value into $js_str: whether it is valid.
(func $js_string (result i32)
  (local $c i32) (local $u i32) (local $lo i32)
  (if (i32.ne (call $js_peek) (i32.const '"')) (then (return (i32.const 0))))
  (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
  (i32.store offset=4 (global.get $js_str) (i32.const 0))
  (loop $chars
    (if (i32.ge_u (global.get $js_p) (global.get $js_e)) (then (return (i32.const 0))))
    (local.set $c (i32.load8_u (global.get $js_p)))
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (if (i32.eq (local.get $c) (i32.const '"')) (then (return (i32.const 1))))
    (if (i32.lt_u (local.get $c) (i32.const 0x20)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $c) (i32.const '\\')) (then
      (call $gb_byte (global.get $js_str) (local.get $c))
      (br $chars)))
    (local.set $c (call $js_peek))
    (global.set $js_p (i32.add (global.get $js_p) (i32.const 1)))
    (if (i32.eq (local.get $c) (i32.const 'u')) (then
      (if (i32.lt_s (local.tee $u (call $js_hex4)) (i32.const 0)) (then (return (i32.const 0))))
      (if (call $in (local.get $u) (i32.const 0xdc00) (i32.const 0xdfff)) (then (return (i32.const 0))))
      (if (call $in (local.get $u) (i32.const 0xd800) (i32.const 0xdbff)) (then
        ;; a high surrogate: a low one must follow
        (if (i32.eqz (call $js_word (@str "\\u"))) (then (return (i32.const 0))))
        (local.set $lo (call $js_hex4))
        (if (i32.eqz (call $in (local.get $lo) (i32.const 0xdc00) (i32.const 0xdfff))) (then (return (i32.const 0))))
        (local.set $u (i32.add (i32.const 0x10000)
          (i32.or (i32.shl (i32.sub (local.get $u) (i32.const 0xd800)) (i32.const 10)) (i32.sub (local.get $lo) (i32.const 0xdc00)))))))
      (call $gb_cp (global.get $js_str) (local.get $u))
      (br $chars)))
    (if (i32.eqz (call $one_of (local.get $c) (@str "\"\\/bfnrt"))) (then (return (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 'b')) (then (local.set $c (i32.const 8))))
    (if (i32.eq (local.get $c) (i32.const 'f')) (then (local.set $c (i32.const 12))))
    (if (i32.eq (local.get $c) (i32.const 'n')) (then (local.set $c (i32.const 10))))
    (if (i32.eq (local.get $c) (i32.const 'r')) (then (local.set $c (i32.const 13))))
    (if (i32.eq (local.get $c) (i32.const 't')) (then (local.set $c (i32.const 9))))
    (call $gb_byte (global.get $js_str) (local.get $c))
    (br $chars))
  (unreachable))
