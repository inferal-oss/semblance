;; Jelly-RDF (../JELLY.md, ABI.md "Jelly"): a reader of 1.2 (the column layout) and 1.0/1.1 (the
;; row layout) and a writer of 1.2, frame by frame, decoding protobuf in place. The writer makes the
;; choices JELLY.md fixes, so it writes the bytes the Rust build and src/jelly/ write.
;;
;; Errors: every failing path goes through $jerr, which sets the message and $jbad; functions
;; return 0 (or -1 for statuses) and callers check $jbad. The exports clear it first.

;; --- the wire format: a cursor over [$jp, $je) -----------------------------------------

(global $jp (mut i32) (i32.const 0))
(global $je (mut i32) (i32.const 0))
(global $jbad (mut i32) (i32.const 0))
(global $jw (mut i32) (i32.const 0))   ;; the wire type of the last tag
(global $js (mut i32) (i32.const 0))   ;; the last length-delimited field: [$js, $jl)
(global $jl (mut i32) (i32.const 0))

(func $jerr (param $p i32) (param $n i32) (result i32)
  (global.set $jbad (i32.const 1))
  (call $fail (local.get $p) (local.get $n)))

;; $jerr, returning 0 (for functions that return ids).
(func $jerr0 (param $p i32) (param $n i32) (result i32)
  (drop (call $jerr (local.get $p) (local.get $n)))
  (i32.const 0))

;; A varint of up to 10 bytes.
(func $jv64 (result i64)
  (local $x i64) (local $c i32) (local $shift i64)
  (if (i32.lt_u (global.get $jp) (global.get $je)) (then
    (local.set $c (i32.load8_u (global.get $jp)))
    (if (i32.lt_u (local.get $c) (i32.const 0x80)) (then
      (global.set $jp (i32.add (global.get $jp) (i32.const 1)))
      (return (i64.extend_i32_u (local.get $c)))))))
  (loop $l
    (if (i32.ge_u (global.get $jp) (global.get $je)) (then
      (drop (call $jerr (@str "truncated varint")))
      (return (i64.const 0))))
    (local.set $c (i32.load8_u (global.get $jp)))
    (global.set $jp (i32.add (global.get $jp) (i32.const 1)))
    (if (i64.lt_u (local.get $shift) (i64.const 64))
      (then (local.set $x (i64.or (local.get $x) (i64.shl (i64.extend_i32_u (i32.and (local.get $c) (i32.const 0x7f))) (local.get $shift))))))
    (if (i32.lt_u (local.get $c) (i32.const 0x80)) (then (return (local.get $x))))
    (local.set $shift (i64.add (local.get $shift) (i64.const 7)))
    (br_if $l (i64.lt_u (local.get $shift) (i64.const 70))))
  (drop (call $jerr (@str "varint longer than 10 bytes")))
  (i64.const 0))

;; A varint as a u32, saturated.
(func $jv (result i32)
  (local $x i64)
  (local.set $x (call $jv64))
  (if (result i32) (i64.gt_u (local.get $x) (i64.const 0xffffffff)) (then (i32.const -1)) (else (i32.wrap_i64 (local.get $x)))))

;; A varint field's value.
(func $juint (param $wire i32) (result i32)
  (if (local.get $wire) (then (return (call $jerr (@str "expected a varint field")))))
  (call $jv))

;; A tag: returns the field number (0 on an error) and sets $jw.
(func $jtag (result i32)
  (local $t i64)
  (local.set $t (call $jv64))
  (if (global.get $jbad) (then (return (i32.const 0))))
  (if (i64.eqz (i64.shr_u (local.get $t) (i64.const 3))) (then (drop (call $jerr (@str "field number 0"))) (return (i32.const 0))))
  (global.set $jw (i32.wrap_i64 (i64.and (local.get $t) (i64.const 7))))
  (if (result i32) (i64.gt_u (local.get $t) (i64.const 0x7ffffffff)) (then (i32.const -1)) (else (i32.wrap_i64 (i64.shr_u (local.get $t) (i64.const 3))))))

;; A length-delimited field: [$js, $jl), and the cursor after it. Returns 1, or 0 on an error.
(func $jlen (result i32)
  (local $n i64)
  (local.set $n (call $jv64))
  (if (global.get $jbad) (then (return (i32.const 0))))
  (if (i64.gt_u (local.get $n) (i64.extend_i32_u (i32.sub (global.get $je) (global.get $jp)))) (then
    (drop (call $jerr (@str "truncated field")))
    (return (i32.const 0))))
  (global.set $js (global.get $jp))
  (global.set $jl (i32.add (global.get $jp) (i32.wrap_i64 (local.get $n))))
  (global.set $jp (global.get $jl))
  (i32.const 1))

;; A string field, checked to be UTF-8.
(func $jstr (result i32)
  (if (i32.eqz (call $jlen)) (then (return (i32.const 0))))
  (if (i32.eqz (call $utf8_ok (global.get $js) (i32.sub (global.get $jl) (global.get $js)))) (then
    (drop (call $jerr (@str "invalid UTF-8")))
    (return (i32.const 0))))
  (i32.const 1))

(func $jskip (param $wire i32)
  (if (i32.eqz (local.get $wire)) (then (drop (call $jv64)) (return)))
  (if (i32.eq (local.get $wire) (i32.const 2)) (then (drop (call $jlen)) (return)))
  (if (i32.or (i32.eq (local.get $wire) (i32.const 1)) (i32.eq (local.get $wire) (i32.const 5))) (then
    (local.set $wire (select (i32.const 8) (i32.const 4) (i32.eq (local.get $wire) (i32.const 1))))
    (if (i32.lt_u (i32.sub (global.get $je) (global.get $jp)) (local.get $wire)) (then (drop (call $jerr (@str "truncated field"))) (return)))
    (global.set $jp (i32.add (global.get $jp) (local.get $wire)))
    (return)))
  (drop (call $jerr (@str "unsupported wire type"))))

;; The varints of a repeated field, packed or not, onto vector v.
(func $jpacked (param $wire i32) (param $v i32)
  (local $end i32)
  (if (i32.eqz (local.get $wire)) (then (call $v_push1 (local.get $v) (call $jv)) (return)))
  (if (i32.ne (local.get $wire) (i32.const 2)) (then (drop (call $jerr (@str "expected a varint field"))) (return)))
  (if (i32.eqz (call $jlen)) (then (return)))
  (local.set $end (global.get $je))
  (global.set $je (global.get $jl))
  (global.set $jp (global.get $js))
  (loop $l
    (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
      (call $v_push1 (local.get $v) (call $jv))
      (br $l))))
  (global.set $je (local.get $end)))

;; --- byte buffers (the writer's output): 12 bytes, +0 data, +4 length, +8 capacity -------

(func $ob_new (result i32)
  (local $b i32)
  (i32.store (local.tee $b (call $alloc (i32.const 12))) (call $alloc (i32.const 256)))
  (i32.store offset=4 (local.get $b) (i32.const 0))
  (i32.store offset=8 (local.get $b) (i32.const 256))
  (local.get $b))

(func $ob_free (param $b i32)
  (call $free (i32.load (local.get $b)) (i32.load offset=8 (local.get $b)))
  (call $free (local.get $b) (i32.const 12)))

(func $ob_room (param $b i32) (param $n i32)
  (local $cap i32) (local $need i32)
  (local.set $need (i32.add (i32.load offset=4 (local.get $b)) (local.get $n)))
  (local.set $cap (i32.load offset=8 (local.get $b)))
  (if (i32.le_u (local.get $need) (local.get $cap)) (then (return)))
  (loop $l (local.set $cap (i32.shl (local.get $cap) (i32.const 1))) (br_if $l (i32.lt_u (local.get $cap) (local.get $need))))
  (i32.store (local.get $b) (call $realloc (i32.load (local.get $b)) (i32.load offset=8 (local.get $b)) (local.get $cap) (i32.load offset=4 (local.get $b))))
  (i32.store offset=8 (local.get $b) (local.get $cap)))

(func $ob_end (param $b i32) (result i32)
  (i32.add (i32.load (local.get $b)) (i32.load offset=4 (local.get $b))))

(func $varint_at (param $p i32) (param $x i32) (result i32)
  (loop $l
    (if (i32.ge_u (local.get $x) (i32.const 0x80)) (then
      (i32.store8 (local.get $p) (i32.or (local.get $x) (i32.const 0x80)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (local.set $x (i32.shr_u (local.get $x) (i32.const 7)))
      (br $l))))
  (i32.store8 (local.get $p) (local.get $x))
  (i32.add (local.get $p) (i32.const 1)))

(func $varint_size (param $x i32) (result i32)
  (i32.add (i32.const 1) (i32.div_u (i32.sub (i32.const 31) (i32.clz (i32.or (local.get $x) (i32.const 1)))) (i32.const 7))))

(func $ob_varint (param $b i32) (param $x i32)
  (call $ob_room (local.get $b) (i32.const 5))
  (i32.store offset=4 (local.get $b) (i32.sub (call $varint_at (call $ob_end (local.get $b)) (local.get $x)) (i32.load (local.get $b)))))

(func $ob_bytes (param $b i32) (param $p i32) (param $n i32)
  (call $ob_room (local.get $b) (local.get $n))
  (memory.copy (call $ob_end (local.get $b)) (local.get $p) (local.get $n))
  (i32.store offset=4 (local.get $b) (i32.add (i32.load offset=4 (local.get $b)) (local.get $n))))

(func $ob_tag (param $b i32) (param $field i32) (param $wire i32)
  (call $ob_varint (local.get $b) (i32.or (i32.shl (local.get $field) (i32.const 3)) (local.get $wire))))

;; A varint field, left out when 0.
(func $ob_uint (param $b i32) (param $field i32) (param $x i32)
  (if (local.get $x) (then
    (call $ob_tag (local.get $b) (local.get $field) (i32.const 0))
    (call $ob_varint (local.get $b) (local.get $x)))))

(func $ob_str (param $b i32) (param $field i32) (param $p i32) (param $n i32)
  (call $ob_tag (local.get $b) (local.get $field) (i32.const 2))
  (call $ob_varint (local.get $b) (local.get $n))
  (call $ob_bytes (local.get $b) (local.get $p) (local.get $n)))

;; A packed repeated field of the n words at p, left out when n is 0.
(func $ob_packed (param $b i32) (param $field i32) (param $p i32) (param $n i32)
  (local $size i32) (local $i i32)
  (if (i32.eqz (local.get $n)) (then (return)))
  (loop $l
    (local.set $size (i32.add (local.get $size) (call $varint_size (i32.load (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))))))
    (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
  (call $ob_tag (local.get $b) (local.get $field) (i32.const 2))
  (call $ob_varint (local.get $b) (local.get $size))
  (call $ob_room (local.get $b) (local.get $size))
  (local.set $i (i32.const 0))
  (loop $w
    (call $ob_varint (local.get $b) (i32.load (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))))
    (br_if $w (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))

;; A message's contents start here; $ob_close puts its tag (field 0: none, a delimiter) and length in front.
(func $ob_open (param $b i32) (result i32) (i32.load offset=4 (local.get $b)))

(func $ob_close (param $b i32) (param $field i32) (param $start i32)
  (local $n i32) (local $h i32) (local $at i32)
  (local.set $n (i32.sub (i32.load offset=4 (local.get $b)) (local.get $start)))
  (local.set $h (i32.add (call $varint_size (local.get $n))
                         (select (call $varint_size (i32.or (i32.shl (local.get $field) (i32.const 3)) (i32.const 2))) (i32.const 0) (local.get $field))))
  (call $ob_room (local.get $b) (local.get $h))
  (local.set $at (i32.add (i32.load (local.get $b)) (local.get $start)))
  (memory.copy (i32.add (local.get $at) (local.get $h)) (local.get $at) (local.get $n))
  (if (local.get $field) (then (local.set $at (call $varint_at (local.get $at) (i32.or (i32.shl (local.get $field) (i32.const 3)) (i32.const 2))))))
  (drop (call $varint_at (local.get $at) (local.get $n)))
  (i32.store offset=4 (local.get $b) (i32.add (i32.load offset=4 (local.get $b)) (local.get $h))))

;; --- the reader ------------------------------------------------------------------------
;; A reader record (alloc0 144):
;;   +0 kind (1)            +4 graph               +8 failed            +12 has options
;;   +16 physical           +20 stream type        +24/+28/+32 max names, prefixes, datatypes
;;   +36 version            +40/+44 1.0/1.1 options bytes (ptr, len)
;;   +48 + 8k: lookup k (k 0 names, 1 prefixes, 2 datatypes): entries ptr, capacity (entries)
;;   +72 stamp              +76 + 4k: lookup k's last entry id
;;   +88/+92 the row layout's IRI sequence (prefix, name)
;;   +96..+108 the terms the row layout repeats (s, p, o, g)
;;   +112 the GRAPHS graph   +116 the message's scope   +120 statements in the message
;;   +124 blank node labels (an smap of 12 bytes; keys are owned copies)
;;   +136 message ends in the last frame (a vector)
;; A lookup entry (24 bytes): +0 value ptr, +4 len, +8 set, +12 stamp (a name's: the stamp of
;; the prefix its cached IRI used), +16 the cached IRI's prefix id, +20 cached term id.

(@define J_MAX_NAMES 16384)
(@define J_MAX_PREFIXES 4096)
(@define J_MAX_DATATYPES 256)
(@define J_MAX_DEPTH 100)

(global $jbuf (mut i32) (i32.const 0))      ;; a scratch buffer for IRIs
(global $jbuf_cap (mut i32) (i32.const 0))
(global $jseq (mut i32) (i32.const 0))      ;; scratch IRI sequences: +0 namespaces, +8 triple terms, +16 re-decoding
(global $jterms (mut i32) (i32.const 0))    ;; 16 bytes per nesting level, for the row layout's terms
;; A column's lists (vectors), reused: words, and (start, end) pairs for strings and messages.
(global $jl_layouts (mut i32) (i32.const 0))
(global $jl_names (mut i32) (i32.const 0))
(global $jl_prefixes (mut i32) (i32.const 0))
(global $jl_kinds (mut i32) (i32.const 0))
(global $jl_dirs (mut i32) (i32.const 0))
(global $jl_lex (mut i32) (i32.const 0))
(global $jl_langs (mut i32) (i32.const 0))
(global $jl_bnodes (mut i32) (i32.const 0))
(global $jl_tts (mut i32) (i32.const 0))
(global $jvals (mut i32) (i32.const 0))     ;; run values of a batch, 7 words each: id, dep, a, b, seq prefix, seq name, scope
(global $jlens (mut i32) (i32.const 0))     ;; message lengths of a batch
(global $jentries (mut i32) (i32.const 0))  ;; a batch's lookup entries: kind, start, end (3 words each)
(global $jhs (mut i32) (i32.const 0))       ;; Jelly handles: reader or writer records, 0 when free

(func $init_jelly
  (global.set $jseq (call $alloc0 (i32.const 24)))
  (global.set $jterms (call $alloc0 (i32.const 1616)))
  (global.set $jbuf_cap (i32.const 256))
  (global.set $jbuf (call $alloc (i32.const 256)))
  (global.set $jl_layouts (call $v_new)) (global.set $jl_names (call $v_new)) (global.set $jl_prefixes (call $v_new))
  (global.set $jl_kinds (call $v_new)) (global.set $jl_dirs (call $v_new)) (global.set $jl_lex (call $v_new))
  (global.set $jl_langs (call $v_new)) (global.set $jl_bnodes (call $v_new)) (global.set $jl_tts (call $v_new))
  (global.set $jvals (call $v_new)) (global.set $jlens (call $v_new)) (global.set $jentries (call $v_new))
  (global.set $jhs (call $v_new)))

(func $v_clear (param $v i32) (i32.store offset=4 (local.get $v) (i32.const 0)))
(func $v_len (param $v i32) (result i32) (i32.load offset=4 (local.get $v)))

(func $jbuf_room (param $n i32)
  (if (i32.gt_u (local.get $n) (global.get $jbuf_cap)) (then
    (call $free (global.get $jbuf) (global.get $jbuf_cap))
    (global.set $jbuf (call $alloc (local.get $n)))
    (global.set $jbuf_cap (call $class_size (call $class (local.get $n)))))))

(func $jr_new (param $graph i32) (result i32)
  (local $r i32)
  (local.set $r (call $alloc0 (i32.const 144)))
  (i32.store (local.get $r) (i32.const 1))
  (i32.store offset=4 (local.get $r) (select (local.get $graph) (i32.const 1) (local.get $graph)))
  (i32.store offset=136 (local.get $r) (call $v_new))
  (local.get $r))

;; Forget the blank node labels (owned keys are freed).
(func $jr_blanks_clear (param $r i32)
  (local $m i32) (local $e i32) (local $end i32)
  (local.set $m (i32.add (local.get $r) (i32.const 124)))
  (if (i32.eqz (i32.load (local.get $m))) (then (return)))
  (local.set $e (i32.load (local.get $m)))
  (local.set $end (i32.add (local.get $e) (i32.shl (i32.load offset=4 (local.get $m)) (i32.const 4))))
  (loop $l (if (i32.lt_u (local.get $e) (local.get $end)) (then
    (if (i32.load offset=12 (local.get $e)) (then (call $free (i32.load offset=4 (local.get $e)) (i32.load offset=8 (local.get $e)))))
    (local.set $e (i32.add (local.get $e) (i32.const 16)))
    (br $l))))
  (call $smap_clear (local.get $m)))

;; Empty lookup k (its values freed), keeping its room.
(func $jr_table_clear (param $r i32) (param $k i32)
  (local $t i32) (local $e i32) (local $end i32)
  (local.set $t (i32.add (local.get $r) (i32.add (i32.const 48) (i32.shl (local.get $k) (i32.const 3)))))
  (if (i32.eqz (i32.load (local.get $t))) (then (return)))
  (local.set $e (i32.load (local.get $t)))
  (local.set $end (i32.add (local.get $e) (i32.mul (i32.load offset=4 (local.get $t)) (i32.const 24))))
  (loop $l (if (i32.lt_u (local.get $e) (local.get $end)) (then
    (if (i32.load offset=8 (local.get $e)) (then (call $free (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))))
    (local.set $e (i32.add (local.get $e) (i32.const 24)))
    (br $l))))
  (memory.fill (i32.load (local.get $t)) (i32.const 0) (i32.mul (i32.load offset=4 (local.get $t)) (i32.const 24))))

(func $jr_free (param $r i32)
  (local $k i32)
  (loop $tables
    (call $jr_table_clear (local.get $r) (local.get $k))
    (if (i32.load offset=48 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 3)))) (then
      (call $free (i32.load offset=48 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 3))))
                  (i32.mul (i32.load offset=52 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 3)))) (i32.const 24)))))
    (br_if $tables (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 3))))
  (call $jr_blanks_clear (local.get $r))
  (if (i32.load offset=40 (local.get $r)) (then (call $free (i32.load offset=40 (local.get $r)) (i32.load offset=44 (local.get $r)))))
  (call $v_free (i32.load offset=136 (local.get $r)))
  (call $free (local.get $r) (i32.const 144)))

