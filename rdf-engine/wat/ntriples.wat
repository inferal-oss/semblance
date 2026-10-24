;; N-Triples and N-Quads (RDF 1.2): parse the input buffer and load it.
;;
;; The parser reads [$p, $end). Escapes are decoded in place: a decoded IRI or
;; string is never longer than its source, so it is written over the source
;; bytes it came from and interned from there. Parsing functions return a term
;; id, or 0 after setting the error. Quads are buffered and only added once the
;; whole document has parsed, so a syntax error adds nothing.

(global $p (mut i32) (i32.const 0))
(global $end (mut i32) (i32.const 0))
(global $line (mut i32) (i32.const 0))
(global $cplen (mut i32) (i32.const 0))   ;; set by $decode: bytes in the code point

;; Buffered quads: 16 bytes each.
(global $qb (mut i32) (i32.const 0))
(global $qb_cap (mut i32) (i32.const 0))  ;; bytes
(global $qb_len (mut i32) (i32.const 0))  ;; bytes

;; Blank node labels of the document: label -> node. 16-byte entries:
;; hash, label ptr (into the input), label len, id (0 = empty).
(global $sc (mut i32) (i32.const 0))
(global $sc_cap (mut i32) (i32.const 0))
(global $sc_n (mut i32) (i32.const 0))

;; A syntax error: "line N: msg". Returns 0.
(func $syntax (param $msg i32) (param $n i32) (result i32)
  (local $w i32)
  (i64.store (global.get $errbuf) (i64.const 0x20656e696c))   ;; "line "
  (local.set $w (call $utoa (i32.add (global.get $errbuf) (i32.const 5)) (global.get $line)))
  (i32.store16 (local.get $w) (i32.const 0x203a))              ;; ": "
  (memory.copy (i32.add (local.get $w) (i32.const 2)) (local.get $msg) (local.get $n))
  (drop (call $fail (global.get $errbuf) (i32.sub (i32.add (i32.add (local.get $w) (i32.const 2)) (local.get $n)) (global.get $errbuf))))
  (i32.const 0))

(func $peek (result i32)
  (if (result i32) (i32.lt_u (global.get $p) (global.get $end))
    (then (i32.load8_u (global.get $p)))
    (else (i32.const -1))))

(func $peek_at (param $off i32) (result i32)
  (local $at i32)
  (if (result i32) (i32.lt_u (local.tee $at (i32.add (global.get $p) (local.get $off))) (global.get $end))
    (then (i32.load8_u (local.get $at)))
    (else (i32.const -1))))

;; Whether the input at $p starts with the n bytes at s.
(func $starts (param $s i32) (param $n i32) (result i32)
  (if (result i32) (i32.le_u (local.get $n) (i32.sub (global.get $end) (global.get $p)))
    (then (call $memeq (global.get $p) (local.get $s) (local.get $n)))
    (else (i32.const 0))))

;; Skip spaces and tabs.
(func $ws
  (local $c i32)
  (loop $l
    (local.set $c (call $peek))
    (if (i32.or (i32.eq (local.get $c) (i32.const ' ')) (i32.eq (local.get $c) (i32.const '\t'))) (then
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (br $l)))))

;; Skip spaces, tabs and a comment up to the end of the line.
(func $ws_comment
  (local $c i32)
  (call $ws)
  (if (i32.eq (call $peek) (i32.const '#')) (then
    (loop $l
      (local.set $c (call $peek))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 0))
                   (i32.and (i32.ne (local.get $c) (i32.const '\n')) (i32.ne (local.get $c) (i32.const '\r')))) (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $l)))))))