(func $jr_end_message (param $r i32) (param $at i32)
  (call $v_push1 (i32.load offset=136 (local.get $r)) (local.get $at))
  (i32.store offset=120 (local.get $r) (i32.const 0))
  (i32.store offset=116 (local.get $r) (i32.add (i32.load offset=116 (local.get $r)) (i32.const 1)))
  (call $jr_blanks_clear (local.get $r)))

;; The statements the reader has read so far in this frame (load.wat's quad buffer).
(func $jr_at (result i32) (i32.shr_u (global.get $qb_len) (i32.const 4)))

;; --- stream options

(func $jr_options (param $r i32) (param $p i32) (param $n i32) (param $at i32)
  (local $f i32) (local $physical i32) (local $st i32) (local $rv i32) (local $m0 i32) (local $m1 i32) (local $m2 i32)
  (local $version i32) (local $gen i32) (local $sp i32) (local $se i32) (local $k i32)
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $p)) (global.set $je (i32.add (local.get $p) (local.get $n)))
  (block $done
    (loop $fields
      (br_if $done (i32.ge_u (global.get $jp) (global.get $je)))
      (local.set $f (call $jtag))
      (br_if $done (global.get $jbad))
      (block $field
        (if (i32.and (i32.eq (local.get $f) (i32.const 1)) (i32.eq (global.get $jw) (i32.const 2))) (then (drop (call $jstr)) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 2)) (then (local.set $physical (call $juint (global.get $jw))) (br $field)))
        (if (i32.or (i32.or (i32.eq (local.get $f) (i32.const 3)) (i32.eq (local.get $f) (i32.const 4))) (i32.eq (local.get $f) (i32.const 14)))
          (then (local.set $gen (i32.or (local.get $gen) (i32.ne (call $juint (global.get $jw)) (i32.const 0)))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 5)) (then (local.set $st (call $juint (global.get $jw))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 6)) (then (local.set $rv (call $juint (global.get $jw))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 9)) (then (local.set $m0 (call $juint (global.get $jw))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 10)) (then (local.set $m1 (call $juint (global.get $jw))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 11)) (then (local.set $m2 (call $juint (global.get $jw))) (br $field)))
        (if (i32.eq (local.get $f) (i32.const 15)) (then (local.set $version (call $juint (global.get $jw))) (br $field)))
        (call $jskip (global.get $jw)))
      (br_if $fields (i32.eqz (global.get $jbad)))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return)))
  (if (i32.eqz (local.get $version)) (then (drop (call $jerr (@str "version tag 0"))) (return)))
  (if (i32.gt_u (local.get $version) (i32.const 3)) (then (drop (call $jerr (@str "a version tag newer than this reader"))) (return)))
  (if (i32.load offset=12 (local.get $r)) (then
    (if (i32.ne (i32.lt_u (i32.load offset=36 (local.get $r)) (i32.const 3)) (i32.lt_u (local.get $version) (i32.const 3)))
      (then (drop (call $jerr (@str "a stream mixes Jelly-RDF 1.2 with 1.0/1.1"))) (return)))))
  (if (i32.or (i32.or (i32.gt_u (local.get $m0) (i32.const J_MAX_NAMES)) (i32.gt_u (local.get $m1) (i32.const J_MAX_PREFIXES)))
              (i32.gt_u (local.get $m2) (i32.const J_MAX_DATATYPES)))
    (then (drop (call $jerr (@str "a lookup larger than the limit"))) (return)))
  (if (i32.lt_u (local.get $version) (i32.const 3)) (then
    (if (i32.load offset=12 (local.get $r)) (then
      (if (i32.and (i32.eq (i32.load offset=44 (local.get $r)) (local.get $n)) (call $memeq (i32.load offset=40 (local.get $r)) (local.get $p) (local.get $n)))
        (then (return)))
      (drop (call $jerr (@str "the stream options differ from the first ones")))
      (return)))
    (if (i32.gt_u (i32.sub (local.get $physical) (i32.const 1)) (i32.const 2)) (then (drop (call $jerr (@str "an unknown physical stream type"))) (return)))
    (if (i32.lt_u (local.get $m0) (i32.const 8)) (then (drop (call $jerr (@str "a name lookup smaller than 8"))) (return)))
    (i32.store offset=40 (local.get $r) (local.tee $k (call $alloc (local.get $n))))
    (memory.copy (local.get $k) (local.get $p) (local.get $n))
    (i32.store offset=44 (local.get $r) (local.get $n))
    (call $jr_set_options (local.get $r) (local.get $physical) (i32.const 0) (local.get $m0) (local.get $m1) (local.get $m2) (local.get $version))
    (return)))
  (if (local.get $gen) (then (drop (call $jerr (@str "a Jelly-RDF 1.0/1.1 stream option in a 1.2 stream"))) (return)))
  (if (i32.gt_u (i32.sub (local.get $physical) (i32.const 1)) (i32.const 1)) (then (drop (call $jerr (@str "an unknown physical stream type"))) (return)))
  (if (i32.gt_u (local.get $st) (i32.const 1)) (then (drop (call $jerr (@str "an unknown stream type"))) (return)))
  (if (i32.gt_u (local.get $rv) (i32.const 3)) (then (drop (call $jerr (@str "an unknown RDF version"))) (return)))
  (if (i32.lt_u (local.get $m0) (i32.const 128)) (then (drop (call $jerr (@str "a name lookup smaller than 128"))) (return)))
  (if (i32.load offset=12 (local.get $r)) (then
    (if (i32.ne (i32.load offset=16 (local.get $r)) (local.get $physical))
      (then (drop (call $jerr (@str "the restated stream options change the physical type"))) (return)))
    (if (i32.ne (i32.load offset=20 (local.get $r)) (local.get $st))
      (then (drop (call $jerr (@str "the restated stream options change the stream type"))) (return)))
    (call $jr_table_clear (local.get $r) (i32.const 0))
    (call $jr_table_clear (local.get $r) (i32.const 1))
    (call $jr_table_clear (local.get $r) (i32.const 2))
    (i32.store offset=76 (local.get $r) (i32.const 0))
    (i32.store offset=80 (local.get $r) (i32.const 0))
    (i32.store offset=84 (local.get $r) (i32.const 0))
    (if (i32.and (i32.eq (local.get $st) (i32.const 1)) (i32.ne (i32.load offset=120 (local.get $r)) (i32.const 0)))
      (then (call $jr_end_message (local.get $r) (local.get $at))))))
  (call $jr_set_options (local.get $r) (local.get $physical) (local.get $st) (local.get $m0) (local.get $m1) (local.get $m2) (local.get $version)))

(func $jr_set_options (param $r i32) (param $physical i32) (param $st i32) (param $m0 i32) (param $m1 i32) (param $m2 i32) (param $version i32)
  (i32.store offset=12 (local.get $r) (i32.const 1))
  (i32.store offset=16 (local.get $r) (local.get $physical))
  (i32.store offset=20 (local.get $r) (local.get $st))
  (i32.store offset=24 (local.get $r) (local.get $m0))
  (i32.store offset=28 (local.get $r) (local.get $m1))
  (i32.store offset=32 (local.get $r) (local.get $m2))
  (i32.store offset=36 (local.get $r) (local.get $version)))

;; --- lookups

;; Set entries id, id+1, ... of lookup k to the values (start, end) pairs of vector v from index i0, n of them.
(func $jr_entries (param $r i32) (param $k i32) (param $id i32) (param $v i32) (param $i0 i32) (param $n i32)
  (local $max i32) (local $t i32) (local $cap i32) (local $need i32) (local $e i32) (local $s i32) (local $len i32) (local $i i32) (local $q i32)
  (local.set $max (i32.load offset=24 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 2)))))
  (if (i32.eqz (local.get $id)) (then (local.set $id (i32.add (i32.load offset=76 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 2)))) (i32.const 1)))))
  (if (i32.eqz (local.get $max)) (then
    (drop (call $jerr_lookup (local.get $k) (i32.const 0)))
    (return)))
  (if (i64.gt_u (i64.sub (i64.add (i64.extend_i32_u (local.get $id)) (i64.extend_i32_u (local.get $n))) (i64.const 1)) (i64.extend_i32_u (local.get $max))) (then
    (drop (call $jerr (@str "a lookup entry outside the lookup")))
    (return)))
  (local.set $t (i32.add (local.get $r) (i32.add (i32.const 48) (i32.shl (local.get $k) (i32.const 3)))))
  (local.set $need (i32.add (local.get $id) (local.get $n)))
  (local.set $cap (i32.load offset=4 (local.get $t)))
  (if (i32.lt_u (local.get $cap) (local.get $need)) (then
    (local.set $cap (select (local.get $cap) (i32.const 16) (local.get $cap)))
    (loop $grow (if (i32.lt_u (local.get $cap) (local.get $need)) (then (local.set $cap (i32.shl (local.get $cap) (i32.const 1))) (br $grow))))
    (local.set $e (call $alloc0 (i32.mul (local.get $cap) (i32.const 24))))
    (if (i32.load (local.get $t)) (then
      (memory.copy (local.get $e) (i32.load (local.get $t)) (i32.mul (i32.load offset=4 (local.get $t)) (i32.const 24)))
      (call $free (i32.load (local.get $t)) (i32.mul (i32.load offset=4 (local.get $t)) (i32.const 24)))))
    (i32.store (local.get $t) (local.get $e))
    (i32.store offset=4 (local.get $t) (local.get $cap))))
  (loop $each (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (local.set $e (i32.add (i32.load (local.get $t)) (i32.mul (local.get $id) (i32.const 24))))
    (if (i32.load offset=8 (local.get $e)) (then (call $free (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))))
    (local.set $s (call $v_at (local.get $v) (i32.add (local.get $i0) (i32.shl (local.get $i) (i32.const 1)))))
    (local.set $len (i32.sub (call $v_at (local.get $v) (i32.add (i32.add (local.get $i0) (i32.shl (local.get $i) (i32.const 1))) (i32.const 1))) (local.get $s)))
    (i32.store (local.get $e) (local.tee $q (call $alloc (local.get $len))))
    (memory.copy (local.get $q) (local.get $s) (local.get $len))
    (i32.store offset=4 (local.get $e) (local.get $len))
    (i32.store offset=8 (local.get $e) (i32.const 1))
    (i32.store offset=72 (local.get $r) (i32.add (i32.load offset=72 (local.get $r)) (i32.const 1)))
    (i32.store offset=12 (local.get $e) (i32.load offset=72 (local.get $r)))
    (i32.store offset=20 (local.get $e) (i32.const 0))
    (local.set $id (i32.add (local.get $id) (i32.const 1)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $each))))
  (i32.store offset=76 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 2))) (i32.sub (local.get $id) (i32.const 1))))

;; Entry id of lookup k, checked to be in range and set; 0 (and the error) otherwise.
(func $jr_entry (param $r i32) (param $k i32) (param $id i32) (result i32)
  (local $e i32)
  (if (i32.or (i32.eqz (local.get $id)) (i32.gt_u (local.get $id) (i32.load offset=24 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 2)))))) (then
    (return (call $jerr_lookup (local.get $k) (i32.const 1)))))
  (if (i32.lt_u (local.get $id) (i32.load offset=52 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 3))))) (then
    (local.set $e (i32.add (i32.load offset=48 (i32.add (local.get $r) (i32.shl (local.get $k) (i32.const 3)))) (i32.mul (local.get $id) (i32.const 24))))
    (if (i32.load offset=8 (local.get $e)) (then (return (local.get $e))))))
  (call $jerr_lookup (local.get $k) (i32.const 2)))

;; A lookup error: `which` 0 an entry with the lookup disabled, 1 an identifier outside it, 2 one not defined.
(func $jerr_lookup (param $k i32) (param $which i32) (result i32)
  (if (i32.eqz (local.get $which)) (then
    (if (i32.eqz (local.get $k)) (then (return (call $jerr0 (@str "a name entry, with that lookup disabled")))))
    (if (i32.eq (local.get $k) (i32.const 1)) (then (return (call $jerr0 (@str "a prefix entry, with that lookup disabled")))))
    (return (call $jerr0 (@str "a datatype entry, with that lookup disabled")))))
  (if (i32.eq (local.get $which) (i32.const 1)) (then
    (if (i32.eqz (local.get $k)) (then (return (call $jerr0 (@str "name outside the lookup")))))
    (if (i32.eq (local.get $k) (i32.const 1)) (then (return (call $jerr0 (@str "prefix outside the lookup")))))
    (return (call $jerr0 (@str "datatype outside the lookup")))))
  (if (i32.eqz (local.get $k)) (then (return (call $jerr0 (@str "name not defined")))))
  (if (i32.eq (local.get $k) (i32.const 1)) (then (return (call $jerr0 (@str "prefix not defined")))))
  (call $jerr0 (@str "datatype not defined")))

;; The IRI prefix + name (prefix 0: none), from the name's cache when it still holds.
(func $jr_iri (param $r i32) (param $prefix i32) (param $name i32) (result i32)
  (local $pe i32) (local $ne i32) (local $stamp i32) (local $pn i32) (local $n i32) (local $id i32)
  (if (local.get $prefix) (then
    (if (i32.eqz (local.tee $pe (call $jr_entry (local.get $r) (i32.const 1) (local.get $prefix)))) (then (return (i32.const 0))))
    (local.set $stamp (i32.load offset=12 (local.get $pe)))))
  (if (i32.eqz (local.tee $ne (call $jr_entry (local.get $r) (i32.const 0) (local.get $name)))) (then (return (i32.const 0))))
  (if (i32.and (i32.ne (local.tee $id (i32.load offset=20 (local.get $ne))) (i32.const 0))
               (i32.and (i32.eq (i32.load offset=16 (local.get $ne)) (local.get $prefix)) (i32.eq (i32.load offset=12 (local.get $ne)) (local.get $stamp))))
    (then (return (local.get $id))))
  (if (local.get $pe) (then (local.set $pn (i32.load offset=4 (local.get $pe)))))
  (local.set $n (i32.add (local.get $pn) (i32.load offset=4 (local.get $ne))))
  (call $jbuf_room (local.get $n))
  (if (local.get $pn) (then (memory.copy (global.get $jbuf) (i32.load (local.get $pe)) (local.get $pn))))
  (memory.copy (i32.add (global.get $jbuf) (local.get $pn)) (i32.load (local.get $ne)) (i32.load offset=4 (local.get $ne)))
  (local.set $id (call $intern (i32.const 1) (global.get $jbuf) (local.get $n) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
  (i32.store offset=12 (local.get $ne) (local.get $stamp))
  (i32.store offset=16 (local.get $ne) (local.get $prefix))
  (i32.store offset=20 (local.get $ne) (local.get $id))
  (local.get $id))

(func $jr_datatype (param $r i32) (param $id i32) (result i32)
  (local $e i32) (local $t i32)
  (if (i32.eqz (local.tee $e (call $jr_entry (local.get $r) (i32.const 2) (local.get $id)))) (then (return (i32.const 0))))
  (if (local.tee $t (i32.load offset=20 (local.get $e))) (then (return (local.get $t))))
  (local.set $t (call $intern (i32.const 1) (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
  (if (i32.or (i32.eq (local.get $t) (i32.const 3)) (i32.eq (local.get $t) (i32.const 4))) (then
    (return (call $jerr0 (@str "rdf:langString or rdf:dirLangString as a datatype")))))
  (i32.store offset=20 (local.get $e) (local.get $t))
  (local.get $t))

(func $jr_lang_literal (param $lex i32) (param $n i32) (param $tag i32) (param $tn i32) (param $dir i32) (result i32)
  (if (i32.gt_u (local.get $dir) (i32.const 2)) (then (return (call $jerr0 (@str "an unknown base direction")))))
  (call $lower (local.get $tag) (local.get $tn))
  (call $intern (i32.or (i32.const 3) (i32.shl (local.get $dir) (i32.const 8))) (local.get $lex) (local.get $n)
                (select (i32.const 4) (i32.const 3) (local.get $dir)) (local.get $tag) (local.get $tn) (i32.const 1)))

;; The reader's blank node for a label, in its current scope.
(func $jr_blank (param $r i32) (param $p i32) (param $n i32) (result i32)
  (local $m i32) (local $e i32) (local $id i32) (local $q i32)
  (local.set $m (i32.add (local.get $r) (i32.const 124)))
  (if (local.tee $id (i32.load offset=12 (local.tee $e (call $smap_find (local.get $m) (local.get $p) (local.get $n)))))
    (then (return (local.get $id))))
  (local.set $id (call $fresh_bnode))
  (memory.copy (local.tee $q (call $alloc (local.get $n))) (local.get $p) (local.get $n))
  (call $smap_set (local.get $m) (local.get $e) (local.get $q) (local.get $n) (local.get $id))
  (local.get $id))

;; An RdfIri message [s, e) in the IRI sequence at seq (prefix, name words).
(func $jr_rdf_iri (param $r i32) (param $s i32) (param $e i32) (param $seq i32) (result i32)
  (local $f i32) (local $prefix i32) (local $name i32) (local $sp i32) (local $se i32)
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (if (i32.eqz (global.get $jbad)) (then
      (if (i32.eq (local.get $f) (i32.const 1)) (then (local.set $prefix (call $juint (global.get $jw))))
        (else (if (i32.eq (local.get $f) (i32.const 2)) (then (local.set $name (call $juint (global.get $jw))))
          (else (call $jskip (global.get $jw))))))))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return (i32.const 0))))
  (if (local.get $prefix) (then (i32.store (local.get $seq) (local.get $prefix))) (else (local.set $prefix (i32.load (local.get $seq)))))
  (if (i32.eqz (local.get $name)) (then
    (local.set $name (i32.add (i32.load offset=4 (local.get $seq)) (i32.const 1)))
    (if (i32.eqz (local.get $name)) (then (local.set $name (i32.const -1))))))
  (i32.store offset=4 (local.get $seq) (local.get $name))
  (call $jr_iri (local.get $r) (local.get $prefix) (local.get $name)))

;; An RdfLiteral message [s, e).
(func $jr_rdf_literal (param $r i32) (param $s i32) (param $e i32) (result i32)
  (local $f i32) (local $ls i32) (local $le i32) (local $ts i32) (local $te i32) (local $lang i32) (local $dt i32) (local $hasdt i32)
  (local $dir i32) (local $sp i32) (local $se i32)
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (if (i32.and (i32.eq (local.get $f) (i32.const 1)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jstr) (then (local.set $ls (global.get $js)) (local.set $le (global.get $jl))))
        (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 2)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jstr) (then (local.set $ts (global.get $js)) (local.set $te (global.get $jl))))
        (local.set $lang (i32.const 1)) (local.set $hasdt (i32.const 0))
        (br $field)))
      (if (i32.eq (local.get $f) (i32.const 3)) (then
        (local.set $dt (call $juint (global.get $jw)))
        (local.set $hasdt (i32.const 1)) (local.set $lang (i32.const 0))
        (br $field)))
      (if (i32.eq (local.get $f) (i32.const 4)) (then (local.set $dir (call $juint (global.get $jw))) (br $field)))
      (call $jskip (global.get $jw)))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return (i32.const 0))))
  (if (i32.and (i32.ne (local.get $dir) (i32.const 0)) (i32.eqz (local.get $lang)))
    (then (return (call $jerr0 (@str "a base direction without a language tag")))))
  (if (local.get $lang) (then
    (if (i32.lt_u (i32.load offset=36 (local.get $r)) (i32.const 3)) (then (local.set $dir (i32.const 0))))
    (return (call $jr_lang_literal (local.get $ls) (i32.sub (local.get $le) (local.get $ls)) (local.get $ts) (i32.sub (local.get $te) (local.get $ts)) (local.get $dir)))))
  (if (i32.eqz (local.get $hasdt)) (then
    (return (call $intern (i32.const 3) (local.get $ls) (i32.sub (local.get $le) (local.get $ls)) (i32.const 2) (i32.const 0) (i32.const 0) (i32.const 1)))))
  (if (i32.eqz (local.get $dt)) (then (return (call $jerr0 (@str "datatype 0")))))
  (if (i32.eqz (local.tee $dt (call $jr_datatype (local.get $r) (local.get $dt)))) (then (return (i32.const 0))))
  (call $intern (i32.const 3) (local.get $ls) (i32.sub (local.get $le) (local.get $ls)) (local.get $dt) (i32.const 0) (i32.const 0) (i32.const 1)))

;; --- the row layout (1.0 and 1.1)

(func $jr_namespace (param $r i32) (param $s i32) (param $e i32) (param $seq i32)
  (local $f i32) (local $iri i32) (local $sp i32) (local $se i32)
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (if (i32.and (i32.eq (local.get $f) (i32.const 1)) (i32.eq (global.get $jw) (i32.const 2))) (then (drop (call $jstr)) (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 2)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jlen) (then
          (drop (call $jr_rdf_iri (local.get $r) (global.get $js) (global.get $jl) (local.get $seq)))
          (local.set $iri (i32.const 1))))
        (br $field)))
      (call $jskip (global.get $jw)))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (i32.and (i32.eqz (global.get $jbad)) (i32.eqz (local.get $iri)))
    (then (drop (call $jerr (@str "a namespace declaration without an IRI"))))))

;; A blank node label field [s, e): checked to be UTF-8.
(func $jr_label (param $r i32) (param $s i32) (param $e i32) (result i32)
  (if (i32.eqz (call $utf8_ok (local.get $s) (i32.sub (local.get $e) (local.get $s)))) (then (return (call $jerr0 (@str "invalid UTF-8")))))
  (call $jr_blank (local.get $r) (local.get $s) (i32.sub (local.get $e) (local.get $s))))

;; The terms of an RdfTriple (n 3) or RdfQuad (n 4) [s, e), into $jterms at the nesting level: 0 where not set.
(func $jr_terms (param $r i32) (param $s i32) (param $e i32) (param $n i32) (param $depth i32)
  (local $f i32) (local $pos i32) (local $kind i32) (local $id i32) (local $ms i32) (local $me i32) (local $out i32) (local $q i32)
  (local $sp i32) (local $se i32)
  (local.set $out (i32.add (global.get $jterms) (i32.shl (local.get $depth) (i32.const 4))))
  (memory.fill (local.get $out) (i32.const 0) (i32.const 16))
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (if (i32.or (i32.ne (global.get $jw) (i32.const 2)) (i32.gt_u (local.get $f) (i32.shl (local.get $n) (i32.const 2)))) (then
        (call $jskip (global.get $jw))
        (br $field)))
      (br_if $field (i32.eqz (call $jlen)))
      (local.set $ms (global.get $js)) (local.set $me (global.get $jl))
      (local.set $pos (i32.shr_u (i32.sub (local.get $f) (i32.const 1)) (i32.const 2)))
      (local.set $kind (i32.and (i32.sub (local.get $f) (i32.const 1)) (i32.const 3)))
      (if (i32.eq (local.get $pos) (i32.const 3)) (then
        (if (i32.eqz (local.get $kind)) (then (local.set $id (call $jr_rdf_iri (local.get $r) (local.get $ms) (local.get $me) (i32.add (local.get $r) (i32.const 88))))))
        (if (i32.eq (local.get $kind) (i32.const 1)) (then (local.set $id (call $jr_label (local.get $r) (local.get $ms) (local.get $me)))))
        (if (i32.eq (local.get $kind) (i32.const 2)) (then (local.set $id (i32.load offset=4 (local.get $r)))))
        (if (i32.eq (local.get $kind) (i32.const 3)) (then
          (drop (call $jerr (@str "a literal graph name (generalized RDF is not supported)")))
          (br $field)))
        (i32.store offset=12 (local.get $out) (local.get $id))
        (br $field)))
      (block $term
        (if (i32.eqz (local.get $kind)) (then (local.set $id (call $jr_rdf_iri (local.get $r) (local.get $ms) (local.get $me) (i32.add (local.get $r) (i32.const 88)))) (br $term)))
        (if (i32.eq (local.get $kind) (i32.const 1)) (then (local.set $id (call $jr_label (local.get $r) (local.get $ms) (local.get $me))) (br $term)))
        (if (i32.eq (local.get $kind) (i32.const 2)) (then (local.set $id (call $jr_rdf_literal (local.get $r) (local.get $ms) (local.get $me))) (br $term)))
        (if (i32.ge_u (local.get $depth) (i32.const J_MAX_DEPTH)) (then (drop (call $jerr (@str "quoted triples nest too deep"))) (br $field)))
        (call $jr_terms (local.get $r) (local.get $ms) (local.get $me) (i32.const 3) (i32.add (local.get $depth) (i32.const 1)))
        (br_if $field (global.get $jbad))
        (local.set $q (i32.add (local.get $out) (i32.const 16)))
        (if (i32.or (i32.or (i32.eqz (i32.load (local.get $q))) (i32.eqz (i32.load offset=4 (local.get $q)))) (i32.eqz (i32.load offset=8 (local.get $q))))
          (then (drop (call $jerr (@str "a quoted triple with a repeated term"))) (br $field)))
        (local.set $id (call $intern_triple (i32.load (local.get $q)) (i32.load offset=4 (local.get $q)) (i32.load offset=8 (local.get $q)) (i32.const 1))))
      (br_if $field (global.get $jbad))
      (if (i32.and (i32.eqz (local.get $pos)) (i32.eq (local.get $kind) (i32.const 2)))
        (then (drop (call $jerr (@str "a literal subject (generalized RDF is not supported)"))) (br $field)))
      (if (i32.and (i32.eq (local.get $pos) (i32.const 1)) (i32.ne (local.get $kind) (i32.const 0)))
        (then (drop (call $jerr (@str "a predicate that is not an IRI (generalized RDF is not supported)"))) (br $field)))
      (i32.store (i32.add (local.get $out) (i32.shl (local.get $pos) (i32.const 2))) (local.get $id)))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se)))

;; A statement: its terms, the ones not set repeated from the previous statement.
(func $jr_statement (param $r i32) (param $s i32) (param $e i32) (param $n i32)
  (local $i i32) (local $t i32) (local $last i32)
  (call $jr_terms (local.get $r) (local.get $s) (local.get $e) (local.get $n) (i32.const 0))
  (if (global.get $jbad) (then (return)))
  (loop $each
    (local.set $t (i32.add (global.get $jterms) (i32.shl (local.get $i) (i32.const 2))))
    (local.set $last (i32.add (i32.add (local.get $r) (i32.const 96)) (i32.shl (local.get $i) (i32.const 2))))
    (if (i32.load (local.get $t))
      (then (i32.store (local.get $last) (i32.load (local.get $t))))
      (else
        (if (i32.eqz (i32.load (local.get $last))) (then (drop (call $jerr (@str "a repeated term in the first statement"))) (return)))
        (i32.store (local.get $t) (i32.load (local.get $last)))))
    (br_if $each (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))

(func $jr_row (param $r i32) (param $s i32) (param $e i32)
  (local $f i32) (local $fields i32) (local $ms i32) (local $me i32) (local $physical i32) (local $g i32) (local $id i32) (local $vs i32) (local $ve i32)
  (local $sp i32) (local $se i32) (local $f2 i32)
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (block $done
    (loop $fields
      (br_if $done (i32.or (i32.ge_u (global.get $jp) (global.get $je)) (global.get $jbad)))
      (local.set $f (call $jtag))
      (br_if $done (global.get $jbad))
      (local.set $fields (i32.add (local.get $fields) (i32.const 1)))
      (if (i32.ne (global.get $jw) (i32.const 2)) (then (drop (call $jerr (@str "a row field that is not a message"))) (br $done)))
      (br_if $done (i32.eqz (call $jlen)))
      (local.set $ms (global.get $js)) (local.set $me (global.get $jl))
      (block $row
        (if (i32.eq (local.get $f) (i32.const 1)) (then
          (call $jr_options (local.get $r) (local.get $ms) (i32.sub (local.get $me) (local.get $ms)) (call $jr_at))
          (br $row)))
        (if (i32.eqz (i32.load offset=12 (local.get $r))) (then (drop (call $jerr (@str "a row before the stream options"))) (br $done)))
        (local.set $physical (i32.load offset=16 (local.get $r)))
        (if (i32.eq (local.get $f) (i32.const 2)) (then
          (if (i32.eq (local.get $physical) (i32.const 2)) (then (drop (call $jerr (@str "a triple in a stream of quads"))) (br $done)))
          (if (i32.and (i32.eq (local.get $physical) (i32.const 3)) (i32.eqz (i32.load offset=112 (local.get $r))))
            (then (drop (call $jerr (@str "a triple outside a graph"))) (br $done)))
          (call $jr_statement (local.get $r) (local.get $ms) (local.get $me) (i32.const 3))
          (br_if $done (global.get $jbad))
          (call $push_quad (i32.load (global.get $jterms)) (i32.load offset=4 (global.get $jterms)) (i32.load offset=8 (global.get $jterms))
            (select (i32.load offset=112 (local.get $r)) (i32.load offset=4 (local.get $r)) (i32.eq (local.get $physical) (i32.const 3))))
          (br $row)))
        (if (i32.eq (local.get $f) (i32.const 3)) (then
          (if (i32.ne (local.get $physical) (i32.const 2)) (then (drop (call $jerr (@str "a quad in a stream that is not of quads"))) (br $done)))
          (call $jr_statement (local.get $r) (local.get $ms) (local.get $me) (i32.const 4))
          (br_if $done (global.get $jbad))
          (call $push_quad (i32.load (global.get $jterms)) (i32.load offset=4 (global.get $jterms)) (i32.load offset=8 (global.get $jterms)) (i32.load offset=12 (global.get $jterms)))
          (br $row)))
        (if (i32.eq (local.get $f) (i32.const 4)) (then
          (if (i32.ne (local.get $physical) (i32.const 3)) (then (drop (call $jerr (@str "a graph start in a stream that is not of graphs"))) (br $done)))
          (if (i32.load offset=112 (local.get $r)) (then (drop (call $jerr (@str "a graph start inside a graph"))) (br $done)))
          (local.set $g (i32.const 0))
          (global.set $jp (local.get $ms)) (global.set $je (local.get $me))
          (loop $gfields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
            (local.set $f2 (call $jtag))
            (block $gf
              (br_if $gf (global.get $jbad))
              (if (i32.ne (global.get $jw) (i32.const 2)) (then (call $jskip (global.get $jw)) (br $gf)))
              (br_if $gf (i32.eqz (call $jlen)))
              (if (i32.eq (local.get $f2) (i32.const 1)) (then (local.set $g (call $jr_rdf_iri (local.get $r) (global.get $js) (global.get $jl) (i32.add (local.get $r) (i32.const 88)))) (br $gf)))
              (if (i32.eq (local.get $f2) (i32.const 2)) (then (local.set $g (call $jr_label (local.get $r) (global.get $js) (global.get $jl))) (br $gf)))
              (if (i32.eq (local.get $f2) (i32.const 3)) (then (local.set $g (i32.load offset=4 (local.get $r))) (br $gf)))
              (if (i32.eq (local.get $f2) (i32.const 4)) (then (drop (call $jerr (@str "a literal graph name (generalized RDF is not supported)"))))))
            (br $gfields))))
          (global.set $jp (local.get $me)) (global.set $je (local.get $e))
          (br_if $done (global.get $jbad))
          (if (i32.eqz (local.get $g)) (then (drop (call $jerr (@str "a graph start without a graph"))) (br $done)))
          (i32.store offset=112 (local.get $r) (local.get $g))
          (br $row)))
        (if (i32.eq (local.get $f) (i32.const 5)) (then
          (if (i32.ne (local.get $physical) (i32.const 3)) (then (drop (call $jerr (@str "a graph end in a stream that is not of graphs"))) (br $done)))
          (i32.store offset=112 (local.get $r) (i32.const 0))
          (br $row)))
        (if (i32.eq (local.get $f) (i32.const 6)) (then
          (call $jr_namespace (local.get $r) (local.get $ms) (local.get $me) (i32.add (local.get $r) (i32.const 88)))
          (br $row)))
        (if (i32.lt_u (i32.sub (local.get $f) (i32.const 9)) (i32.const 3)) (then
          (local.set $id (i32.const 0)) (local.set $vs (i32.const 0)) (local.set $ve (i32.const 0))
          (global.set $jp (local.get $ms)) (global.set $je (local.get $me))
          (loop $efields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
            (local.set $f2 (call $jtag))
            (block $ef
              (br_if $ef (global.get $jbad))
              (if (i32.eq (local.get $f2) (i32.const 1)) (then (local.set $id (call $juint (global.get $jw))) (br $ef)))
              (if (i32.and (i32.eq (local.get $f2) (i32.const 2)) (i32.eq (global.get $jw) (i32.const 2))) (then
                (if (call $jstr) (then (local.set $vs (global.get $js)) (local.set $ve (global.get $jl))))
                (br $ef)))
              (call $jskip (global.get $jw)))
            (br $efields))))
          (global.set $jp (local.get $me)) (global.set $je (local.get $e))
          (br_if $done (global.get $jbad))
          (call $v_clear (global.get $jentries))
          (call $v_push2 (global.get $jentries) (local.get $vs) (local.get $ve))
          (call $jr_entries (local.get $r) (i32.sub (local.get $f) (i32.const 9)) (local.get $id) (global.get $jentries) (i32.const 0) (i32.const 1))
          (br $row)))
        (drop (call $jerr (@str "an unknown row field")))
        (br $done))
      (br $fields)))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (i32.and (i32.eqz (global.get $jbad)) (i32.eqz (local.get $fields))) (then (drop (call $jerr (@str "an empty row"))))))

;; --- the column layout (1.2)

(global $jcols (mut i32) (i32.const 0))  ;; per column (12 bytes): start, end, cells (0: not set)

;; The term of run value i, in the current message's blank node scope.
(func $jr_value (param $r i32) (param $i i32) (result i32)
  (local $v i32) (local $id i32)
  (local.set $v (i32.add (i32.load (global.get $jvals)) (i32.mul (local.get $i) (i32.const 28))))
  (local.set $id (i32.load (local.get $v)))
  (if (i32.eqz (i32.load offset=4 (local.get $v))) (then (return (local.get $id))))
  (if (i32.and (i32.ne (local.get $id) (i32.const 0)) (i32.eq (i32.load offset=24 (local.get $v)) (i32.load offset=116 (local.get $r))))
    (then (return (local.get $id))))
  (if (i32.eq (i32.load offset=4 (local.get $v)) (i32.const 1))
    (then (local.set $id (call $jr_blank (local.get $r) (i32.load offset=8 (local.get $v)) (i32.sub (i32.load offset=12 (local.get $v)) (i32.load offset=8 (local.get $v))))))
    (else
      (i32.store offset=16 (global.get $jseq) (i32.load offset=16 (local.get $v)))
      (i32.store offset=20 (global.get $jseq) (i32.load offset=20 (local.get $v)))
      (local.set $id (call $jr_tt (local.get $r) (i32.load offset=8 (local.get $v)) (i32.load offset=12 (local.get $v)) (i32.add (global.get $jseq) (i32.const 16)) (i32.const 0) (i32.const 1)))
      ;; the run values may have moved: no, $jvals is not pushed to here; reload anyway
      (local.set $v (i32.add (i32.load (global.get $jvals)) (i32.mul (local.get $i) (i32.const 28))))))
  (i32.store (local.get $v) (local.get $id))
  (i32.store offset=24 (local.get $v) (i32.load offset=116 (local.get $r)))
  (local.get $id))