;; The code point of the UTF-8 sequence at p (valid UTF-8: the host encodes
;; it); its length goes to $cplen.
(func $decode (param $p i32) (result i32)
  (local $c i32)
  (local.set $c (i32.load8_u (local.get $p)))
  (if (i32.lt_u (local.get $c) (i32.const 0x80)) (then (global.set $cplen (i32.const 1)) (return (local.get $c))))
  (if (i32.lt_u (local.get $c) (i32.const 0xe0)) (then
    (global.set $cplen (i32.const 2))
    (return (i32.or (i32.shl (i32.and (local.get $c) (i32.const 0x1f)) (i32.const 6))
                    (i32.and (i32.load8_u offset=1 (local.get $p)) (i32.const 0x3f))))))
  (if (i32.lt_u (local.get $c) (i32.const 0xf0)) (then
    (global.set $cplen (i32.const 3))
    (return (i32.or (i32.or (i32.shl (i32.and (local.get $c) (i32.const 0x0f)) (i32.const 12))
                            (i32.shl (i32.and (i32.load8_u offset=1 (local.get $p)) (i32.const 0x3f)) (i32.const 6)))
                    (i32.and (i32.load8_u offset=2 (local.get $p)) (i32.const 0x3f))))))
  (global.set $cplen (i32.const 4))
  (i32.or (i32.or (i32.shl (i32.and (local.get $c) (i32.const 0x07)) (i32.const 18))
                  (i32.shl (i32.and (i32.load8_u offset=1 (local.get $p)) (i32.const 0x3f)) (i32.const 12)))
          (i32.or (i32.shl (i32.and (i32.load8_u offset=2 (local.get $p)) (i32.const 0x3f)) (i32.const 6))
                  (i32.and (i32.load8_u offset=3 (local.get $p)) (i32.const 0x3f)))))

;; Write code point cp as UTF-8 at w; returns the end.
(func $encode (param $w i32) (param $cp i32) (result i32)
  (if (i32.lt_u (local.get $cp) (i32.const 0x80)) (then
    (i32.store8 (local.get $w) (local.get $cp))
    (return (i32.add (local.get $w) (i32.const 1)))))
  (if (i32.lt_u (local.get $cp) (i32.const 0x800)) (then
    (i32.store8 (local.get $w) (i32.or (i32.const 0xc0) (i32.shr_u (local.get $cp) (i32.const 6))))
    (i32.store8 offset=1 (local.get $w) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3f))))
    (return (i32.add (local.get $w) (i32.const 2)))))
  (if (i32.lt_u (local.get $cp) (i32.const 0x10000)) (then
    (i32.store8 (local.get $w) (i32.or (i32.const 0xe0) (i32.shr_u (local.get $cp) (i32.const 12))))
    (i32.store8 offset=1 (local.get $w) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3f))))
    (i32.store8 offset=2 (local.get $w) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3f))))
    (return (i32.add (local.get $w) (i32.const 3)))))
  (i32.store8 (local.get $w) (i32.or (i32.const 0xf0) (i32.shr_u (local.get $cp) (i32.const 18))))
  (i32.store8 offset=1 (local.get $w) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3f))))
  (i32.store8 offset=2 (local.get $w) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3f))))
  (i32.store8 offset=3 (local.get $w) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3f))))
  (i32.add (local.get $w) (i32.const 4)))

(func $is_digit (param $c i32) (result i32)
  (i32.lt_u (i32.sub (local.get $c) (i32.const '0')) (i32.const 10)))

(func $is_alpha (param $c i32) (result i32)
  (i32.lt_u (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 'a')) (i32.const 26)))