;; An RdfTripleTerm [s, e) in the IRI sequence at seq. Unless resolve, one holding a blank node is
;; checked but not made: -1 (its blank nodes depend on the message it is in). 0 on an error.
(func $jr_tt (param $r i32) (param $s i32) (param $e i32) (param $seq i32) (param $depth i32) (param $resolve i32) (result i32)
  (local $f i32) (local $ms i32) (local $me i32) (local $x i32) (local $blank i32) (local $set i32)
  (local $i0 i32) (local $i1 i32) (local $i2 i32) (local $sp i32) (local $se i32)
  (if (i32.ge_u (local.get $depth) (i32.const J_MAX_DEPTH)) (then (return (call $jerr0 (@str "triple terms nest too deep")))))
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (if (i32.ne (global.get $jw) (i32.const 2)) (then (call $jskip (global.get $jw)) (br $field)))
      (br_if $field (i32.eqz (call $jlen)))
      (local.set $ms (global.get $js)) (local.set $me (global.get $jl))
      (if (i32.eq (local.get $f) (i32.const 1)) (then
        (local.set $i0 (call $jr_rdf_iri (local.get $r) (local.get $ms) (local.get $me) (local.get $seq)))
        (local.set $set (i32.or (local.get $set) (i32.const 1))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 2)) (then
        (if (i32.eqz (call $utf8_ok (local.get $ms) (i32.sub (local.get $me) (local.get $ms)))) (then (drop (call $jerr (@str "invalid UTF-8"))) (br $field)))
        (if (local.get $resolve)
          (then (local.set $i0 (call $jr_blank (local.get $r) (local.get $ms) (i32.sub (local.get $me) (local.get $ms)))))
          (else (local.set $i0 (i32.const 0)) (local.set $blank (i32.const 1))))
        (local.set $set (i32.or (local.get $set) (i32.const 1))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 5)) (then
        (local.set $i1 (call $jr_rdf_iri (local.get $r) (local.get $ms) (local.get $me) (local.get $seq)))
        (local.set $set (i32.or (local.get $set) (i32.const 2))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 9)) (then
        (local.set $i2 (call $jr_rdf_iri (local.get $r) (local.get $ms) (local.get $me) (local.get $seq)))
        (local.set $set (i32.or (local.get $set) (i32.const 4))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 10)) (then
        (if (i32.eqz (call $utf8_ok (local.get $ms) (i32.sub (local.get $me) (local.get $ms)))) (then (drop (call $jerr (@str "invalid UTF-8"))) (br $field)))
        (if (local.get $resolve)
          (then (local.set $i2 (call $jr_blank (local.get $r) (local.get $ms) (i32.sub (local.get $me) (local.get $ms)))))
          (else (local.set $i2 (i32.const 0)) (local.set $blank (i32.const 1))))
        (local.set $set (i32.or (local.get $set) (i32.const 4))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 11)) (then
        (local.set $i2 (call $jr_rdf_literal (local.get $r) (local.get $ms) (local.get $me)))
        (local.set $set (i32.or (local.get $set) (i32.const 4))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 12)) (then
        (local.set $x (call $jr_tt (local.get $r) (local.get $ms) (local.get $me) (local.get $seq) (i32.add (local.get $depth) (i32.const 1)) (local.get $resolve)))
        (if (i32.eq (local.get $x) (i32.const -1))
          (then (local.set $i2 (i32.const 0)) (local.set $blank (i32.const 1)))
          (else (local.set $i2 (local.get $x))))
        (local.set $set (i32.or (local.get $set) (i32.const 4))) (br $field))))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return (i32.const 0))))
  (if (i32.eqz (i32.and (local.get $set) (i32.const 1))) (then (return (call $jerr0 (@str "a triple term without a subject")))))
  (if (i32.eqz (i32.and (local.get $set) (i32.const 2))) (then (return (call $jerr0 (@str "a triple term without a predicate")))))
  (if (i32.eqz (i32.and (local.get $set) (i32.const 4))) (then (return (call $jerr0 (@str "a triple term without an object")))))
  (if (i32.and (local.get $blank) (i32.or (i32.or (i32.eqz (local.get $i0)) (i32.eqz (local.get $i1))) (i32.eqz (local.get $i2))))
    (then (return (i32.const -1))))
  (call $intern_triple (local.get $i0) (local.get $i1) (local.get $i2) (i32.const 1)))

;; Word i of vector v.
(func $vw (param $v i32) (param $i i32) (result i32) (call $v_at (local.get $v) (local.get $i)))

;; An RdfColumn [s, e) of position pos (0 subjects, 1 predicates, 2 objects, 3 graphs): its run
;; values onto $jvals, its cells (run value index + 1; 0 unbound) at cells.
(func $jr_column (param $r i32) (param $s i32) (param $e i32) (param $rows i32) (param $pos i32) (param $cells i32)
  (local $f i32) (local $ks i32) (local $ke i32) (local $kn i32) (local $m i32) (local $nN i32) (local $nL i32) (local $nB i32) (local $nT i32)
  (local $single i32) (local $lists i32) (local $i i32) (local $t i32) (local $k i32) (local $s0 i32) (local $s1 i32) (local $s2 i32) (local $s3 i32)
  (local $allowed i32) (local $base i32) (local $prevN i32) (local $prevP i32) (local $name i32) (local $prefix i32) (local $id i32) (local $dep i32)
  (local $a i32) (local $b i32) (local $q0 i32) (local $q1 i32) (local $kind i32) (local $np i32) (local $x i32) (local $nl i32) (local $token i32)
  (local $skip i32) (local $len i64) (local $at i32) (local $c i32) (local $sp i32) (local $se i32)
  (call $v_clear (global.get $jl_layouts)) (call $v_clear (global.get $jl_names)) (call $v_clear (global.get $jl_prefixes))
  (call $v_clear (global.get $jl_kinds)) (call $v_clear (global.get $jl_dirs)) (call $v_clear (global.get $jl_lex))
  (call $v_clear (global.get $jl_langs)) (call $v_clear (global.get $jl_bnodes)) (call $v_clear (global.get $jl_tts))
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (local.set $x (i32.eq (global.get $jw) (i32.const 2)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 1)) (local.get $x)) (then
        (if (call $jlen) (then (local.set $ks (global.get $js)) (local.set $ke (global.get $jl)))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 2)) (then (call $jpacked (global.get $jw) (global.get $jl_layouts)) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 3)) (then (call $jpacked (global.get $jw) (global.get $jl_names)) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 4)) (then (call $jpacked (global.get $jw) (global.get $jl_prefixes)) (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 5)) (local.get $x)) (then
        (if (call $jstr) (then (call $v_push2 (global.get $jl_lex) (global.get $js) (global.get $jl)))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 6)) (then (call $jpacked (global.get $jw) (global.get $jl_kinds)) (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 7)) (local.get $x)) (then
        (if (call $jstr) (then (call $v_push2 (global.get $jl_langs) (global.get $js) (global.get $jl)))) (br $field)))
      (if (i32.eq (local.get $f) (i32.const 8)) (then (call $jpacked (global.get $jw) (global.get $jl_dirs)) (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 9)) (local.get $x)) (then
        (if (call $jstr) (then (call $v_push2 (global.get $jl_bnodes) (global.get $js) (global.get $jl)))) (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 10)) (local.get $x)) (then
        (if (call $jlen) (then (call $v_push2 (global.get $jl_tts) (global.get $js) (global.get $jl)))) (br $field)))
      (call $jskip (global.get $jw)))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return)))
  (local.set $nN (call $v_len (global.get $jl_names)))
  (local.set $nL (i32.shr_u (call $v_len (global.get $jl_lex)) (i32.const 1)))
  (local.set $nB (i32.shr_u (call $v_len (global.get $jl_bnodes)) (i32.const 1)))
  (local.set $nT (i32.shr_u (call $v_len (global.get $jl_tts)) (i32.const 1)))
  (local.set $m (i32.add (i32.add (local.get $nN) (local.get $nL)) (i32.add (local.get $nB) (local.get $nT))))
  (local.set $kn (i32.sub (local.get $ke) (local.get $ks)))
  (local.set $single (i32.const -1))
  (if (i32.eqz (local.get $kn))
    (then
      (local.set $single (i32.const 0))
      (if (local.get $nN) (then (local.set $lists (i32.add (local.get $lists) (i32.const 1))) (local.set $single (i32.const 0))))
      (if (local.get $nL) (then (local.set $lists (i32.add (local.get $lists) (i32.const 1))) (local.set $single (i32.const 1))))
      (if (local.get $nB) (then (local.set $lists (i32.add (local.get $lists) (i32.const 1))) (local.set $single (i32.const 2))))
      (if (local.get $nT) (then (local.set $lists (i32.add (local.get $lists) (i32.const 1))) (local.set $single (i32.const 3))))
      (if (i32.gt_u (local.get $lists) (i32.const 1)) (then (drop (call $jerr (@str "a column of several term types without kinds"))) (return))))
    (else
      (if (i32.ne (local.get $kn) (i32.shr_u (i32.add (local.get $m) (i32.const 3)) (i32.const 2))) (then (drop (call $jerr (@str "kinds has the wrong length"))) (return)))
      (if (i32.and (i32.ne (i32.and (local.get $m) (i32.const 3)) (i32.const 0))
                   (i32.ne (i32.shr_u (i32.load8_u (i32.sub (local.get $ke) (i32.const 1))) (i32.shl (i32.and (local.get $m) (i32.const 3)) (i32.const 1))) (i32.const 0)))
        (then (drop (call $jerr (@str "unused bits of kinds are set"))) (return)))
      (local.set $i (i32.const 0))
      (loop $count (if (i32.lt_u (local.get $i) (local.get $m)) (then
        (local.set $t (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $ks) (i32.shr_u (local.get $i) (i32.const 2)))) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 1))) (i32.const 3)))
        (if (i32.eqz (local.get $t)) (then (local.set $s0 (i32.add (local.get $s0) (i32.const 1)))))
        (if (i32.eq (local.get $t) (i32.const 1)) (then (local.set $s1 (i32.add (local.get $s1) (i32.const 1)))))
        (if (i32.eq (local.get $t) (i32.const 2)) (then (local.set $s2 (i32.add (local.get $s2) (i32.const 1)))))
        (if (i32.eq (local.get $t) (i32.const 3)) (then (local.set $s3 (i32.add (local.get $s3) (i32.const 1)))))
        (if (i32.or (i32.or (i32.gt_u (local.get $s0) (local.get $nN)) (i32.gt_u (local.get $s1) (local.get $nL)))
                    (i32.or (i32.gt_u (local.get $s2) (local.get $nB)) (i32.gt_u (local.get $s3) (local.get $nT))))
          (then (drop (call $jerr (@str "kinds refers to more values of a type than the column has"))) (return)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $count))))))
  (local.set $np (call $v_len (global.get $jl_prefixes)))
  (if (i32.and (i32.gt_u (local.get $np) (i32.const 1)) (i32.ne (local.get $np) (local.get $nN))) (then (drop (call $jerr (@str "prefix_ids has the wrong length"))) (return)))
  (local.set $k (call $v_len (global.get $jl_kinds)))
  (if (i32.and (i32.gt_u (local.get $k) (i32.const 1)) (i32.ne (local.get $k) (local.get $nL))) (then (drop (call $jerr (@str "literal_kinds has the wrong length"))) (return)))
  (local.set $k (call $v_len (global.get $jl_dirs)))
  (if (i32.and (i32.ne (local.get $k) (i32.const 0)) (i32.ne (local.get $k) (i32.shr_u (call $v_len (global.get $jl_langs)) (i32.const 1))))
    (then (drop (call $jerr (@str "langtag_directions has the wrong length"))) (return)))
  (local.set $i (i32.const 0))
  (loop $dirs (if (i32.lt_u (local.get $i) (local.get $k)) (then
    (if (i32.gt_u (call $vw (global.get $jl_dirs) (local.get $i)) (i32.const 2)) (then (drop (call $jerr (@str "an unknown base direction"))) (return)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $dirs))))
  (local.set $allowed (select (i32.const 1) (select (i32.const 15) (i32.const 5) (i32.eq (local.get $pos) (i32.const 2))) (i32.eq (local.get $pos) (i32.const 1))))
  ;; the run values
  (local.set $base (i32.div_u (call $v_len (global.get $jvals)) (i32.const 7)))
  (local.set $s0 (i32.const 0)) (local.set $s1 (i32.const 0)) (local.set $s2 (i32.const 0)) (local.set $s3 (i32.const 0))
  (i64.store offset=8 (global.get $jseq) (i64.const 0))
  (local.set $i (i32.const 0))
  (loop $values (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $t (if (result i32) (i32.ge_s (local.get $single) (i32.const 0)) (then (local.get $single))
      (else (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $ks) (i32.shr_u (local.get $i) (i32.const 2)))) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 1))) (i32.const 3)))))
    (if (i32.eqz (i32.and (local.get $allowed) (i32.shl (i32.const 1) (local.get $t)))) (then (drop (call $jerr (@str "a term type the column does not allow"))) (return)))
    (local.set $id (i32.const 0)) (local.set $dep (i32.const 0)) (local.set $a (i32.const 0)) (local.set $b (i32.const 0)) (local.set $q0 (i32.const 0)) (local.set $q1 (i32.const 0))
    (block $value
      (if (i32.eqz (local.get $t)) (then
        (local.set $k (local.get $s0)) (local.set $s0 (i32.add (local.get $s0) (i32.const 1)))
        (local.set $name (call $vw (global.get $jl_names) (local.get $k)))
        (if (i32.eqz (local.get $name)) (then
          (local.set $name (i32.add (local.get $prevN) (i32.const 1)))
          (if (i32.eqz (local.get $name)) (then (local.set $name (i32.const -1))))))
        (local.set $prevN (local.get $name))
        (local.set $prefix (if (result i32) (i32.eqz (local.get $np)) (then (i32.const 0))
          (else (call $vw (global.get $jl_prefixes) (select (i32.const 0) (local.get $k) (i32.eq (local.get $np) (i32.const 1)))))))
        (if (i32.gt_u (local.get $np) (i32.const 1)) (then
          (if (i32.eqz (local.get $prefix)) (then (local.set $prefix (local.get $prevP))))
          (local.set $prevP (local.get $prefix))))
        (local.set $id (call $jr_iri (local.get $r) (local.get $prefix) (local.get $name)))
        (br $value)))
      (if (i32.eq (local.get $t) (i32.const 1)) (then
        (local.set $k (local.get $s1)) (local.set $s1 (i32.add (local.get $s1) (i32.const 1)))
        (local.set $c (call $v_len (global.get $jl_kinds)))
        (local.set $kind (if (result i32) (i32.eqz (local.get $c)) (then (i32.const 0))
          (else (call $vw (global.get $jl_kinds) (select (i32.const 0) (local.get $k) (i32.eq (local.get $c) (i32.const 1)))))))
        (local.set $a (call $vw (global.get $jl_lex) (i32.shl (local.get $k) (i32.const 1))))
        (local.set $b (i32.sub (call $vw (global.get $jl_lex) (i32.add (i32.shl (local.get $k) (i32.const 1)) (i32.const 1))) (local.get $a)))
        (if (i32.eqz (local.get $kind)) (then
          (local.set $id (call $intern (i32.const 3) (local.get $a) (local.get $b) (i32.const 2) (i32.const 0) (i32.const 0) (i32.const 1)))
          (local.set $a (i32.const 0)) (local.set $b (i32.const 0))
          (br $value)))
        (if (i32.and (local.get $kind) (i32.const 1)) (then
          (if (local.tee $c (call $jr_datatype (local.get $r) (i32.add (i32.shr_u (local.get $kind) (i32.const 1)) (i32.const 1))))
            (then (local.set $id (call $intern (i32.const 3) (local.get $a) (local.get $b) (local.get $c) (i32.const 0) (i32.const 0) (i32.const 1)))))
          (local.set $a (i32.const 0)) (local.set $b (i32.const 0))
          (br $value)))
        (local.set $c (i32.sub (i32.shr_u (local.get $kind) (i32.const 1)) (i32.const 1)))
        (if (i32.ge_u (local.get $c) (i32.shr_u (call $v_len (global.get $jl_langs)) (i32.const 1)))
          (then (drop (call $jerr (@str "a literal kind refers to a language tag past the end of langtags"))) (return)))
        (local.set $x (call $vw (global.get $jl_langs) (i32.shl (local.get $c) (i32.const 1))))
        (local.set $id (call $jr_lang_literal (local.get $a) (local.get $b) (local.get $x)
          (i32.sub (call $vw (global.get $jl_langs) (i32.add (i32.shl (local.get $c) (i32.const 1)) (i32.const 1))) (local.get $x))
          (if (result i32) (call $v_len (global.get $jl_dirs)) (then (call $vw (global.get $jl_dirs) (local.get $c))) (else (i32.const 0)))))
        (local.set $a (i32.const 0)) (local.set $b (i32.const 0))
        (br $value)))
      (if (i32.eq (local.get $t) (i32.const 2)) (then
        (local.set $k (local.get $s2)) (local.set $s2 (i32.add (local.get $s2) (i32.const 1)))
        (local.set $dep (i32.const 1))
        (local.set $a (call $vw (global.get $jl_bnodes) (i32.shl (local.get $k) (i32.const 1))))
        (local.set $b (call $vw (global.get $jl_bnodes) (i32.add (i32.shl (local.get $k) (i32.const 1)) (i32.const 1))))
        (br $value)))
      (local.set $k (local.get $s3)) (local.set $s3 (i32.add (local.get $s3) (i32.const 1)))
      (local.set $a (call $vw (global.get $jl_tts) (i32.shl (local.get $k) (i32.const 1))))
      (local.set $b (call $vw (global.get $jl_tts) (i32.add (i32.shl (local.get $k) (i32.const 1)) (i32.const 1))))
      (local.set $q0 (i32.load offset=8 (global.get $jseq)))
      (local.set $q1 (i32.load offset=12 (global.get $jseq)))
      (local.set $id (call $jr_tt (local.get $r) (local.get $a) (local.get $b) (i32.add (global.get $jseq) (i32.const 8)) (i32.const 0) (i32.const 0)))
      (if (i32.eq (local.get $id) (i32.const -1)) (then (local.set $id (i32.const 0)) (local.set $dep (i32.const 2)))))
    (if (global.get $jbad) (then (return)))
    (call $v_push2 (global.get $jvals) (local.get $id) (local.get $dep))
    (call $v_push2 (global.get $jvals) (local.get $a) (local.get $b))
    (call $v_push2 (global.get $jvals) (local.get $q0) (local.get $q1))
    (call $v_push1 (global.get $jvals) (i32.const 0))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $values))))
  ;; the sequence layout
  (local.set $nl (call $v_len (global.get $jl_layouts)))
  (local.set $i (i32.const 0))
  (local.set $x (i32.const 0))
  (loop $tokens (if (i32.lt_u (local.get $x) (local.get $nl)) (then
    (local.set $token (call $vw (global.get $jl_layouts) (local.get $x)))
    (local.set $skip (i32.shr_u (local.get $token) (i32.const 5)))
    (local.set $len (i64.extend_i32_u (i32.and (local.get $token) (i32.const 15))))
    (if (i64.eq (local.get $len) (i64.const 15)) (then
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (local.get $nl)) (then (drop (call $jerr (@str "a layout token without its extension varint"))) (return)))
      (local.set $len (i64.add (local.get $len) (i64.extend_i32_u (call $vw (global.get $jl_layouts) (local.get $x)))))))
    (local.set $x (i32.add (local.get $x) (i32.const 1)))
    (if (i32.gt_u (i32.add (local.get $i) (local.get $skip)) (local.get $m)) (then (drop (call $jerr (@str "a layout skips past the last run value"))) (return)))
    (if (i32.gt_u (i32.add (local.get $at) (local.get $skip)) (local.get $rows)) (then (drop (call $jerr (@str "a column longer than row_count"))) (return)))
    (loop $one (if (local.get $skip) (then
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (i32.store (i32.add (local.get $cells) (i32.shl (local.get $at) (i32.const 2))) (i32.add (local.get $base) (local.get $i)))
      (local.set $at (i32.add (local.get $at) (i32.const 1)))
      (local.set $skip (i32.sub (local.get $skip) (i32.const 1)))
      (br $one))))
    (if (i32.and (local.get $token) (i32.const 16))
      (then
        (if (i64.gt_u (i64.add (i64.add (i64.extend_i32_u (local.get $at)) (local.get $len)) (i64.const 1)) (i64.extend_i32_u (local.get $rows)))
          (then (drop (call $jerr (@str "a column longer than row_count"))) (return)))
        (local.set $at (i32.add (i32.add (local.get $at) (i32.wrap_i64 (local.get $len))) (i32.const 1))))
      (else
        (if (i32.ge_u (local.get $i) (local.get $m)) (then (drop (call $jerr (@str "a repeat run past the last run value"))) (return)))
        (if (i64.gt_u (i64.add (i64.add (i64.extend_i32_u (local.get $at)) (local.get $len)) (i64.const 2)) (i64.extend_i32_u (local.get $rows)))
          (then (drop (call $jerr (@str "a column longer than row_count"))) (return)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (local.set $c (i32.add (i32.wrap_i64 (local.get $len)) (i32.const 2)))
        (loop $run
          (i32.store (i32.add (local.get $cells) (i32.shl (local.get $at) (i32.const 2))) (i32.add (local.get $base) (local.get $i)))
          (local.set $at (i32.add (local.get $at) (i32.const 1)))
          (br_if $run (local.tee $c (i32.sub (local.get $c) (i32.const 1)))))))
    (br $tokens))))
  (if (i32.gt_u (i32.add (local.get $at) (i32.sub (local.get $m) (local.get $i))) (local.get $rows)) (then (drop (call $jerr (@str "a column longer than row_count"))) (return)))
  (loop $tail (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (i32.store (i32.add (local.get $cells) (i32.shl (local.get $at) (i32.const 2))) (i32.add (local.get $base) (local.get $i)))
    (local.set $at (i32.add (local.get $at) (i32.const 1)))
    (br $tail))))
  (if (i32.lt_u (local.get $pos) (i32.const 3)) (then
    (local.set $at (i32.const 0))
    (loop $bound (if (i32.lt_u (local.get $at) (local.get $rows)) (then
      (if (i32.eqz (i32.load (i32.add (local.get $cells) (i32.shl (local.get $at) (i32.const 2)))))
        (then (drop (call $jerr (@str "a column with unbound cells"))) (return)))
      (local.set $at (i32.add (local.get $at) (i32.const 1)))
      (br $bound)))))))

(func $jr_batch (param $r i32) (param $s i32) (param $e i32)
  (local $f i32) (local $rows64 i64) (local $rows i32) (local $c i32) (local $col i32) (local $sum i64) (local $i i32) (local $n i32)
  (local $id i32) (local $kind i32) (local $es i32) (local $ee i32) (local $sp i32) (local $se i32) (local $physical i32)
  (local $b i32) (local $next i32) (local $row i32) (local $v i32) (local $q0 i32) (local $q1 i32) (local $q2 i32) (local $q3 i32) (local $cells i32)
  (local.set $physical (i32.load offset=16 (local.get $r)))
  (call $v_clear (global.get $jentries)) (call $v_clear (global.get $jlens)) (call $v_clear (global.get $jl_lex))
  (memory.fill (global.get $jcols) (i32.const 0) (i32.const 48))
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $s)) (global.set $je (local.get $e))
  (loop $fields (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
    (local.set $f (call $jtag))
    (block $field
      (br_if $field (global.get $jbad))
      (if (i32.eq (local.get $f) (i32.const 1)) (then
        (if (global.get $jw) (then (drop (call $jerr (@str "expected a varint field"))) (br $field)))
        (local.set $rows64 (call $jv64))
        (br $field)))
      (if (i32.and (i32.lt_u (i32.sub (local.get $f) (i32.const 2)) (i32.const 3)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jlen) (then
          (call $v_push2 (global.get $jentries) (i32.sub (local.get $f) (i32.const 2)) (global.get $js))
          (call $v_push1 (global.get $jentries) (global.get $jl))))
        (br $field)))
      (if (i32.and (i32.eq (local.get $f) (i32.const 5)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jlen) (then (call $v_push2 (global.get $jl_lex) (global.get $js) (global.get $jl))))
        (br $field)))
      (if (i32.and (i32.lt_u (i32.sub (local.get $f) (i32.const 6)) (i32.const 4)) (i32.eq (global.get $jw) (i32.const 2))) (then
        (if (call $jlen) (then
          (local.set $col (i32.add (global.get $jcols) (i32.mul (i32.sub (local.get $f) (i32.const 6)) (i32.const 12))))
          (i32.store (local.get $col) (global.get $js))
          (i32.store offset=4 (local.get $col) (global.get $jl))
          (i32.store offset=8 (local.get $col) (i32.const 1))))
        (br $field)))
      (if (i32.eq (local.get $f) (i32.const 15)) (then (call $jpacked (global.get $jw) (global.get $jlens)) (br $field)))
      (call $jskip (global.get $jw)))
    (br $fields))))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (global.get $jbad) (then (return)))
  (if (i64.gt_u (local.get $rows64) (i64.const 134217727)) (then (drop (call $jerr (@str "row_count is larger than 2^27 - 1"))) (return)))
  (if (i64.gt_u (local.get $rows64) (i64.const 1048576)) (then (drop (call $jerr (@str "a batch larger than this reader's limit"))) (return)))
  (local.set $rows (i32.wrap_i64 (local.get $rows64)))
  (if (i32.and (i32.ne (i32.load offset=44 (global.get $jcols)) (i32.const 0)) (i32.eq (local.get $physical) (i32.const 1)))
    (then (drop (call $jerr (@str "a graphs column in a stream of triples"))) (return)))
  (local.set $n (call $v_len (global.get $jlens)))
  (if (i32.and (i32.ne (local.get $n) (i32.const 0)) (i32.ne (i32.load offset=20 (local.get $r)) (i32.const 1)))
    (then (drop (call $jerr (@str "message boundaries in a FLAT stream"))) (return)))
  (loop $sum (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (call $vw (global.get $jlens) (local.get $i)))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $sum))))
  (if (i64.gt_u (local.get $sum) (local.get $rows64)) (then (drop (call $jerr (@str "the message lengths add up to more than row_count"))) (return)))
  ;; 1. lookup entries, in order
  (local.set $i (i32.const 0))
  (local.set $n (call $v_len (global.get $jentries)))
  (loop $entries (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (local.set $kind (call $vw (global.get $jentries) (local.get $i)))
    (local.set $es (call $vw (global.get $jentries) (i32.add (local.get $i) (i32.const 1))))
    (local.set $ee (call $vw (global.get $jentries) (i32.add (local.get $i) (i32.const 2))))
    (local.set $id (i32.const 0))
    (call $v_clear (global.get $jl_bnodes))
    (global.set $jp (local.get $es)) (global.set $je (local.get $ee))
    (loop $ef (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
      (local.set $f (call $jtag))
      (if (i32.eqz (global.get $jbad)) (then
        (if (i32.eq (local.get $f) (i32.const 1)) (then (local.set $id (call $juint (global.get $jw))))
          (else (if (i32.and (i32.eq (local.get $f) (i32.const 2)) (i32.eq (global.get $jw) (i32.const 2)))
            (then (if (call $jstr) (then (call $v_push2 (global.get $jl_bnodes) (global.get $js) (global.get $jl)))))
            (else (call $jskip (global.get $jw))))))))
      (br $ef))))
    (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
    (if (global.get $jbad) (then (return)))
    (call $jr_entries (local.get $r) (local.get $kind) (local.get $id) (global.get $jl_bnodes) (i32.const 0) (i32.shr_u (call $v_len (global.get $jl_bnodes)) (i32.const 1)))
    (if (global.get $jbad) (then (return)))
    (local.set $i (i32.add (local.get $i) (i32.const 3)))
    (br $entries))))
  ;; 2. namespace declarations: one IRI sequence
  (i64.store (global.get $jseq) (i64.const 0))
  (local.set $i (i32.const 0))
  (local.set $n (call $v_len (global.get $jl_lex)))
  (loop $ns (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (call $jr_namespace (local.get $r) (call $vw (global.get $jl_lex) (local.get $i)) (call $vw (global.get $jl_lex) (i32.add (local.get $i) (i32.const 1))) (global.get $jseq))
    (if (global.get $jbad) (then (return)))
    (local.set $i (i32.add (local.get $i) (i32.const 2)))
    (br $ns))))
  ;; 3. statements: each column's cells, then row by row
  (call $v_clear (global.get $jvals))
  (local.set $c (i32.const 0))
  (block $cols
    (loop $each
      (local.set $col (i32.add (global.get $jcols) (i32.mul (local.get $c) (i32.const 12))))
      (if (i32.load offset=8 (local.get $col))
        (then
          (i32.store offset=8 (local.get $col) (local.tee $cells (call $alloc0 (i32.shl (local.get $rows) (i32.const 2)))))
          (call $jr_column (local.get $r) (i32.load (local.get $col)) (i32.load offset=4 (local.get $col)) (local.get $rows) (local.get $c) (local.get $cells))
          (br_if $cols (global.get $jbad)))
        (else (if (i32.and (i32.lt_u (local.get $c) (i32.const 3)) (i32.ne (local.get $rows) (i32.const 0)))
          (then (drop (call $jerr (@str "a column with unbound cells"))) (br $cols)))))
      (br_if $each (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 1))) (i32.const 4))))
    (local.set $n (call $v_len (global.get $jlens)))
    (local.set $b (call $jr_zero_lengths (local.get $r) (i32.const 0)))
    (local.set $next (if (result i32) (i32.lt_u (local.get $b) (local.get $n)) (then (call $vw (global.get $jlens) (local.get $b))) (else (i32.const -1))))
    (call $quads_reserve_qb (local.get $rows))
    (loop $rows (if (i32.lt_u (local.get $row) (local.get $rows)) (then
      (local.set $q0 (call $jr_cell (local.get $r) (i32.const 0) (local.get $row)))
      (local.set $q1 (call $jr_cell (local.get $r) (i32.const 1) (local.get $row)))
      (local.set $q2 (call $jr_cell (local.get $r) (i32.const 2) (local.get $row)))
      (local.set $q3 (call $jr_cell (local.get $r) (i32.const 3) (local.get $row)))
      (br_if $cols (global.get $jbad))
      (call $push_quad (local.get $q0) (local.get $q1) (local.get $q2)
        (if (result i32) (i32.eq (local.get $physical) (i32.const 2))
          (then (select (local.get $q3) (i32.const 1) (local.get $q3)))
          (else (i32.load offset=4 (local.get $r)))))
      (i32.store offset=120 (local.get $r) (i32.add (i32.load offset=120 (local.get $r)) (i32.const 1)))
      (if (i32.ne (local.get $next) (i32.const -1)) (then
        (if (i32.eqz (local.tee $next (i32.sub (local.get $next) (i32.const 1)))) (then
          (call $jr_end_message (local.get $r) (call $jr_at))
          (local.set $b (call $jr_zero_lengths (local.get $r) (i32.add (local.get $b) (i32.const 1))))
          (local.set $next (if (result i32) (i32.lt_u (local.get $b) (local.get $n)) (then (call $vw (global.get $jlens) (local.get $b))) (else (i32.const -1))))))))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))))
  (local.set $c (i32.const 0))
  (loop $free
    (local.set $col (i32.add (global.get $jcols) (i32.mul (local.get $c) (i32.const 12))))
    (if (i32.gt_u (i32.load offset=8 (local.get $col)) (i32.const 1)) (then (call $free (i32.load offset=8 (local.get $col)) (i32.shl (local.get $rows) (i32.const 2)))))
    (i32.store offset=8 (local.get $col) (i32.const 0))
    (br_if $free (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 1))) (i32.const 4)))))

;; Message lengths of 0 from index i on: each ends the current message. Returns the next index.
(func $jr_zero_lengths (param $r i32) (param $i i32) (result i32)
  (loop $l (if (i32.and (i32.lt_u (local.get $i) (call $v_len (global.get $jlens))) (i32.eqz (call $vw (global.get $jlens) (local.get $i)))) (then
    (call $jr_end_message (local.get $r) (call $jr_at))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l))))
  (local.get $i))

;; The term in column c, row `row` (0: unbound).
(func $jr_cell (param $r i32) (param $c i32) (param $row i32) (result i32)
  (local $cells i32) (local $v i32)
  (local.set $cells (i32.load offset=8 (i32.add (global.get $jcols) (i32.mul (local.get $c) (i32.const 12)))))
  (if (i32.eqz (local.get $cells)) (then (return (i32.const 0))))
  (if (i32.eqz (local.tee $v (i32.load (i32.add (local.get $cells) (i32.shl (local.get $row) (i32.const 2)))))) (then (return (i32.const 0))))
  (call $jr_value (local.get $r) (i32.sub (local.get $v) (i32.const 1))))

;; Room in load.wat's quad buffer for n more quads.
(func $quads_reserve_qb (param $n i32)
  (local $need i32) (local $cap i32)
  (local.set $need (i32.add (global.get $qb_len) (i32.shl (local.get $n) (i32.const 4))))
  (local.set $cap (global.get $qb_cap))
  (if (i32.le_u (local.get $need) (local.get $cap)) (then (return)))
  (loop $l (local.set $cap (i32.shl (local.get $cap) (i32.const 1))) (br_if $l (i32.lt_u (local.get $cap) (local.get $need))))
  (global.set $qb (call $realloc (global.get $qb) (global.get $qb_cap) (local.get $cap) (global.get $qb_len)))
  (global.set $qb_cap (local.get $cap)))

;; Read one frame [p, p+n): its statements onto load.wat's quad buffer.
(func $jr_frame (param $r i32) (param $p i32) (param $n i32)
  (local $f i32) (local $rows i32) (local $ms i32) (local $me i32) (local $os i32) (local $oe i32) (local $cs i32) (local $ce i32) (local $has i32)
  (local $sp i32) (local $se i32) (local $f2 i32)
  (call $v_clear (i32.load offset=136 (local.get $r)))
  (local.set $sp (global.get $jp)) (local.set $se (global.get $je))
  (global.set $jp (local.get $p)) (global.set $je (i32.add (local.get $p) (local.get $n)))
  (block $done
    (loop $fields
      (br_if $done (i32.or (i32.ge_u (global.get $jp) (global.get $je)) (global.get $jbad)))
      (local.set $f (call $jtag))
      (br_if $done (global.get $jbad))
      (block $field
        (if (i32.and (i32.eq (local.get $f) (i32.const 1)) (i32.eq (global.get $jw) (i32.const 2))) (then
          (br_if $done (i32.eqz (call $jlen)))
          (local.set $ms (global.get $js)) (local.set $me (global.get $jl))
          (if (i32.and (i32.ne (i32.load offset=12 (local.get $r)) (i32.const 0)) (i32.lt_u (i32.load offset=36 (local.get $r)) (i32.const 3))) (then
            (call $jr_row (local.get $r) (local.get $ms) (local.get $me))
            (br $field)))
          (if (local.get $rows) (then (drop (call $jerr (@str "a Jelly-RDF 1.2 frame has at most one row"))) (br $done)))
          (local.set $rows (i32.const 1))
          (local.set $os (i32.const 0)) (local.set $oe (i32.const 0))
          (global.set $jp (local.get $ms)) (global.set $je (local.get $me))
          (loop $rf (if (i32.and (i32.lt_u (global.get $jp) (global.get $je)) (i32.eqz (global.get $jbad))) (then
            (local.set $f2 (call $jtag))
            (if (i32.eqz (global.get $jbad)) (then
              (if (i32.and (i32.eq (local.get $f2) (i32.const 1)) (i32.eq (global.get $jw) (i32.const 2)))
                (then (if (call $jlen) (then (local.set $os (global.get $js)) (local.set $oe (global.get $jl)))))
                (else (drop (call $jerr (@str "a Jelly-RDF 1.2 row holds only the stream options")))))))
            (br $rf))))
          (global.set $jp (local.get $me)) (global.set $je (i32.add (local.get $p) (local.get $n)))
          (br_if $done (global.get $jbad))
          (if (i32.eqz (local.get $os)) (then (drop (call $jerr (@str "an empty row"))) (br $done)))
          (call $jr_options (local.get $r) (local.get $os) (i32.sub (local.get $oe) (local.get $os)) (call $jr_at))
          (br $field)))
        (if (i32.and (i32.eq (local.get $f) (i32.const 2)) (i32.eq (global.get $jw) (i32.const 2))) (then
          (br_if $done (i32.eqz (call $jlen)))
          (local.set $cs (global.get $js)) (local.set $ce (global.get $jl)) (local.set $has (i32.const 1))
          (br $field)))
        (call $jskip (global.get $jw)))
      (br $fields)))
  (global.set $jp (local.get $sp)) (global.set $je (local.get $se))
  (if (i32.or (global.get $jbad) (i32.eqz (local.get $has))) (then (return)))
  (if (i32.eqz (i32.load offset=12 (local.get $r))) (then (drop (call $jerr (@str "statements before the stream options"))) (return)))
  (if (i32.eq (i32.load offset=36 (local.get $r)) (i32.const 3)) (then (call $jr_batch (local.get $r) (local.get $cs) (local.get $ce)))))

;; A whole stream [p, p+n) (delimited frames, or one bare frame) onto the quad buffer.
(func $jelly_stream (param $r i32) (param $p i32) (param $n i32)
  (local $end i32) (local $len i64) (local $at i32)
  (local.set $end (i32.add (local.get $p) (local.get $n)))
  ;; a bare frame starts with its options row: 0x0A, a length, 0x0A
  (if (i32.and (i32.ge_u (local.get $n) (i32.const 3))
               (i32.and (i32.eq (i32.load8_u (local.get $p)) (i32.const 0x0a)) (i32.eq (i32.load8_u offset=2 (local.get $p)) (i32.const 0x0a))))
    (then (call $jr_frame (local.get $r) (local.get $p) (local.get $n)) (return)))
  (global.set $jp (local.get $p)) (global.set $je (local.get $end))
  (loop $frames (if (i32.and (i32.lt_u (global.get $jp) (local.get $end)) (i32.eqz (global.get $jbad))) (then
    (local.set $len (call $jv64))
    (if (global.get $jbad) (then (return)))
    (if (i64.gt_u (local.get $len) (i64.extend_i32_u (i32.sub (local.get $end) (global.get $jp)))) (then (drop (call $jerr (@str "truncated frame"))) (return)))
    (local.set $at (global.get $jp))
    (global.set $jp (i32.add (local.get $at) (i32.wrap_i64 (local.get $len))))
    (call $jr_frame (local.get $r) (local.get $at) (i32.wrap_i64 (local.get $len)))
    (br $frames)))))

;; --- the writer ------------------------------------------------------------------------
;; A least-recently-used lookup (alloc0 48): +0 max, +4 next free id, +8 last id written, +12 table
;; (ids, 0 empty, open addressing, at most half full), +16 its slots, +20 entries by id (24 bytes:
;; +0 value ptr, +4 len, +8 hash, +12 prev, +16 next, +20 epoch), +24 head (least recent), +28 tail,
;; +32 the batch's epoch, +36 values the batch uses, +40 the batch's new ids (a vector).

(global $lru_hit (mut i32) (i32.const 0))