;; $p is at the 'u' or 'U' of a UCHAR: the code point, or -1 after an error.
(func $uchar (result i32)
  (local $n i32) (local $cp i32) (local $c i32)
  (local.set $n (select (i32.const 4) (i32.const 8) (i32.eq (call $peek) (i32.const 'u'))))
  (loop $hex
    (global.set $p (i32.add (global.get $p) (i32.const 1)))
    (local.set $c (call $peek))
    (if (call $is_digit (local.get $c))
      (then (local.set $c (i32.sub (local.get $c) (i32.const '0'))))
      (else
        (if (i32.lt_u (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 'a')) (i32.const 6))
          (then (local.set $c (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 87))))
          (else (drop (call $syntax (@str "bad hex digit in escape"))) (return (i32.const -1))))))
    (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 4)) (local.get $c)))
    (br_if $hex (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (global.set $p (i32.add (global.get $p) (i32.const 1)))
  (if (i32.or (i32.gt_u (local.get $cp) (i32.const 0x10ffff))
              (i32.eq (i32.and (local.get $cp) (i32.const 0xfffff800)) (i32.const 0xd800)))
    (then (drop (call $syntax (@str "escape is not a Unicode scalar value"))) (return (i32.const -1))))
  (local.get $cp))

;; Characters IRIREF excludes: controls, space, <>"{}|^`\
(func $iri_bad (param $c i32) (result i32)
  (if (result i32) (i32.lt_u (local.get $c) (i32.const 64))
    (then (i32.wrap_i64 (i64.and (i64.shr_u (i64.const 0x5000000500000000 ) (i64.extend_i32_u (local.get $c))) (i64.const 1))))
    (else (if (result i32) (i32.lt_u (local.get $c) (i32.const 128))
      (then (i32.wrap_i64 (i64.and (i64.shr_u (i64.const 0x3800000150000000) (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 64)))) (i64.const 1))))
      (else (i32.const 0))))))