(func $lru_new (param $max i32) (result i32)
  (local $l i32) (local $cap i32)
  (local.set $l (call $alloc0 (i32.const 48)))
  (i32.store (local.get $l) (local.get $max))
  (i32.store offset=4 (local.get $l) (i32.const 1))
  (local.set $cap (i32.const 8))
  (loop $grow (if (i32.lt_u (local.get $cap) (i32.add (i32.shl (local.get $max) (i32.const 1)) (i32.const 2))) (then
    (local.set $cap (i32.shl (local.get $cap) (i32.const 1))) (br $grow))))
  (i32.store offset=12 (local.get $l) (call $alloc0 (i32.shl (local.get $cap) (i32.const 2))))
  (i32.store offset=16 (local.get $l) (local.get $cap))
  (i32.store offset=20 (local.get $l) (call $alloc0 (i32.mul (i32.add (local.get $max) (i32.const 1)) (i32.const 24))))
  (i32.store offset=32 (local.get $l) (i32.const 1))
  (i32.store offset=40 (local.get $l) (call $v_new))
  (local.get $l))

(func $lru_entry (param $l i32) (param $id i32) (result i32)
  (i32.add (i32.load offset=20 (local.get $l)) (i32.mul (local.get $id) (i32.const 24))))

(func $lru_free (param $l i32)
  (local $id i32) (local $e i32)
  (local.set $id (i32.const 1))
  (loop $l (if (i32.lt_u (local.get $id) (i32.load offset=4 (local.get $l))) (then
    (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
    (call $free (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))
    (local.set $id (i32.add (local.get $id) (i32.const 1)))
    (br $l))))
  (call $free (i32.load offset=12 (local.get $l)) (i32.shl (i32.load offset=16 (local.get $l)) (i32.const 2)))
  (call $free (i32.load offset=20 (local.get $l)) (i32.mul (i32.add (i32.load (local.get $l)) (i32.const 1)) (i32.const 24)))
  (call $v_free (i32.load offset=40 (local.get $l)))
  (call $free (local.get $l) (i32.const 48)))

(func $lru_hash (param $p i32) (param $n i32) (result i32)
  (i32.or (call $fmix (call $hash_bytes (i32.const 0) (local.get $p) (local.get $n))) (i32.const 1)))

;; The slot holding the value, or the empty slot where it would go; $lru_hit is its id or 0.
(func $lru_find (param $l i32) (param $p i32) (param $n i32) (param $h i32) (result i32)
  (local $mask i32) (local $i i32) (local $slot i32) (local $id i32) (local $e i32)
  (local.set $mask (i32.sub (i32.load offset=16 (local.get $l)) (i32.const 1)))
  (local.set $i (local.get $h))
  (loop $probe
    (local.set $slot (i32.add (i32.load offset=12 (local.get $l)) (i32.shl (i32.and (local.get $i) (local.get $mask)) (i32.const 2))))
    (if (local.tee $id (i32.load (local.get $slot))) (then
      (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
      (if (i32.and (i32.eq (i32.load offset=8 (local.get $e)) (local.get $h)) (i32.eq (i32.load offset=4 (local.get $e)) (local.get $n))) (then
        (if (call $memeq (i32.load (local.get $e)) (local.get $p) (local.get $n)) (then
          (global.set $lru_hit (local.get $id))
          (return (local.get $slot))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $probe))))
  (global.set $lru_hit (i32.const 0))
  (local.get $slot))

(func $lru_get (param $l i32) (param $p i32) (param $n i32) (result i32)
  (if (i32.eqz (i32.load (local.get $l))) (then (return (i32.const 0))))
  (drop (call $lru_find (local.get $l) (local.get $p) (local.get $n) (call $lru_hash (local.get $p) (local.get $n))))
  (global.get $lru_hit))

(func $lru_touched (param $l i32) (param $p i32) (param $n i32) (result i32)
  (local $id i32)
  (if (i32.eqz (local.tee $id (call $lru_get (local.get $l) (local.get $p) (local.get $n)))) (then (return (i32.const 0))))
  (i32.eq (i32.load offset=20 (call $lru_entry (local.get $l) (local.get $id))) (i32.load offset=32 (local.get $l))))

(func $lru_unlink (param $l i32) (param $id i32)
  (local $e i32) (local $p i32) (local $n i32)
  (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
  (local.set $p (i32.load offset=12 (local.get $e)))
  (local.set $n (i32.load offset=16 (local.get $e)))
  (if (local.get $p) (then (i32.store offset=16 (call $lru_entry (local.get $l) (local.get $p)) (local.get $n))) (else (i32.store offset=24 (local.get $l) (local.get $n))))
  (if (local.get $n) (then (i32.store offset=12 (call $lru_entry (local.get $l) (local.get $n)) (local.get $p))) (else (i32.store offset=28 (local.get $l) (local.get $p)))))

(func $lru_push_back (param $l i32) (param $id i32)
  (local $e i32) (local $t i32)
  (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
  (local.set $t (i32.load offset=28 (local.get $l)))
  (i32.store offset=12 (local.get $e) (local.get $t))
  (i32.store offset=16 (local.get $e) (i32.const 0))
  (if (local.get $t) (then (i32.store offset=16 (call $lru_entry (local.get $l) (local.get $t)) (local.get $id))) (else (i32.store offset=24 (local.get $l) (local.get $id))))
  (i32.store offset=28 (local.get $l) (local.get $id)))

;; Remove id from the table (backward shift).
(func $lru_remove (param $l i32) (param $id i32)
  (local $mask i32) (local $i i32) (local $j i32) (local $x i32) (local $home i32) (local $t i32)
  (local.set $t (i32.load offset=12 (local.get $l)))
  (local.set $mask (i32.sub (i32.load offset=16 (local.get $l)) (i32.const 1)))
  (local.set $i (i32.and (i32.load offset=8 (call $lru_entry (local.get $l) (local.get $id))) (local.get $mask)))
  (loop $find (if (i32.ne (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))) (local.get $id)) (then
    (local.set $i (i32.and (i32.add (local.get $i) (i32.const 1)) (local.get $mask)))
    (br $find))))
  (local.set $j (local.get $i))
  (loop $scan
    (local.set $j (i32.and (i32.add (local.get $j) (i32.const 1)) (local.get $mask)))
    (if (local.tee $x (i32.load (i32.add (local.get $t) (i32.shl (local.get $j) (i32.const 2))))) (then
      (local.set $home (i32.and (i32.load offset=8 (call $lru_entry (local.get $l) (local.get $x))) (local.get $mask)))
      (if (i32.ge_u (i32.and (i32.sub (local.get $j) (local.get $home)) (local.get $mask)) (i32.and (i32.sub (local.get $j) (local.get $i)) (local.get $mask)))
        (then
          (i32.store (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))) (local.get $x))
          (local.set $i (local.get $j))))
      (br $scan))))
  (i32.store (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))) (i32.const 0)))

;; The value's id (entering it if new, in place of the least recently used), marked used by the batch.
(func $lru_use (param $l i32) (param $p i32) (param $n i32) (result i32)
  (local $h i32) (local $id i32) (local $e i32) (local $q i32)
  (local.set $h (call $lru_hash (local.get $p) (local.get $n)))
  (drop (call $lru_find (local.get $l) (local.get $p) (local.get $n) (local.get $h)))
  (if (local.tee $id (global.get $lru_hit))
    (then (call $lru_unlink (local.get $l) (local.get $id)))
    (else
      (if (i32.le_u (i32.load offset=4 (local.get $l)) (i32.load (local.get $l)))
        (then
          (local.set $id (i32.load offset=4 (local.get $l)))
          (i32.store offset=4 (local.get $l) (i32.add (local.get $id) (i32.const 1))))
        (else
          (local.set $id (i32.load offset=24 (local.get $l)))
          (call $lru_unlink (local.get $l) (local.get $id))
          (call $lru_remove (local.get $l) (local.get $id))))
      (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
      (call $free (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))
      (memory.copy (local.tee $q (call $alloc (local.get $n))) (local.get $p) (local.get $n))
      (i32.store (local.get $e) (local.get $q))
      (i32.store offset=4 (local.get $e) (local.get $n))
      (i32.store offset=8 (local.get $e) (local.get $h))
      (i32.store (call $lru_find (local.get $l) (local.get $p) (local.get $n) (local.get $h)) (local.get $id))
      (call $v_push1 (i32.load offset=40 (local.get $l)) (local.get $id))))
  (call $lru_push_back (local.get $l) (local.get $id))
  (local.set $e (call $lru_entry (local.get $l) (local.get $id)))
  (if (i32.ne (i32.load offset=20 (local.get $e)) (i32.load offset=32 (local.get $l))) (then
    (i32.store offset=20 (local.get $e) (i32.load offset=32 (local.get $l)))
    (i32.store offset=36 (local.get $l) (i32.add (i32.load offset=36 (local.get $l)) (i32.const 1)))))
  (local.get $id))

;; The batch's new entries as packed entries (field `field`).
(func $lru_write (param $l i32) (param $b i32) (param $field i32)
  (local $f i32) (local $n i32) (local $i i32) (local $j i32) (local $id i32) (local $start i32) (local $k i32) (local $e i32)
  (local.set $f (i32.load offset=40 (local.get $l)))
  (local.set $n (call $v_len (local.get $f)))
  (loop $groups (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (local.set $j (i32.add (local.get $i) (i32.const 1)))
    (loop $run (if (i32.and (i32.lt_u (local.get $j) (local.get $n))
                            (i32.eq (call $vw (local.get $f) (local.get $j)) (i32.add (call $vw (local.get $f) (i32.sub (local.get $j) (i32.const 1))) (i32.const 1)))) (then
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $run))))
    (local.set $id (call $vw (local.get $f) (local.get $i)))
    (local.set $start (call $ob_open (local.get $b)))
    (call $ob_uint (local.get $b) (i32.const 1) (select (i32.const 0) (local.get $id) (i32.eq (local.get $id) (i32.add (i32.load offset=8 (local.get $l)) (i32.const 1)))))
    (local.set $k (local.get $i))
    (loop $vals (if (i32.lt_u (local.get $k) (local.get $j)) (then
      (local.set $e (call $lru_entry (local.get $l) (call $vw (local.get $f) (local.get $k))))
      (call $ob_str (local.get $b) (i32.const 2) (i32.load (local.get $e)) (i32.load offset=4 (local.get $e)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $vals))))
    (call $ob_close (local.get $b) (local.get $field) (local.get $start))
    (i32.store offset=8 (local.get $l) (call $vw (local.get $f) (i32.sub (local.get $j) (i32.const 1))))
    (local.set $i (local.get $j))
    (br $groups)))))

(func $lru_end (param $l i32)
  (i32.store offset=32 (local.get $l) (i32.add (i32.load offset=32 (local.get $l)) (i32.const 1)))
  (i32.store offset=36 (local.get $l) (i32.const 0))
  (call $v_clear (i32.load offset=40 (local.get $l))))

;; A writer record (alloc0 64): +0 kind (2), +4 physical, +8 stream type, +12 RDF version,
;; +16/+20/+24 max names, prefixes, datatypes, +28 statements per frame, +32 started,
;; +36/+40/+44 the three lookups, +48 the frame's statements (a vector, 4 words each, graph 0 for
;; the default graph), +52 its message lengths (a vector), +56 statements before the current
;; message's start, +60 the output (a byte buffer: frames, delimited).

(global $wk0 (mut i32) (i32.const 0))   ;; a statement's lookup values: (ptr, len) pairs per lookup
(global $wk1 (mut i32) (i32.const 0))
(global $wk2 (mut i32) (i32.const 0))
(global $wv_vals (mut i32) (i32.const 0))
(global $wv_lay (mut i32) (i32.const 0))
(global $wv_names (mut i32) (i32.const 0))
(global $wv_prefs (mut i32) (i32.const 0))
(global $wv_tmp (mut i32) (i32.const 0))
(global $wv_kinds (mut i32) (i32.const 0))
(global $wv_langs (mut i32) (i32.const 0))  ;; (literal id, direction) pairs
(global $wseq (mut i32) (i32.const 0))

(func $init_jelly_writer
  (global.set $wk0 (call $v_new)) (global.set $wk1 (call $v_new)) (global.set $wk2 (call $v_new))
  (global.set $wv_vals (call $v_new)) (global.set $wv_lay (call $v_new)) (global.set $wv_names (call $v_new))
  (global.set $wv_prefs (call $v_new)) (global.set $wv_tmp (call $v_new)) (global.set $wv_kinds (call $v_new))
  (global.set $wv_langs (call $v_new))
  (global.set $wseq (call $alloc0 (i32.const 8))))

(func $jw_new (param $physical i32) (param $st i32) (param $rv i32) (param $m0 i32) (param $m1 i32) (param $m2 i32) (param $rows i32) (result i32)
  (local $w i32)
  (if (i32.gt_u (i32.sub (local.get $physical) (i32.const 1)) (i32.const 1)) (then (return (call $fail (@str "an unknown physical stream type")))))
  (if (i32.or (i32.gt_u (local.get $st) (i32.const 1)) (i32.gt_u (local.get $rv) (i32.const 3))) (then (return (call $fail (@str "an unknown stream type or RDF version")))))
  (if (i32.lt_u (local.get $m0) (i32.const 128)) (then (return (call $fail (@str "a name lookup smaller than 128")))))
  (if (i32.or (i32.or (i32.gt_u (local.get $m0) (i32.const J_MAX_NAMES)) (i32.gt_u (local.get $m1) (i32.const J_MAX_PREFIXES)))
              (i32.gt_u (local.get $m2) (i32.const J_MAX_DATATYPES)))
    (then (return (call $fail (@str "a lookup larger than readers take")))))
  (local.set $w (call $alloc0 (i32.const 64)))
  (i32.store (local.get $w) (i32.const 2))
  (i32.store offset=4 (local.get $w) (local.get $physical))
  (i32.store offset=8 (local.get $w) (local.get $st))
  (i32.store offset=12 (local.get $w) (local.get $rv))
  (i32.store offset=16 (local.get $w) (local.get $m0))
  (i32.store offset=20 (local.get $w) (local.get $m1))
  (i32.store offset=24 (local.get $w) (local.get $m2))
  (i32.store offset=28 (local.get $w) (select (local.get $rows) (i32.const 4096) (local.get $rows)))
  (i32.store offset=36 (local.get $w) (call $lru_new (local.get $m0)))
  (i32.store offset=40 (local.get $w) (call $lru_new (local.get $m1)))
  (i32.store offset=44 (local.get $w) (call $lru_new (local.get $m2)))
  (i32.store offset=48 (local.get $w) (call $v_new))
  (i32.store offset=52 (local.get $w) (call $v_new))
  (i32.store offset=60 (local.get $w) (call $ob_new))
  (local.get $w))

(func $jw_free (param $w i32)
  (call $lru_free (i32.load offset=36 (local.get $w)))
  (call $lru_free (i32.load offset=40 (local.get $w)))
  (call $lru_free (i32.load offset=44 (local.get $w)))
  (call $v_free (i32.load offset=48 (local.get $w)))
  (call $v_free (i32.load offset=52 (local.get $w)))
  (call $ob_free (i32.load offset=60 (local.get $w)))
  (call $free (local.get $w) (i32.const 64)))

;; Where an IRI splits: after its last '#' or '/' (0 without either).
(func $iri_split (param $p i32) (param $n i32) (result i32)
  (local $c i32)
  (loop $back (if (local.get $n) (then
    (local.set $c (i32.load8_u (i32.add (local.get $p) (i32.sub (local.get $n) (i32.const 1)))))
    (if (i32.or (i32.eq (local.get $c) (i32.const '#')) (i32.eq (local.get $c) (i32.const '/'))) (then (return (local.get $n))))
    (local.set $n (i32.sub (local.get $n) (i32.const 1)))
    (br $back))))
  (i32.const 0))

;; Note a value once (first use first).
(func $wkey (param $v i32) (param $p i32) (param $n i32)
  (local $i i32) (local $k i32)
  (local.set $k (call $v_len (local.get $v)))
  (loop $l (if (i32.lt_u (local.get $i) (local.get $k)) (then
    (if (i32.eq (call $vw (local.get $v) (i32.add (local.get $i) (i32.const 1))) (local.get $n)) (then
      (if (call $memeq (call $vw (local.get $v) (local.get $i)) (local.get $p) (local.get $n)) (then (return)))))
    (local.set $i (i32.add (local.get $i) (i32.const 2)))
    (br $l))))
  (call $v_push2 (local.get $v) (local.get $p) (local.get $n)))

;; The lookup values term id at position pos needs.
(func $jw_keys (param $w i32) (param $id i32) (param $pos i32)
  (local $r i32) (local $kind i32) (local $p i32) (local $n i32) (local $cut i32) (local $dt i32)
  (if (i32.eqz (local.tee $kind (call $kind (local.get $id)))) (then (drop (call $jerr (@str "a free term id"))) (return)))
  (local.set $r (call $rec (local.get $id)))
  (if (i32.eq (local.get $kind) (i32.const 1)) (then
    (local.set $p (i32.load offset=8 (local.get $r)))
    (local.set $n (i32.load offset=12 (local.get $r)))
    (if (i32.load offset=20 (local.get $w))
      (then
        (local.set $cut (call $iri_split (local.get $p) (local.get $n)))
        (call $wkey (global.get $wk0) (i32.add (local.get $p) (local.get $cut)) (i32.sub (local.get $n) (local.get $cut)))
        (call $wkey (global.get $wk1) (local.get $p) (local.get $cut)))
      (else (call $wkey (global.get $wk0) (local.get $p) (local.get $n))))
    (return)))
  (if (i32.eq (local.get $kind) (i32.const 2)) (then
    (if (i32.eq (local.get $pos) (i32.const 1)) (then (drop (call $jerr (@str "a blank node predicate")))))
    (return)))
  (if (i32.eq (local.get $kind) (i32.const 3)) (then
    (if (i32.ne (local.get $pos) (i32.const 2)) (then (drop (call $jerr (@str "a literal outside the object position"))) (return)))
    (local.set $dt (i32.load offset=16 (local.get $r)))
    (if (i32.or (i32.eq (local.get $dt) (i32.const 3)) (i32.eq (local.get $dt) (i32.const 4))) (then
      (if (i32.and (i32.ne (i32.load8_u offset=1 (local.get $r)) (i32.const 0)) (i32.eq (i32.load offset=12 (local.get $w)) (i32.const 1)))
        (then (drop (call $jerr (@str "a base direction in a stream of RDF 1.1")))))
      (return)))
    (if (i32.ne (local.get $dt) (i32.const 2)) (then
      (if (i32.eqz (i32.load offset=24 (local.get $w))) (then (drop (call $jerr (@str "a typed literal with the datatype lookup disabled"))) (return)))
      (call $wkey (global.get $wk2) (i32.load offset=8 (call $rec (local.get $dt))) (i32.load offset=12 (call $rec (local.get $dt))))))
    (return)))
  (if (i32.eq (local.get $kind) (i32.const 4)) (then
    (if (i32.ne (local.get $pos) (i32.const 2)) (then (drop (call $jerr (@str "a triple term outside the object position"))) (return)))
    (if (i32.lt_u (i32.sub (i32.load offset=12 (local.get $w)) (i32.const 1)) (i32.const 2)) (then (drop (call $jerr (@str "a triple term in a stream without triple terms"))) (return)))
    (call $jw_keys (local.get $w) (i32.load offset=8 (local.get $r)) (i32.const 0))
    (if (global.get $jbad) (then (return)))
    (call $jw_keys (local.get $w) (i32.load offset=12 (local.get $r)) (i32.const 1))
    (if (global.get $jbad) (then (return)))
    (call $jw_keys (local.get $w) (i32.load offset=16 (local.get $r)) (i32.const 2))
    (return)))
  (drop (call $jerr (@str "a term that is not an IRI, blank node, literal or triple term"))))

;; Whether lookup l takes the batch's values plus keys v.
(func $jw_fits (param $l i32) (param $v i32) (result i32)
  (local $i i32) (local $n i32) (local $count i32)
  (local.set $n (call $v_len (local.get $v)))
  (local.set $count (i32.load offset=36 (local.get $l)))
  (loop $each (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (if (i32.eqz (call $lru_touched (local.get $l) (call $vw (local.get $v) (local.get $i)) (call $vw (local.get $v) (i32.add (local.get $i) (i32.const 1)))))
      (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
    (local.set $i (i32.add (local.get $i) (i32.const 2)))
    (br $each))))
  (i32.le_u (local.get $count) (i32.load (local.get $l))))

(func $jw_use (param $l i32) (param $v i32)
  (local $i i32) (local $n i32)
  (local.set $n (call $v_len (local.get $v)))
  (loop $each (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (drop (call $lru_use (local.get $l) (call $vw (local.get $v) (local.get $i)) (call $vw (local.get $v) (i32.add (local.get $i) (i32.const 1)))))
    (local.set $i (i32.add (local.get $i) (i32.const 2)))
    (br $each)))))

(func $jw_add (param $w i32) (param $s i32) (param $p i32) (param $o i32) (param $g i32)
  (local $rows i32)
  (call $v_clear (global.get $wk0)) (call $v_clear (global.get $wk1)) (call $v_clear (global.get $wk2))
  (call $jw_keys (local.get $w) (local.get $s) (i32.const 0))
  (if (global.get $jbad) (then (return)))
  (if (i32.eq (call $kind (local.get $s)) (i32.const 4)) (then (drop (call $jerr (@str "a triple term subject"))) (return)))
  (call $jw_keys (local.get $w) (local.get $p) (i32.const 1))
  (if (global.get $jbad) (then (return)))
  (if (i32.ne (call $kind (local.get $p)) (i32.const 1)) (then (drop (call $jerr (@str "a predicate that is not an IRI"))) (return)))
  (call $jw_keys (local.get $w) (local.get $o) (i32.const 2))
  (if (global.get $jbad) (then (return)))
  (if (i32.eq (local.get $g) (i32.const 1)) (then (local.set $g (i32.const 0))))
  (if (local.get $g) (then
    (if (i32.eq (i32.load offset=4 (local.get $w)) (i32.const 1)) (then (drop (call $jerr (@str "a statement in a named graph, in a stream of triples"))) (return)))
    (if (i32.gt_u (i32.sub (call $kind (local.get $g)) (i32.const 1)) (i32.const 1)) (then (drop (call $jerr (@str "a graph name that is not an IRI or a blank node"))) (return)))
    (call $jw_keys (local.get $w) (local.get $g) (i32.const 0))
    (if (global.get $jbad) (then (return)))))
  (local.set $rows (i32.load offset=48 (local.get $w)))
  (if (i32.eqz (i32.and (i32.and (call $jw_fits (i32.load offset=36 (local.get $w)) (global.get $wk0)) (call $jw_fits (i32.load offset=40 (local.get $w)) (global.get $wk1)))
                        (call $jw_fits (i32.load offset=44 (local.get $w)) (global.get $wk2)))) (then
    (if (i32.eqz (call $v_len (local.get $rows))) (then (drop (call $jerr (@str "a statement needs more lookup entries than the lookups hold"))) (return)))
    (call $jw_flush (local.get $w))))
  (call $jw_use (i32.load offset=36 (local.get $w)) (global.get $wk0))
  (call $jw_use (i32.load offset=40 (local.get $w)) (global.get $wk1))
  (call $jw_use (i32.load offset=44 (local.get $w)) (global.get $wk2))
  (call $v_push2 (local.get $rows) (local.get $s) (local.get $p))
  (call $v_push2 (local.get $rows) (local.get $o) (local.get $g))
  (if (i32.ge_u (i32.shr_u (call $v_len (local.get $rows)) (i32.const 2)) (i32.load offset=28 (local.get $w))) (then (call $jw_flush (local.get $w)))))

;; Term id's name and prefix ids: sets $jw_prefix, returns the name's.
(global $jw_prefix (mut i32) (i32.const 0))
(func $jw_name (param $w i32) (param $id i32) (result i32)
  (local $r i32) (local $p i32) (local $n i32) (local $cut i32)
  (local.set $r (call $rec (local.get $id)))
  (local.set $p (i32.load offset=8 (local.get $r)))
  (local.set $n (i32.load offset=12 (local.get $r)))
  (global.set $jw_prefix (i32.const 0))
  (if (i32.eqz (i32.load offset=20 (local.get $w))) (then (return (call $lru_get (i32.load offset=36 (local.get $w)) (local.get $p) (local.get $n)))))
  (local.set $cut (call $iri_split (local.get $p) (local.get $n)))
  (global.set $jw_prefix (call $lru_get (i32.load offset=40 (local.get $w)) (local.get $p) (local.get $cut)))
  (call $lru_get (i32.load offset=36 (local.get $w)) (i32.add (local.get $p) (local.get $cut)) (i32.sub (local.get $n) (local.get $cut))))

(func $jw_iri (param $w i32) (param $b i32) (param $field i32) (param $id i32) (param $seq i32)
  (local $start i32) (local $n i32) (local $p i32)
  (local.set $n (call $jw_name (local.get $w) (local.get $id)))
  (local.set $p (global.get $jw_prefix))
  (local.set $start (call $ob_open (local.get $b)))
  (call $ob_uint (local.get $b) (i32.const 1) (select (i32.const 0) (local.get $p) (i32.eq (local.get $p) (i32.load (local.get $seq)))))
  (call $ob_uint (local.get $b) (i32.const 2) (select (i32.const 0) (local.get $n) (i32.eq (local.get $n) (i32.add (i32.load offset=4 (local.get $seq)) (i32.const 1)))))
  (if (local.get $p) (then (i32.store (local.get $seq) (local.get $p))))
  (i32.store offset=4 (local.get $seq) (local.get $n))
  (call $ob_close (local.get $b) (local.get $field) (local.get $start)))

(func $jw_tt (param $w i32) (param $b i32) (param $id i32) (param $seq i32)
  (local $r i32) (local $s i32) (local $o i32) (local $ro i32) (local $start i32) (local $dt i32)
  (local.set $r (call $rec (local.get $id)))
  (local.set $s (i32.load offset=8 (local.get $r)))
  (if (i32.eq (call $kind (local.get $s)) (i32.const 1))
    (then (call $jw_iri (local.get $w) (local.get $b) (i32.const 1) (local.get $s) (local.get $seq)))
    (else (call $ob_str (local.get $b) (i32.const 2) (i32.load offset=8 (call $rec (local.get $s))) (i32.load offset=12 (call $rec (local.get $s))))))
  (call $jw_iri (local.get $w) (local.get $b) (i32.const 5) (i32.load offset=12 (local.get $r)) (local.get $seq))
  (local.set $o (i32.load offset=16 (local.get $r)))
  (local.set $ro (call $rec (local.get $o)))
  (block $object
    (if (i32.eq (call $kind (local.get $o)) (i32.const 1)) (then (call $jw_iri (local.get $w) (local.get $b) (i32.const 9) (local.get $o) (local.get $seq)) (br $object)))
    (if (i32.eq (call $kind (local.get $o)) (i32.const 2)) (then (call $ob_str (local.get $b) (i32.const 10) (i32.load offset=8 (local.get $ro)) (i32.load offset=12 (local.get $ro))) (br $object)))
    (local.set $start (call $ob_open (local.get $b)))
    (if (i32.eq (call $kind (local.get $o)) (i32.const 3))
      (then
        (if (i32.load offset=12 (local.get $ro)) (then (call $ob_str (local.get $b) (i32.const 1) (i32.load offset=8 (local.get $ro)) (i32.load offset=12 (local.get $ro)))))
        (local.set $dt (i32.load offset=16 (local.get $ro)))
        (if (i32.load offset=20 (local.get $ro))
          (then
            (call $ob_str (local.get $b) (i32.const 2) (i32.add (i32.load offset=8 (local.get $ro)) (i32.load offset=12 (local.get $ro))) (i32.load offset=20 (local.get $ro)))
            (call $ob_uint (local.get $b) (i32.const 4) (i32.load8_u offset=1 (local.get $ro))))
          (else (if (i32.ne (local.get $dt) (i32.const 2)) (then
            (call $ob_uint (local.get $b) (i32.const 3) (call $lru_get (i32.load offset=44 (local.get $w)) (i32.load offset=8 (call $rec (local.get $dt))) (i32.load offset=12 (call $rec (local.get $dt)))))))))
        (call $ob_close (local.get $b) (i32.const 11) (local.get $start)))
      (else
        (call $jw_tt (local.get $w) (local.get $b) (local.get $o) (local.get $seq))
        (call $ob_close (local.get $b) (i32.const 12) (local.get $start))))))

;; The term type of a run value: 0 IRI, 1 literal, 2 blank node, 3 triple term.
(func $jw_type (param $id i32) (result i32)
  (local $k i32)
  (local.set $k (call $kind (local.get $id)))
  (if (result i32) (i32.eq (local.get $k) (i32.const 1)) (then (i32.const 0))
    (else (if (result i32) (i32.eq (local.get $k) (i32.const 3)) (then (i32.const 1))
      (else (select (i32.const 2) (i32.const 3) (i32.eq (local.get $k) (i32.const 2))))))))

(func $jw_token (param $skip i32) (param $kind i32) (param $len i32)
  (local $code i32)
  (local.set $code (select (local.get $len) (i32.const 15) (i32.lt_u (local.get $len) (i32.const 15))))
  (call $v_push1 (global.get $wv_lay) (i32.add (i32.add (i32.shl (local.get $skip) (i32.const 5)) (i32.shl (local.get $kind) (i32.const 4))) (local.get $code)))
  (if (i32.eq (local.get $code) (i32.const 15)) (then (call $v_push1 (global.get $wv_lay) (i32.sub (local.get $len) (i32.const 15))))))