;; IRIREF at $p (on '<'); must be absolute.
(func $iri (result i32)
  (local $start i32) (local $w i32) (local $c i32) (local $q i32)
  (global.set $p (i32.add (global.get $p) (i32.const 1)))
  (local.set $start (global.get $p))
  (local.set $w (global.get $p))
  (block $done
    (loop $chars
      (local.set $c (call $peek))
      (br_if $done (i32.eq (local.get $c) (i32.const '>')))
      (if (i32.lt_s (local.get $c) (i32.const 0)) (then (return (call $syntax (@str "unterminated IRI")))))
      (if (i32.eq (local.get $c) (i32.const '\\')) (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (local.set $c (call $peek))
        (if (i32.eqz (i32.or (i32.eq (local.get $c) (i32.const 'u')) (i32.eq (local.get $c) (i32.const 'U'))))
          (then (return (call $syntax (@str "bad escape in IRI")))))
        (if (i32.lt_s (local.tee $c (call $uchar)) (i32.const 0)) (then (return (i32.const 0))))
        (if (i32.or (i32.le_u (local.get $c) (i32.const 0x20)) (call $iri_bad (local.get $c)))
          (then (return (call $syntax (@str "bad character in IRI")))))
        (local.set $w (call $encode (local.get $w) (local.get $c)))
        (br $chars)))
      (if (i32.or (i32.le_u (local.get $c) (i32.const 0x20)) (call $iri_bad (local.get $c)))
        (then (return (call $syntax (@str "bad character in IRI")))))
      (i32.store8 (local.get $w) (local.get $c))
      (local.set $w (i32.add (local.get $w) (i32.const 1)))
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (br $chars)))
  (global.set $p (i32.add (global.get $p) (i32.const 1)))
  ;; absolute: scheme ":" where scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
  (local.set $q (local.get $start))
  (block $relative
    (br_if $relative (i32.or (i32.eq (local.get $q) (local.get $w)) (i32.eqz (call $is_alpha (i32.load8_u (local.get $q))))))
    (loop $scheme
      (local.set $q (i32.add (local.get $q) (i32.const 1)))
      (br_if $relative (i32.eq (local.get $q) (local.get $w)))
      (local.set $c (i32.load8_u (local.get $q)))
      (if (i32.eq (local.get $c) (i32.const ':'))
        (then (return (call $intern (i32.const 1) (local.get $start) (i32.sub (local.get $w) (local.get $start))
                                    (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))))
      (br_if $scheme (i32.or (i32.or (call $is_alpha (local.get $c)) (call $is_digit (local.get $c)))
                             (i32.or (i32.eq (local.get $c) (i32.const '+'))
                                     (i32.or (i32.eq (local.get $c) (i32.const '-')) (i32.eq (local.get $c) (i32.const '.'))))))))
  (call $syntax (@str "relative IRI")))

(func $in (param $c i32) (param $lo i32) (param $hi i32) (result i32)
  (i32.le_u (i32.sub (local.get $c) (local.get $lo)) (i32.sub (local.get $hi) (local.get $lo))))

;; PN_CHARS_U: PN_CHARS_BASE or '_'.
(func $pn_u (param $c i32) (result i32)
  (if (i32.or (call $is_alpha (local.get $c)) (i32.eq (local.get $c) (i32.const '_'))) (then (return (i32.const 1))))
  (if (i32.lt_u (local.get $c) (i32.const 0xc0)) (then (return (i32.const 0))))
  (i32.or
    (i32.or
      (i32.or (i32.or (call $in (local.get $c) (i32.const 0xc0) (i32.const 0xd6)) (call $in (local.get $c) (i32.const 0xd8) (i32.const 0xf6)))
              (i32.or (call $in (local.get $c) (i32.const 0xf8) (i32.const 0x2ff)) (call $in (local.get $c) (i32.const 0x370) (i32.const 0x37d))))
      (i32.or (i32.or (call $in (local.get $c) (i32.const 0x37f) (i32.const 0x1fff)) (call $in (local.get $c) (i32.const 0x200c) (i32.const 0x200d)))
              (i32.or (call $in (local.get $c) (i32.const 0x2070) (i32.const 0x218f)) (call $in (local.get $c) (i32.const 0x2c00) (i32.const 0x2fef)))))
    (i32.or
      (i32.or (call $in (local.get $c) (i32.const 0x3001) (i32.const 0xd7ff)) (call $in (local.get $c) (i32.const 0xf900) (i32.const 0xfdcf)))
      (i32.or (call $in (local.get $c) (i32.const 0xfdf0) (i32.const 0xfffd)) (call $in (local.get $c) (i32.const 0x10000) (i32.const 0xeffff))))))

;; PN_CHARS: PN_CHARS_U, '-', digits, U+00B7, U+0300-036F, U+203F-2040.
(func $pn_chars (param $c i32) (result i32)
  (i32.or
    (i32.or (call $pn_u (local.get $c)) (i32.or (i32.eq (local.get $c) (i32.const '-')) (call $is_digit (local.get $c))))
    (i32.or (i32.eq (local.get $c) (i32.const 0xb7))
            (i32.or (call $in (local.get $c) (i32.const 0x300) (i32.const 0x36f)) (call $in (local.get $c) (i32.const 0x203f) (i32.const 0x2040))))))

;; BLANK_NODE_LABEL at $p (on '_'): the document's node for that label.
(func $bnode (result i32)
  (local $start i32) (local $last i32) (local $c i32)
  (if (i32.ne (call $peek_at (i32.const 1)) (i32.const ':')) (then (return (call $syntax (@str "expected ':' after '_'")))))
  (local.set $start (i32.add (global.get $p) (i32.const 2)))
  (if (i32.ge_u (local.get $start) (global.get $end)) (then (return (call $syntax (@str "bad blank node label")))))
  (local.set $c (call $decode (local.get $start)))
  (if (i32.eqz (i32.or (call $pn_u (local.get $c)) (call $is_digit (local.get $c))))
    (then (return (call $syntax (@str "bad blank node label")))))
  ;; then (PN_CHARS | '.')*, not ending in '.'
  (global.set $p (local.tee $last (i32.add (local.get $start) (global.get $cplen))))
  (block $done
    (loop $chars
      (br_if $done (i32.ge_u (global.get $p) (global.get $end)))
      (if (i32.eq (i32.load8_u (global.get $p)) (i32.const '.')) (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $chars)))
      (br_if $done (i32.eqz (call $pn_chars (call $decode (global.get $p)))))
      (global.set $p (local.tee $last (i32.add (global.get $p) (global.get $cplen))))
      (br $chars)))
  (global.set $p (local.get $last))
  (call $scope (local.get $start) (i32.sub (local.get $last) (local.get $start))))