;; An RdfColumn of position c of the frame's statements, onto b.
(func $jw_column (param $w i32) (param $b i32) (param $c i32)
  (local $rows i32) (local $n i32) (local $i i32) (local $j i32) (local $v i32) (local $skip i32) (local $m i32) (local $t i32) (local $mixed i32)
  (local $k i32) (local $byte i32) (local $prev i32) (local $id i32) (local $r i32) (local $tag i32) (local $tn i32) (local $dir i32) (local $kind i32)
  (local $nl i32) (local $x i32) (local $any i32) (local $first i32)
  (local.set $rows (i32.load offset=48 (local.get $w)))
  (local.set $n (i32.shr_u (call $v_len (local.get $rows)) (i32.const 2)))
  (call $v_clear (global.get $wv_vals)) (call $v_clear (global.get $wv_lay)) (call $v_clear (global.get $wv_names))
  (call $v_clear (global.get $wv_prefs)) (call $v_clear (global.get $wv_tmp)) (call $v_clear (global.get $wv_kinds)) (call $v_clear (global.get $wv_langs))
  ;; runs
  (loop $runs (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (local.set $v (call $vw (local.get $rows) (i32.add (i32.shl (local.get $i) (i32.const 2)) (local.get $c))))
    (local.set $j (i32.add (local.get $i) (i32.const 1)))
    (loop $same (if (i32.and (i32.lt_u (local.get $j) (local.get $n)) (i32.eq (call $vw (local.get $rows) (i32.add (i32.shl (local.get $j) (i32.const 2)) (local.get $c))) (local.get $v))) (then
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $same))))
    (if (i32.eqz (local.get $v))
      (then (if (i32.lt_u (local.get $j) (local.get $n)) (then
        (call $jw_token (local.get $skip) (i32.const 1) (i32.sub (i32.sub (local.get $j) (local.get $i)) (i32.const 1)))
        (local.set $skip (i32.const 0)))))
      (else
        (call $v_push1 (global.get $wv_vals) (local.get $v))
        (if (i32.gt_u (i32.sub (local.get $j) (local.get $i)) (i32.const 1))
          (then
            (call $jw_token (local.get $skip) (i32.const 0) (i32.sub (i32.sub (local.get $j) (local.get $i)) (i32.const 2)))
            (local.set $skip (i32.const 0)))
          (else (local.set $skip (i32.add (local.get $skip) (i32.const 1)))))))
    (local.set $i (local.get $j))
    (br $runs))))
  (local.set $m (call $v_len (global.get $wv_vals)))
  ;; term types
  (local.set $first (call $jw_type (call $vw (global.get $wv_vals) (i32.const 0))))
  (local.set $i (i32.const 0))
  (loop $types (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (if (i32.ne (call $jw_type (call $vw (global.get $wv_vals) (local.get $i))) (local.get $first)) (then (local.set $mixed (i32.const 1))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $types))))
  (if (local.get $mixed) (then
    (local.set $k (i32.shr_u (i32.add (local.get $m) (i32.const 3)) (i32.const 2)))
    (call $ob_tag (local.get $b) (i32.const 1) (i32.const 2))
    (call $ob_varint (local.get $b) (local.get $k))
    (call $ob_room (local.get $b) (local.get $k))
    (local.set $i (i32.const 0))
    (loop $bytes (if (i32.lt_u (local.get $i) (local.get $m)) (then
      (local.set $byte (i32.or (local.get $byte) (i32.shl (call $jw_type (call $vw (global.get $wv_vals) (local.get $i))) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 1)))))
      (if (i32.or (i32.eq (i32.and (local.get $i) (i32.const 3)) (i32.const 3)) (i32.eq (i32.add (local.get $i) (i32.const 1)) (local.get $m))) (then
        (i32.store8 (call $ob_end (local.get $b)) (local.get $byte))
        (i32.store offset=4 (local.get $b) (i32.add (i32.load offset=4 (local.get $b)) (i32.const 1)))
        (local.set $byte (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bytes))))))
  (call $ob_packed (local.get $b) (i32.const 2) (i32.load (global.get $wv_lay)) (call $v_len (global.get $wv_lay)))
  ;; IRIs: one sequence
  (local.set $i (i32.const 0))
  (loop $iris (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $v (call $vw (global.get $wv_vals) (local.get $i)))
    (if (i32.eq (call $kind (local.get $v)) (i32.const 1)) (then
      (local.set $id (call $jw_name (local.get $w) (local.get $v)))
      (call $v_push1 (global.get $wv_names) (select (i32.const 0) (local.get $id) (i32.eq (local.get $id) (i32.add (local.get $prev) (i32.const 1)))))
      (local.set $prev (local.get $id))
      (if (i32.load offset=20 (local.get $w)) (then (call $v_push1 (global.get $wv_prefs) (global.get $jw_prefix))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $iris))))
  (call $ob_packed (local.get $b) (i32.const 3) (i32.load (global.get $wv_names)) (call $v_len (global.get $wv_names)))
  (if (local.tee $k (call $v_len (global.get $wv_prefs))) (then
    (local.set $x (call $vw (global.get $wv_prefs) (i32.const 0)))
    (local.set $any (i32.const 0))
    (local.set $i (i32.const 0))
    (loop $pf (if (i32.lt_u (local.get $i) (local.get $k)) (then
      (local.set $v (call $vw (global.get $wv_prefs) (local.get $i)))
      (if (i32.ne (local.get $v) (local.get $x)) (then (local.set $any (i32.const 1))))
      (call $v_push1 (global.get $wv_tmp) (select (i32.const 0) (local.get $v)
        (i32.and (i32.ne (local.get $i) (i32.const 0)) (i32.eq (local.get $v) (if (result i32) (local.get $i) (then (call $vw (global.get $wv_prefs) (i32.sub (local.get $i) (i32.const 1)))) (else (i32.const -1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pf))))
    (if (local.get $any)
      (then (call $ob_packed (local.get $b) (i32.const 4) (i32.load (global.get $wv_tmp)) (local.get $k)))
      (else (call $ob_packed (local.get $b) (i32.const 4) (i32.load (global.get $wv_prefs)) (i32.const 1))))))
  ;; literals
  (local.set $i (i32.const 0))
  (loop $lits (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $v (call $vw (global.get $wv_vals) (local.get $i)))
    (if (i32.eq (call $kind (local.get $v)) (i32.const 3)) (then
      (local.set $r (call $rec (local.get $v)))
      (block $kindof
        (if (local.tee $tn (i32.load offset=20 (local.get $r))) (then
          (local.set $tag (i32.add (i32.load offset=8 (local.get $r)) (i32.load offset=12 (local.get $r))))
          (local.set $dir (i32.load8_u offset=1 (local.get $r)))
          (local.set $nl (call $v_len (global.get $wv_langs)))
          (local.set $j (i32.const 0))
          (block $found
            (loop $find (if (i32.lt_u (local.get $j) (local.get $nl)) (then
              (local.set $x (call $rec (call $vw (global.get $wv_langs) (local.get $j))))
              (br_if $found (i32.and (i32.and (i32.eq (call $vw (global.get $wv_langs) (i32.add (local.get $j) (i32.const 1))) (local.get $dir))
                                              (i32.eq (i32.load offset=20 (local.get $x)) (local.get $tn)))
                                     (call $memeq (i32.add (i32.load offset=8 (local.get $x)) (i32.load offset=12 (local.get $x))) (local.get $tag) (local.get $tn))))
              (local.set $j (i32.add (local.get $j) (i32.const 2)))
              (br $find))))
            (call $v_push2 (global.get $wv_langs) (local.get $v) (local.get $dir)))
          (local.set $kind (i32.add (local.get $j) (i32.const 2)))
          (br $kindof)))
        (if (i32.eq (i32.load offset=16 (local.get $r)) (i32.const 2)) (then (local.set $kind (i32.const 0)) (br $kindof)))
        (local.set $x (call $rec (i32.load offset=16 (local.get $r))))
        (local.set $kind (i32.sub (i32.shl (call $lru_get (i32.load offset=44 (local.get $w)) (i32.load offset=8 (local.get $x)) (i32.load offset=12 (local.get $x))) (i32.const 1)) (i32.const 1))))
      (call $v_push1 (global.get $wv_kinds) (local.get $kind))
      (call $ob_str (local.get $b) (i32.const 5) (i32.load offset=8 (local.get $r)) (i32.load offset=12 (local.get $r)))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $lits))))
  (if (local.tee $k (call $v_len (global.get $wv_kinds))) (then
    (local.set $x (call $vw (global.get $wv_kinds) (i32.const 0)))
    (local.set $any (i32.const 0))
    (local.set $i (i32.const 0))
    (loop $kf (if (i32.lt_u (local.get $i) (local.get $k)) (then
      (if (i32.ne (call $vw (global.get $wv_kinds) (local.get $i)) (local.get $x)) (then (local.set $any (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $kf))))
    (if (local.get $any)
      (then (call $ob_packed (local.get $b) (i32.const 6) (i32.load (global.get $wv_kinds)) (local.get $k)))
      (else (if (local.get $x) (then (call $ob_packed (local.get $b) (i32.const 6) (i32.load (global.get $wv_kinds)) (i32.const 1))))))))
  (local.set $nl (call $v_len (global.get $wv_langs)))
  (local.set $any (i32.const 0))
  (local.set $j (i32.const 0))
  (loop $tags (if (i32.lt_u (local.get $j) (local.get $nl)) (then
    (local.set $x (call $rec (call $vw (global.get $wv_langs) (local.get $j))))
    (call $ob_str (local.get $b) (i32.const 7) (i32.add (i32.load offset=8 (local.get $x)) (i32.load offset=12 (local.get $x))) (i32.load offset=20 (local.get $x)))
    (if (call $vw (global.get $wv_langs) (i32.add (local.get $j) (i32.const 1))) (then (local.set $any (i32.const 1))))
    (local.set $j (i32.add (local.get $j) (i32.const 2)))
    (br $tags))))
  (if (local.get $any) (then
    (call $v_clear (global.get $wv_tmp))
    (local.set $j (i32.const 1))
    (loop $dirs (if (i32.lt_u (local.get $j) (local.get $nl)) (then
      (call $v_push1 (global.get $wv_tmp) (call $vw (global.get $wv_langs) (local.get $j)))
      (local.set $j (i32.add (local.get $j) (i32.const 2)))
      (br $dirs))))
    (call $ob_packed (local.get $b) (i32.const 8) (i32.load (global.get $wv_tmp)) (call $v_len (global.get $wv_tmp)))))
  ;; blank nodes
  (local.set $i (i32.const 0))
  (loop $bns (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $v (call $vw (global.get $wv_vals) (local.get $i)))
    (if (i32.eq (call $kind (local.get $v)) (i32.const 2)) (then
      (call $ob_str (local.get $b) (i32.const 9) (i32.load offset=8 (call $rec (local.get $v))) (i32.load offset=12 (call $rec (local.get $v))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $bns))))
  ;; triple terms: an IRI sequence of their own
  (i64.store (global.get $wseq) (i64.const 0))
  (local.set $i (i32.const 0))
  (loop $tts (if (i32.lt_u (local.get $i) (local.get $m)) (then
    (local.set $v (call $vw (global.get $wv_vals) (local.get $i)))
    (if (i32.eq (call $kind (local.get $v)) (i32.const 4)) (then
      (local.set $k (call $ob_open (local.get $b)))
      (call $jw_tt (local.get $w) (local.get $b) (local.get $v) (global.get $wseq))
      (call $ob_close (local.get $b) (i32.const 10) (local.get $k))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $tts)))))

;; The frame's statements and message ends, as a frame (the first with the stream options), delimited onto the output.
(func $jw_flush (param $w i32)
  (local $b i32) (local $frame i32) (local $row i32) (local $opts i32) (local $batch i32) (local $col i32) (local $c i32) (local $n i32)
  (local $ends i32) (local $i i32) (local $named i32) (local $rows i32)
  (local.set $rows (i32.load offset=48 (local.get $w)))
  (local.set $ends (i32.load offset=52 (local.get $w)))
  (local.set $n (i32.shr_u (call $v_len (local.get $rows)) (i32.const 2)))
  (if (i32.and (i32.and (i32.eqz (local.get $n)) (i32.ne (i32.load offset=32 (local.get $w)) (i32.const 0))) (i32.eqz (call $v_len (local.get $ends))))
    (then (return)))
  (local.set $b (i32.load offset=60 (local.get $w)))
  (local.set $frame (call $ob_open (local.get $b)))
  (if (i32.eqz (i32.load offset=32 (local.get $w))) (then
    (i32.store offset=32 (local.get $w) (i32.const 1))
    (local.set $row (call $ob_open (local.get $b)))
    (local.set $opts (call $ob_open (local.get $b)))
    (call $ob_uint (local.get $b) (i32.const 2) (i32.load offset=4 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 5) (i32.load offset=8 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 6) (i32.load offset=12 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 9) (i32.load offset=16 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 10) (i32.load offset=20 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 11) (i32.load offset=24 (local.get $w)))
    (call $ob_uint (local.get $b) (i32.const 15) (i32.const 3))
    (call $ob_close (local.get $b) (i32.const 1) (local.get $opts))
    (call $ob_close (local.get $b) (i32.const 1) (local.get $row))))
  (if (i32.or (local.get $n) (call $v_len (local.get $ends))) (then
    (local.set $batch (call $ob_open (local.get $b)))
    (call $ob_uint (local.get $b) (i32.const 1) (local.get $n))
    (call $lru_write (i32.load offset=36 (local.get $w)) (local.get $b) (i32.const 2))
    (call $lru_write (i32.load offset=40 (local.get $w)) (local.get $b) (i32.const 3))
    (call $lru_write (i32.load offset=44 (local.get $w)) (local.get $b) (i32.const 4))
    (if (local.get $n) (then
      (loop $cols
        (local.set $col (call $ob_open (local.get $b)))
        (call $jw_column (local.get $w) (local.get $b) (local.get $c))
        (call $ob_close (local.get $b) (i32.add (i32.const 6) (local.get $c)) (local.get $col))
        (br_if $cols (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 1))) (i32.const 3))))
      (if (i32.eq (i32.load offset=4 (local.get $w)) (i32.const 2)) (then
        (loop $g (if (i32.lt_u (local.get $i) (local.get $n)) (then
          (if (call $vw (local.get $rows) (i32.add (i32.shl (local.get $i) (i32.const 2)) (i32.const 3))) (then (local.set $named (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $g))))
        (if (local.get $named) (then
          (local.set $col (call $ob_open (local.get $b)))
          (call $jw_column (local.get $w) (local.get $b) (i32.const 3))
          (call $ob_close (local.get $b) (i32.const 9) (local.get $col))))))))
    (call $ob_packed (local.get $b) (i32.const 15) (i32.load (local.get $ends)) (call $v_len (local.get $ends)))
    (call $ob_close (local.get $b) (i32.const 2) (local.get $batch))))
  (call $ob_close (local.get $b) (i32.const 0) (local.get $frame))
  (call $v_clear (local.get $rows))
  (call $v_clear (local.get $ends))
  (i32.store offset=56 (local.get $w) (i32.const 0))
  (call $lru_end (i32.load offset=36 (local.get $w)))
  (call $lru_end (i32.load offset=40 (local.get $w)))
  (call $lru_end (i32.load offset=44 (local.get $w))))

;; --- the exports (ABI.md "Jelly") -------------------------------------------------------

(func $jhandle (param $x i32) (result i32)
  (local $i i32) (local $n i32)
  (local.set $n (call $v_len (global.get $jhs)))
  (loop $free (if (i32.lt_u (local.get $i) (local.get $n)) (then
    (if (i32.eqz (call $vw (global.get $jhs) (local.get $i))) (then
      (i32.store (call $v_addr (global.get $jhs) (local.get $i)) (local.get $x))
      (return (i32.add (local.get $i) (i32.const 1)))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $free))))
  (call $v_push1 (global.get $jhs) (local.get $x))
  (call $v_len (global.get $jhs)))

;; The record of handle h if it is of `kind` (1 reader, 2 writer), else 0.
(func $jrecord (param $h i32) (param $kind i32) (result i32)
  (local $x i32)
  (if (i32.or (i32.eqz (local.get $h)) (i32.gt_u (local.get $h) (call $v_len (global.get $jhs)))) (then (return (i32.const 0))))
  (if (i32.eqz (local.tee $x (call $vw (global.get $jhs) (i32.sub (local.get $h) (i32.const 1))))) (then (return (i32.const 0))))
  (select (local.get $x) (i32.const 0) (i32.eq (i32.load (local.get $x)) (local.get $kind))))

(func (export "jelly_reader") (param $graph i32) (result i32)
  (call $jhandle (call $jr_new (local.get $graph))))

(func (export "jelly_frame") (param $h i32) (param $len i32) (param $mode i32) (result i32)
  (local $r i32) (local $n i32) (local $q i32) (local $end i32)
  (if (i32.eqz (local.tee $r (call $jrecord (local.get $h) (i32.const 1)))) (then (return (call $fail (@str "not a Jelly reader")))))
  (if (i32.load offset=8 (local.get $r)) (then (return (call $fail (@str "the stream failed earlier")))))
  (global.set $jbad (i32.const 0))
  (global.set $qb_len (i32.const 0))
  (call $jr_frame (local.get $r) (global.get $in) (local.get $len))
  (if (global.get $jbad) (then
    (i32.store offset=8 (local.get $r) (i32.const 1))
    (call $v_clear (i32.load offset=136 (local.get $r)))
    (return (i32.const -1))))
  (local.set $n (i32.shr_u (global.get $qb_len) (i32.const 4)))
  (if (i32.and (local.get $mode) (i32.const 1)) (then
    (call $quads_reserve (i32.add (global.get $qn) (local.get $n)))
    (local.set $q (global.get $qb))
    (local.set $end (i32.add (global.get $qb) (global.get $qb_len)))
    (loop $each (if (i32.lt_u (local.get $q) (local.get $end)) (then
      (drop (call $add (i32.load (local.get $q)) (i32.load offset=4 (local.get $q)) (i32.load offset=8 (local.get $q)) (i32.load offset=12 (local.get $q))))
      (local.set $q (i32.add (local.get $q) (i32.const 16)))
      (br $each))))))
  (if (i32.and (local.get $mode) (i32.const 2)) (then
    (call $res_reserve (global.get $qb_len))
    (memory.copy (global.get $res) (global.get $qb) (global.get $qb_len))))
  (local.get $n))

(func (export "jelly_ends") (param $h i32) (result i32)
  (local $r i32) (local $v i32)
  (if (i32.eqz (local.tee $r (call $jrecord (local.get $h) (i32.const 1)))) (then (return (call $fail (@str "not a Jelly reader")))))
  (local.set $v (i32.load offset=136 (local.get $r)))
  (call $res_reserve (i32.shl (call $v_len (local.get $v)) (i32.const 2)))
  (memory.copy (global.get $res) (i32.load (local.get $v)) (i32.shl (call $v_len (local.get $v)) (i32.const 2)))
  (call $v_len (local.get $v)))

(func (export "jelly_finish") (param $h i32) (result i32)
  (local $r i32)
  (if (i32.eqz (local.tee $r (call $jrecord (local.get $h) (i32.const 1)))) (then (return (call $fail (@str "not a Jelly reader")))))
  (if (i32.eqz (i32.load offset=120 (local.get $r))) (then (return (i32.const 0))))
  (i32.store offset=120 (local.get $r) (i32.const 0))
  (i32.store offset=116 (local.get $r) (i32.add (i32.load offset=116 (local.get $r)) (i32.const 1)))
  (call $jr_blanks_clear (local.get $r))
  (i32.const 1))

(func (export "jelly_writer") (param $physical i32) (param $st i32) (param $rv i32) (param $m0 i32) (param $m1 i32) (param $m2 i32) (param $rows i32) (result i32)
  (local $w i32)
  (if (i32.lt_s (local.tee $w (call $jw_new (local.get $physical) (local.get $st) (local.get $rv) (local.get $m0) (local.get $m1) (local.get $m2) (local.get $rows))) (i32.const 0))
    (then (return (i32.const -1))))
  (call $jhandle (local.get $w)))

;; The writer's output (delimited frames) to the result buffer; returns its length.
(func $jw_result (param $w i32) (result i32)
  (local $b i32) (local $n i32)
  (local.set $b (i32.load offset=60 (local.get $w)))
  (local.set $n (i32.load offset=4 (local.get $b)))
  (call $res_reserve (local.get $n))
  (memory.copy (global.get $res) (i32.load (local.get $b)) (local.get $n))
  (i32.store offset=4 (local.get $b) (i32.const 0))
  (local.get $n))

(func (export "jelly_write") (param $h i32) (param $count i32) (result i32)
  (local $w i32) (local $q i32) (local $end i32)
  (if (i32.eqz (local.tee $w (call $jrecord (local.get $h) (i32.const 2)))) (then (return (call $fail (@str "not a Jelly writer")))))
  (global.set $jbad (i32.const 0))
  (i32.store offset=4 (i32.load offset=60 (local.get $w)) (i32.const 0))
  (local.set $q (global.get $in))
  (local.set $end (i32.add (local.get $q) (i32.shl (local.get $count) (i32.const 4))))
  (loop $each (if (i32.lt_u (local.get $q) (local.get $end)) (then
    (call $jw_add (local.get $w) (i32.load (local.get $q)) (i32.load offset=4 (local.get $q)) (i32.load offset=8 (local.get $q)) (i32.load offset=12 (local.get $q)))
    (if (global.get $jbad) (then (return (i32.const -1))))
    (local.set $q (i32.add (local.get $q) (i32.const 16)))
    (br $each))))
  (call $jw_result (local.get $w)))

(func (export "jelly_message") (param $h i32) (result i32)
  (local $w i32) (local $n i32)
  (if (i32.eqz (local.tee $w (call $jrecord (local.get $h) (i32.const 2)))) (then (return (call $fail (@str "not a Jelly writer")))))
  (if (i32.ne (i32.load offset=8 (local.get $w)) (i32.const 1)) (then (return (call $fail (@str "message boundaries in a FLAT stream")))))
  (local.set $n (i32.shr_u (call $v_len (i32.load offset=48 (local.get $w))) (i32.const 2)))
  (call $v_push1 (i32.load offset=52 (local.get $w)) (i32.sub (local.get $n) (i32.load offset=56 (local.get $w))))
  (i32.store offset=56 (local.get $w) (local.get $n))
  (i32.const 0))

(func (export "jelly_flush") (param $h i32) (result i32)
  (local $w i32)
  (if (i32.eqz (local.tee $w (call $jrecord (local.get $h) (i32.const 2)))) (then (return (call $fail (@str "not a Jelly writer")))))
  (i32.store offset=4 (i32.load offset=60 (local.get $w)) (i32.const 0))
  (call $jw_flush (local.get $w))
  (call $jw_result (local.get $w)))

(func (export "jelly_release") (param $h i32)
  (local $x i32)
  (if (i32.or (i32.eqz (local.get $h)) (i32.gt_u (local.get $h) (call $v_len (global.get $jhs)))) (then (return)))
  (if (i32.eqz (local.tee $x (call $vw (global.get $jhs) (i32.sub (local.get $h) (i32.const 1))))) (then (return)))
  (if (i32.eq (i32.load (local.get $x)) (i32.const 1)) (then (call $jr_free (local.get $x))) (else (call $jw_free (local.get $x))))
  (i32.store (call $v_addr (global.get $jhs) (i32.sub (local.get $h) (i32.const 1))) (i32.const 0)))

;; load, format 5: a whole stream, all or nothing.
(func $jelly_load (param $len i32) (param $graph i32) (result i32)
  (local $r i32) (local $q i32) (local $end i32) (local $n i32)
  (global.set $jbad (i32.const 0))
  (global.set $qb_len (i32.const 0))
  (local.set $r (call $jr_new (local.get $graph)))
  (call $jelly_stream (local.get $r) (global.get $in) (local.get $len))
  (call $jr_free (local.get $r))
  (if (global.get $jbad) (then (return (i32.const -1))))
  (local.set $n (i32.shr_u (global.get $qb_len) (i32.const 4)))
  (call $quads_reserve (i32.add (global.get $qn) (local.get $n)))
  (local.set $q (global.get $qb))
  (local.set $end (i32.add (global.get $qb) (global.get $qb_len)))
  (loop $each (if (i32.lt_u (local.get $q) (local.get $end)) (then
    (drop (call $add (i32.load (local.get $q)) (i32.load offset=4 (local.get $q)) (i32.load offset=8 (local.get $q)) (i32.load offset=12 (local.get $q))))
    (local.set $q (i32.add (local.get $q) (i32.const 16)))
    (br $each))))
  (local.get $n))

;; collect: the term ids readers and writers hold, marked; the readers' caches of term ids dropped.
(func $jelly_mark
  (local $i i32) (local $x i32) (local $k i32) (local $t i32) (local $e i32) (local $end i32) (local $j i32) (local $v i32)
  (loop $handles (if (i32.lt_u (local.get $i) (call $v_len (global.get $jhs))) (then
    (if (local.tee $x (call $vw (global.get $jhs) (local.get $i))) (then
      (if (i32.eq (i32.load (local.get $x)) (i32.const 1))
        (then
          (local.set $k (i32.const 0))
          (loop $tables
            (local.set $t (i32.add (local.get $x) (i32.add (i32.const 48) (i32.shl (local.get $k) (i32.const 3)))))
            (if (i32.load (local.get $t)) (then
              (local.set $e (i32.load (local.get $t)))
              (local.set $end (i32.add (local.get $e) (i32.mul (i32.load offset=4 (local.get $t)) (i32.const 24))))
              (loop $entries (if (i32.lt_u (local.get $e) (local.get $end)) (then
                (i32.store offset=20 (local.get $e) (i32.const 0))
                (local.set $e (i32.add (local.get $e) (i32.const 24)))
                (br $entries))))))
            (br_if $tables (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 3))))
          (call $mark (i32.load offset=96 (local.get $x)))
          (call $mark (i32.load offset=100 (local.get $x)))
          (call $mark (i32.load offset=104 (local.get $x)))
          (call $mark (i32.load offset=108 (local.get $x)))
          (call $mark (i32.load offset=112 (local.get $x)))
          (if (i32.load offset=124 (local.get $x)) (then
            (local.set $e (i32.load offset=124 (local.get $x)))
            (local.set $end (i32.add (local.get $e) (i32.shl (i32.load offset=128 (local.get $x)) (i32.const 4))))
            (loop $blanks (if (i32.lt_u (local.get $e) (local.get $end)) (then
              (if (i32.load offset=12 (local.get $e)) (then (call $mark (i32.load offset=12 (local.get $e)))))
              (local.set $e (i32.add (local.get $e) (i32.const 16)))
              (br $blanks)))))))
        (else
          (local.set $v (i32.load offset=48 (local.get $x)))
          (local.set $j (i32.const 0))
          (loop $rows (if (i32.lt_u (local.get $j) (call $v_len (local.get $v))) (then
            (call $mark (call $vw (local.get $v) (local.get $j)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $rows))))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $handles)))))