;; The document's blank node for a label, made on first use.
(func $scope (param $ptr i32) (param $n i32) (result i32)
  (local $h i32) (local $i i32) (local $e i32) (local $id i32)
  (if (i32.eqz (global.get $sc)) (then
    (global.set $sc_cap (i32.const 64))
    (global.set $sc (call $alloc0 (i32.const 1024)))))
  (local.set $h (call $fmix (call $hash_bytes (i32.const 2) (local.get $ptr) (local.get $n))))
  (local.set $i (local.get $h))
  (loop $probe
    (local.set $e (i32.add (global.get $sc) (i32.shl (i32.and (local.get $i) (i32.sub (global.get $sc_cap) (i32.const 1))) (i32.const 4))))
    (if (local.tee $id (i32.load offset=12 (local.get $e))) (then
      (if (i32.and (i32.eq (i32.load (local.get $e)) (local.get $h)) (i32.eq (i32.load offset=8 (local.get $e)) (local.get $n))) (then
        (if (call $memeq (i32.load offset=4 (local.get $e)) (local.get $ptr) (local.get $n)) (then (return (local.get $id))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $probe))))
  (i32.store (local.get $e) (local.get $h))
  (i32.store offset=4 (local.get $e) (local.get $ptr))
  (i32.store offset=8 (local.get $e) (local.get $n))
  (i32.store offset=12 (local.get $e) (local.tee $id (call $fresh_bnode)))
  (global.set $sc_n (i32.add (global.get $sc_n) (i32.const 1)))
  (if (i32.gt_u (i32.shl (global.get $sc_n) (i32.const 1)) (global.get $sc_cap)) (then (call $scope_grow)))
  (local.get $id))

(func $scope_grow
  (local $old i32) (local $n i32) (local $e i32) (local $f i32) (local $i i32) (local $mask i32)
  (local.set $old (global.get $sc))
  (local.set $n (global.get $sc_cap))
  (global.set $sc_cap (i32.shl (local.get $n) (i32.const 1)))
  (global.set $sc (call $alloc0 (i32.shl (global.get $sc_cap) (i32.const 4))))
  (local.set $mask (i32.sub (global.get $sc_cap) (i32.const 1)))
  (local.set $e (local.get $old))
  (loop $each
    (if (i32.load offset=12 (local.get $e)) (then
      (local.set $i (i32.load (local.get $e)))
      (loop $probe
        (local.set $f (i32.add (global.get $sc) (i32.shl (i32.and (local.get $i) (local.get $mask)) (i32.const 4))))
        (if (i32.load offset=12 (local.get $f)) (then
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $probe))))
      (memory.copy (local.get $f) (local.get $e) (i32.const 16))))
    (br_if $each (i32.lt_u (local.tee $e (i32.add (local.get $e) (i32.const 16)))
                           (i32.add (local.get $old) (i32.shl (local.get $n) (i32.const 4))))))
  (call $free (local.get $old) (i32.shl (local.get $n) (i32.const 4))))


;; LANG_DIR at $p (on '@'); then the literal whose value is n bytes at v.
(func $lang_literal (param $v i32) (param $n i32) (result i32)
  (local $tag i32) (local $k i32) (local $first i32) (local $len i32) (local $dir i32)
  (local.set $tag (i32.add (global.get $p) (i32.const 1)))
  (local.set $first (i32.const 1))
  ;; [a-zA-Z]{1,8} ('-' [a-zA-Z0-9]{1,8})*
  (loop $subtag
    (global.set $p (i32.add (global.get $p) (i32.const 1)))
    (local.set $k (global.get $p))
    (loop $chars
      (if (i32.or (call $is_alpha (call $peek)) (i32.and (i32.eqz (local.get $first)) (call $is_digit (call $peek)))) (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (br $chars))))
    (if (i32.gt_u (i32.sub (i32.sub (global.get $p) (local.get $k)) (i32.const 1)) (i32.const 7))
      (then (return (call $syntax (@str "bad language tag")))))
    (local.set $first (i32.const 0))
    (br_if $subtag (i32.and (i32.eq (call $peek) (i32.const '-')) (i32.ne (call $peek_at (i32.const 1)) (i32.const '-')))))
  (local.set $len (i32.sub (global.get $p) (local.get $tag)))
  ;; ('--' ('ltr' | 'rtl'))?
  (if (i32.eq (call $peek) (i32.const '-')) (then
    (global.set $p (i32.add (global.get $p) (i32.const 2)))
    (if (call $starts (@str "ltr")) (then (local.set $dir (i32.const 1))))
    (if (call $starts (@str "rtl")) (then (local.set $dir (i32.const 2))))
    (global.set $p (i32.add (global.get $p) (i32.const 3)))
    (if (i32.or (i32.eqz (local.get $dir)) (i32.or (call $is_alpha (call $peek)) (call $is_digit (call $peek))))
      (then (return (call $syntax (@str "bad direction: expected ltr or rtl")))))))
  (call $lower (local.get $tag) (local.get $len))
  (call $intern (i32.or (i32.const 3) (i32.shl (local.get $dir) (i32.const 8))) (local.get $v) (local.get $n)
                (select (i32.const 4) (i32.const 3) (local.get $dir)) (local.get $tag) (local.get $len) (i32.const 1)))

;; The character an ECHAR stands for (c follows the backslash), or -1.
(func $echar (param $c i32) (result i32)
  (if (i32.eq (local.get $c) (i32.const 't')) (then (return (i32.const 9))))
  (if (i32.eq (local.get $c) (i32.const 'b')) (then (return (i32.const 8))))
  (if (i32.eq (local.get $c) (i32.const 'n')) (then (return (i32.const 10))))
  (if (i32.eq (local.get $c) (i32.const 'r')) (then (return (i32.const 13))))
  (if (i32.eq (local.get $c) (i32.const 'f')) (then (return (i32.const 12))))
  (if (i32.or (i32.eq (local.get $c) (i32.const '"'))
              (i32.or (i32.eq (local.get $c) (i32.const '\'')) (i32.eq (local.get $c) (i32.const '\\'))))
    (then (return (local.get $c))))
  (i32.const -1))

;; STRING_LITERAL_QUOTE at $p (on '"'), decoded in place to
;; [$str, $str + $str_len). Returns 0 after an error.
(global $str (mut i32) (i32.const 0))
(global $str_len (mut i32) (i32.const 0))
(func $string (result i32)
  (local $w i32) (local $c i32)
  (global.set $p (i32.add (global.get $p) (i32.const 1)))
  (global.set $str (global.get $p))
  (local.set $w (global.get $p))
  (block $done
    (loop $chars
      (local.set $c (call $peek))
      (br_if $done (i32.eq (local.get $c) (i32.const '"')))
      (if (i32.lt_s (local.get $c) (i32.const 0)) (then (return (call $syntax (@str "unterminated string")))))
      (if (i32.or (i32.eq (local.get $c) (i32.const '\n')) (i32.eq (local.get $c) (i32.const '\r')))
        (then (return (call $syntax (@str "line break in string")))))
      (if (i32.eq (local.get $c) (i32.const '\\')) (then
        (global.set $p (i32.add (global.get $p) (i32.const 1)))
        (local.set $c (call $peek))
        (if (i32.or (i32.eq (local.get $c) (i32.const 'u')) (i32.eq (local.get $c) (i32.const 'U'))) (then
          (if (i32.lt_s (local.tee $c (call $uchar)) (i32.const 0)) (then (return (i32.const 0))))
          (local.set $w (call $encode (local.get $w) (local.get $c)))
          (br $chars)))
        (if (i32.lt_s (local.tee $c (call $echar (local.get $c))) (i32.const 0))
          (then (return (call $syntax (@str "bad escape in string")))))))
      (i32.store8 (local.get $w) (local.get $c))
      (local.set $w (i32.add (local.get $w) (i32.const 1)))
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (br $chars)))
  (global.set $p (i32.add (global.get $p) (i32.const 1)))
  (global.set $str_len (i32.sub (local.get $w) (global.get $str)))
  (i32.const 1))

;; literal at $p (on '"').
(func $literal (result i32)
  (local $dt i32)
  (if (i32.eqz (call $string)) (then (return (i32.const 0))))
  (call $ws)
  (if (i32.eq (call $peek) (i32.const '@')) (then (return (call $lang_literal (global.get $str) (global.get $str_len)))))
  (local.set $dt (i32.const 2))
  (if (i32.eq (call $peek) (i32.const '^')) (then
    (if (i32.ne (call $peek_at (i32.const 1)) (i32.const '^')) (then (return (call $syntax (@str "expected '^^'")))))
    (global.set $p (i32.add (global.get $p) (i32.const 2)))
    (call $ws)
    (if (i32.eqz (local.tee $dt (call $predicate))) (then (return (i32.const 0))))
    (if (i32.lt_u (i32.sub (local.get $dt) (i32.const 3)) (i32.const 2))
      (then (return (call $syntax (@str "language string datatype without a language tag")))))))
  (call $intern (i32.const 3) (global.get $str) (global.get $str_len) (local.get $dt) (i32.const 0) (i32.const 0) (i32.const 1)))

;; An IRI (not a triple term).
(func $predicate (result i32)
  (if (result i32) (i32.and (i32.eq (call $peek) (i32.const '<')) (i32.ne (call $peek_at (i32.const 1)) (i32.const '<')))
    (then (call $iri))
    (else (call $syntax (@str "expected an IRI")))))

;; An IRI or a blank node: a subject, a graph label, or a triple term's subject.
(func $subject (result i32)
  (if (i32.eq (call $peek) (i32.const '_')) (then (return (call $bnode))))
  (if (i32.and (i32.eq (call $peek) (i32.const '<')) (i32.ne (call $peek_at (i32.const 1)) (i32.const '<')))
    (then (return (call $iri))))
  (call $syntax (@str "expected an IRI or a blank node")))

(func $object (result i32)
  (local $c i32)
  (local.set $c (call $peek))
  (if (i32.eq (local.get $c) (i32.const '"')) (then (return (call $literal))))
  (if (i32.and (i32.eq (local.get $c) (i32.const '<')) (i32.eq (call $peek_at (i32.const 1)) (i32.const '<'))) (then
    (if (i32.eq (call $peek_at (i32.const 2)) (i32.const '(')) (then (return (call $triple_term))))
    (return (call $syntax (@str "expected '<<('")))))
  (call $subject))

;; tripleTerm at $p (on '<<(').
(func $triple_term (result i32)
  (local $s i32) (local $pr i32) (local $o i32)
  (global.set $p (i32.add (global.get $p) (i32.const 3)))
  (call $ws)
  (if (i32.eqz (local.tee $s (call $subject))) (then (return (i32.const 0))))
  (call $ws)
  (if (i32.eqz (local.tee $pr (call $predicate))) (then (return (i32.const 0))))
  (call $ws)
  (if (i32.eqz (local.tee $o (call $object))) (then (return (i32.const 0))))
  (call $ws)
  (if (i32.eqz (call $starts (@str ")>>"))) (then (return (call $syntax (@str "expected ')>>'")))))
  (global.set $p (i32.add (global.get $p) (i32.const 3)))
  (call $intern_triple (local.get $s) (local.get $pr) (local.get $o) (i32.const 1)))

(func $push_quad (param $s i32) (param $p i32) (param $o i32) (param $g i32)
  (local $at i32)
  (if (i32.eq (global.get $qb_len) (global.get $qb_cap)) (then
    (global.set $qb (call $realloc (global.get $qb) (global.get $qb_cap)
      (i32.shl (global.get $qb_cap) (i32.const 1)) (global.get $qb_len)))
    (global.set $qb_cap (i32.shl (global.get $qb_cap) (i32.const 1)))))
  (local.set $at (i32.add (global.get $qb) (global.get $qb_len)))
  (i32.store (local.get $at) (local.get $s))
  (i32.store offset=4 (local.get $at) (local.get $p))
  (i32.store offset=8 (local.get $at) (local.get $o))
  (i32.store offset=12 (local.get $at) (local.get $g))
  (global.set $qb_len (i32.add (global.get $qb_len) (i32.const 16))))

;; Parse a document (fmt 1 N-Triples, 2 N-Quads) into the quad buffer; returns
;; the number of statements, or -1.
(func $parse (param $fmt i32) (param $graph i32) (result i32)
  (local $c i32) (local $n i32) (local $s i32) (local $pr i32) (local $o i32) (local $g i32)
  (loop $stmt
    (call $ws_comment)
    (local.set $c (call $peek))
    (if (i32.lt_s (local.get $c) (i32.const 0)) (then (return (local.get $n))))
    (if (i32.or (i32.eq (local.get $c) (i32.const '\n')) (i32.eq (local.get $c) (i32.const '\r'))) (then
      (global.set $line (i32.add (global.get $line) (i32.eq (local.get $c) (i32.const '\n'))))
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (br $stmt)))
    (block $statement
      (if (call $starts (@str "VERSION")) (then
        (global.set $p (i32.add (global.get $p) (i32.const 7)))
        (call $ws)
        (if (i32.ne (call $peek) (i32.const '"')) (then (return (i32.sub (call $syntax (@str "expected a version string")) (i32.const 1)))))
        (br_if $statement (call $string))
        (return (i32.const -1))))
      (if (i32.eqz (local.tee $s (call $subject))) (then (return (i32.const -1))))
      (call $ws)
      (if (i32.eqz (local.tee $pr (call $predicate))) (then (return (i32.const -1))))
      (call $ws)
      (if (i32.eqz (local.tee $o (call $object))) (then (return (i32.const -1))))
      (call $ws)
      (local.set $g (local.get $graph))
      (if (i32.ne (call $peek) (i32.const '.')) (then
        (if (i32.eq (local.get $fmt) (i32.const 1)) (then (return (i32.sub (call $syntax (@str "expected '.'")) (i32.const 1)))))
        (if (i32.eqz (local.tee $g (call $subject))) (then (return (i32.const -1))))
        (call $ws)
        (if (i32.ne (call $peek) (i32.const '.')) (then (return (i32.sub (call $syntax (@str "expected '.'")) (i32.const 1)))))))
      (global.set $p (i32.add (global.get $p) (i32.const 1)))
      (call $push_quad (local.get $s) (local.get $pr) (local.get $o) (local.get $g))
      (local.set $n (i32.add (local.get $n) (i32.const 1))))
    ;; a statement ends its line
    (call $ws_comment)
    (local.set $c (call $peek))
    (br_if $stmt (i32.or (i32.lt_s (local.get $c) (i32.const 0))
                         (i32.or (i32.eq (local.get $c) (i32.const '\n')) (i32.eq (local.get $c) (i32.const '\r')))))
    (return (i32.sub (call $syntax (@str "expected the end of the line")) (i32.const 1))))
  (unreachable))

(func $load (param $fmt i32) (param $len i32) (param $graph i32) (result i32)
  (local $n i32) (local $q i32) (local $end i32)
  (if (i32.eqz (local.get $graph)) (then (local.set $graph (i32.const 1))))
  (if (i32.eqz (call $kind (local.get $graph))) (then (return (call $fail (@str "graph is not a term")))))
  (global.set $p (global.get $in))
  (global.set $end (i32.add (global.get $in) (local.get $len)))
  (global.set $line (i32.const 1))
  (global.set $qb_len (i32.const 0))
  (local.set $n (call $parse (local.get $fmt) (local.get $graph)))
  (if (global.get $sc) (then
    (call $free (global.get $sc) (i32.shl (global.get $sc_cap) (i32.const 4)))
    (global.set $sc (i32.const 0))
    (global.set $sc_n (i32.const 0))))
  (if (i32.lt_s (local.get $n) (i32.const 0)) (then (return (i32.const -1))))
  (local.set $q (global.get $qb))
  (local.set $end (i32.add (global.get $qb) (global.get $qb_len)))
  (loop $each
    (if (i32.lt_u (local.get $q) (local.get $end)) (then
      (drop (call $add (i32.load (local.get $q)) (i32.load offset=4 (local.get $q))
                       (i32.load offset=8 (local.get $q)) (i32.load offset=12 (local.get $q))))
      (local.set $q (i32.add (local.get $q) (i32.const 16)))
      (br $each))))
  (local.get $n))
