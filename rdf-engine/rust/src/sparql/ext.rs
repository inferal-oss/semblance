//! Semblance's SPARQL extensions (EXTENSIONS.md): functions named by
//! `sx:` IRIs and magic relations (`(inputs) sx:rel (outputs)`).

use super::eval::{Ctx, Row, bind};
use super::expr::{Dt, R, Val};
use super::num::{self, Num};
use super::regex;
use super::{Magic, Tv};
use crate::dict::{Key, NONE};
use crate::host;
use crate::idmap::{IdMap, bytes_key};
use alloc::vec::Vec;

pub const SX: &[u8] = b"https://semblance.dev/ns/sparql#";

/// The groups `extensions()` reports: Math, Text, Locale, Matches, JSON.
pub const GROUPS: i32 = 1 | 2 | 4 | 8 | 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fx {
    Log, Log10, Log2, Exp, Pow, Sqrt, Sin, Cos, Tan, Asin, Acos, Atan, Atan2, Pi,
    Codepoint, Char, Utf8Hex, DecodeUri, Fnv1a, JsonString,
    FormatNumber, FormatDateTime, Collated, SortKey,
}

/// An extension function by local name, with its arity range.
pub fn func(local: &[u8]) -> Option<(Fx, usize, usize)> {
    use Fx::*;
    Some(match local {
        b"log" => (Log, 1, 1),
        b"log10" => (Log10, 1, 1),
        b"log2" => (Log2, 1, 1),
        b"exp" => (Exp, 1, 1),
        b"pow" => (Pow, 2, 2),
        b"sqrt" => (Sqrt, 1, 1),
        b"sin" => (Sin, 1, 1),
        b"cos" => (Cos, 1, 1),
        b"tan" => (Tan, 1, 1),
        b"asin" => (Asin, 1, 1),
        b"acos" => (Acos, 1, 1),
        b"atan" => (Atan, 1, 1),
        b"atan2" => (Atan2, 2, 2),
        b"pi" => (Pi, 0, 0),
        b"codepoint" => (Codepoint, 2, 2),
        b"char" => (Char, 1, 1),
        b"utf8Hex" => (Utf8Hex, 1, 1),
        b"decodeURI" => (DecodeUri, 1, 1),
        b"fnv1a" => (Fnv1a, 1, 1),
        b"jsonString" => (JsonString, 1, 1),
        b"formatNumber" => (FormatNumber, 2, 3),
        b"formatDateTime" => (FormatDateTime, 2, 3),
        b"collated" => (Collated, 2, 2),
        b"sortKey" => (SortKey, 2, 2),
        _ => return None,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rel {
    Matches,
    Chars,
    Json,
}

/// A magic relation by local name.
pub fn rel(local: &[u8]) -> Option<Rel> {
    match local {
        b"matches" => Some(Rel::Matches),
        b"chars" => Some(Rel::Chars),
        b"json" => Some(Rel::Json),
        _ => None,
    }
}

/// `sx:fnv1a`: FNV-1a 32-bit as 8 lowercase hex digits.
fn fnv1a(s: &[u8]) -> Vec<u8> {
    let mut h: u32 = 0x811c9dc5;
    for &b in s {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    (0..8).rev().map(|i| HEX[(h >> (i * 4)) as usize & 15]).collect()
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `sx:decodeURI`: `%XX` decoded, the result checked to be UTF-8.
fn decode_uri(s: &[u8]) -> R<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'%' {
            let h = s.get(i + 1).copied().and_then(hex_digit).ok_or(())?;
            let l = s.get(i + 2).copied().and_then(hex_digit).ok_or(())?;
            out.push(h << 4 | l);
            i += 3;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    core::str::from_utf8(&out).map_err(|_| ())?;
    Ok(out)
}

/// A code point list back to UTF-8.
fn utf8(cps: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(cps.len());
    for &c in cps {
        crate::lex::push_utf8(&mut out, c);
    }
    out
}

impl Ctx<'_> {
    fn int_arg(&mut self, v: &Val) -> R<i128> {
        match self.num(v) {
            Some(Num::Int(i)) => Ok(i),
            _ => Err(()),
        }
    }

    /// An extension function's value, its arguments evaluated.
    pub fn ext(&mut self, f: Fx, v: &[Val]) -> R<Val> {
        use Fx::*;
        match f {
            Log | Log10 | Log2 | Exp | Pow | Sqrt | Sin | Cos | Tan | Asin | Acos | Atan | Atan2 | Pi => {
                let mut x = [0.0; 2];
                for (i, a) in v.iter().enumerate() {
                    x[i] = self.num(a).ok_or(())?.as_f64();
                }
                let r = match f {
                    Log | Log10 | Log2 if !(x[0] > 0.0) => return Err(()),
                    Sqrt if x[0] < 0.0 => return Err(()),
                    // Correctly rounded either way: the host's Math.sqrt is f64.sqrt.
                    Sqrt => host::math(12, x[0], 0.0),
                    Pi => core::f64::consts::PI,
                    _ => {
                        let op = [Log, Log10, Log2, Exp, Pow, Sin, Cos, Tan, Asin, Acos, Atan, Atan2].iter().position(|g| *g == f).unwrap();
                        host::math(op as i32, x[0], x[1])
                    }
                };
                if r.is_nan() { Err(()) } else { Ok(Val::Num(Num::Double(r))) }
            }
            Codepoint => {
                let (s, _) = self.string(&v[0])?;
                let i = self.int_arg(&v[1])?;
                if i < 1 {
                    return Err(());
                }
                let c = regex::chars(&s).get(i as usize - 1).copied().ok_or(())?;
                Ok(Val::Num(Num::Int(c as i128)))
            }
            Char => {
                let n = self.int_arg(&v[0])?;
                if !(0..=0x10ffff).contains(&n) || (0xd800..=0xdfff).contains(&n) {
                    return Err(());
                }
                Ok(Val::Str(utf8(&[n as u32]), None))
            }
            Utf8Hex => {
                let (s, _) = self.string(&v[0])?;
                let mut out = Vec::with_capacity(s.len() * 3);
                for (i, &b) in s.iter().enumerate() {
                    if i > 0 {
                        out.push(b' ');
                    }
                    out.push(HEX[(b >> 4) as usize]);
                    out.push(HEX[(b & 15) as usize]);
                }
                Ok(Val::Str(out, None))
            }
            DecodeUri => {
                let (s, _) = self.string(&v[0])?;
                Ok(Val::Str(decode_uri(&s)?, None))
            }
            Fnv1a => {
                let (s, _) = self.string(&v[0])?;
                Ok(Val::Str(fnv1a(&s), None))
            }
            JsonString => {
                let (s, _) = self.string(&v[0])?;
                let mut out = Vec::with_capacity(s.len() + 2);
                out.push(b'"');
                for c in regex::chars(&s) {
                    js_escape(&mut out, c);
                }
                out.push(b'"');
                Ok(Val::Str(out, None))
            }
            FormatNumber | FormatDateTime => {
                let lit = self.lit(&v[0]).ok_or(())?;
                let ok = match self.dt_kind(lit.dt) {
                    Dt::Integer | Dt::Decimal | Dt::Float | Dt::Double => f == FormatNumber,
                    Dt::DateTime | Dt::Date => f == FormatDateTime,
                    _ => false,
                };
                if !ok {
                    return Err(());
                }
                let (lang, _) = self.string(&v[1])?;
                let options = if v.len() > 2 { self.string(&v[2])?.0 } else { Vec::new() };
                let out = host::intl(if f == FormatNumber { 0 } else { 1 }, &[&lit.value, &lang, &options])?;
                Ok(Val::Str(out, None))
            }
            Collated => Ok(v[0].clone()),
            SortKey => {
                let (s, _) = self.string(&v[0])?;
                let (lang, _) = self.string(&v[1])?;
                Ok(Val::Str(host::intl(3, &[&s, &lang])?, None))
            }
        }
    }

    /// An `sx:collated(s, lang)` ORDER BY key: `lang` and `s`, when both are strings.
    pub fn collation_key(&mut self, args: &[super::Expr], row: &[u32]) -> Option<(Vec<u8>, Vec<u8>)> {
        let s = self.expr(&args[0], row).ok()?;
        let lang = self.expr(&args[1], row).ok()?;
        let (s, _) = self.string(&s).ok()?;
        let (lang, _) = self.string(&lang).ok()?;
        Some((lang, s))
    }

    /// A magic relation's rows extending `row`.
    pub fn magic(&mut self, m: &Magic, row: &[u32]) -> Vec<Row> {
        let mut out = Vec::new();
        let mut ins = Vec::with_capacity(m.ins.len());
        for x in &m.ins {
            match super::eval::resolve(x, row) {
                Some(id) => ins.push(Val::Id(id)),
                None => return out,
            }
        }
        match m.rel {
            super::ext::Rel::Chars => {
                let Ok((s, _)) = (match ins.first() {
                    Some(v) => self.string(v),
                    None => return out,
                }) else {
                    return out;
                };
                for (i, c) in regex::chars(&s).into_iter().enumerate() {
                    let ch = self.to_id(&Val::Str(utf8(&[c]), None));
                    let at = self.to_id(&Val::Num(Num::Int(i as i128 + 1)));
                    if !emit(self, m, row, &[ch, at], &mut out) {
                        break;
                    }
                }
            }
            super::ext::Rel::Matches => {
                if ins.len() < 2 || ins.len() > 3 {
                    return out;
                }
                let Ok((s, _)) = self.string(&ins[0]) else { return out };
                let Ok((p, None)) = self.string(&ins[1]) else { return out };
                let flags = match ins.get(2) {
                    Some(f) => match self.string(f) {
                        Ok((f, _)) => f,
                        Err(()) => return out,
                    },
                    None => Vec::new(),
                };
                let Ok(re) = self.regex(&p, &flags) else { return out };
                let text = regex::chars(&s);
                let mut from = 0;
                let mut vals = Vec::new();
                while from <= text.len() {
                    let Some(slots) = re.find(&text, from) else { break };
                    let (a, b) = (slots[0], slots[1]);
                    vals.clear();
                    vals.push(self.to_id(&Val::Str(utf8(&text[a..b]), None)));
                    vals.push(self.to_id(&Val::Num(Num::Int(a as i128 + 1))));
                    for g in slots[2..].chunks_exact(2) {
                        vals.push(if g[0] == usize::MAX || g[1] == usize::MAX { NONE } else { self.to_id(&Val::Str(utf8(&text[g[0]..g[1]]), None)) });
                    }
                    if !emit(self, m, row, &vals, &mut out) {
                        break;
                    }
                    from = if b == a { b + 1 } else { b };
                }
            }
            super::ext::Rel::Json => {
                let Some(Ok((s, _))) = ins.first().map(|v| self.string(v)) else { return out };
                let Some(values) = json(&s) else { return out };
                let kinds: Vec<u32> = [&b"object"[..], b"array", b"string", b"number", b"boolean", b"null"].iter().map(|k| self.to_id(&Val::Str(k.to_vec(), None))).collect();
                // ?json and ?kept only when asked for: the spelling is a term per scalar
                let more = m.outs.len() > 6;
                let mut vals = Vec::with_capacity(8);
                for j in &values {
                    vals.clear();
                    vals.push(self.to_id(&Val::Str(j.path.clone(), None)));
                    vals.push(match &j.parent {
                        Some(p) => self.to_id(&Val::Str(p.clone(), None)),
                        None => NONE,
                    });
                    vals.push(match &j.key {
                        JKey::Root => NONE,
                        JKey::Name(n) => self.to_id(&Val::Str(n.clone(), None)),
                        JKey::Index(i) => self.to_id(&Val::Num(Num::Int(*i as i128))),
                    });
                    vals.push(kinds[j.kind as usize]);
                    vals.push(match &j.value {
                        None => NONE,
                        Some((v, dt)) => {
                            let dt = match dt {
                                JDt::String => NONE,
                                JDt::Integer => self.xsd(b"integer"),
                                JDt::Decimal => self.xsd(b"decimal"),
                                JDt::Double => self.xsd(b"double"),
                                JDt::Boolean => self.xsd(b"boolean"),
                            };
                            self.dict.intern(Key::literal(v, dt))
                        }
                    });
                    vals.push(match j.index {
                        Some(i) => self.to_id(&Val::Num(Num::Int(i as i128))),
                        None => NONE,
                    });
                    if more {
                        vals.push(match &j.json {
                            Some(t) => self.to_id(&Val::Str(t.clone(), None)),
                            None => NONE,
                        });
                        vals.push(self.to_id(&Val::Bool(j.kept)));
                    }
                    if !emit(self, m, row, &vals, &mut out) {
                        break;
                    }
                }
            }
        }
        out
    }
}

/// Extend `row` with one tuple of a magic relation's values (NONE: none) into
/// `out`, when its outputs agree; false once the query's budget is spent.
fn emit(me: &mut Ctx, m: &Magic, row: &[u32], vals: &[u32], out: &mut Vec<Row>) -> bool {
    if crate::budget::step() {
        return false;
    }
    let mut r = row.to_vec();
    for (k, o) in m.outs.iter().enumerate() {
        let id = vals.get(k).copied().unwrap_or(NONE);
        let ok = match (o, id) {
            (Tv::Var(_), NONE) => true,
            (_, NONE) => false,
            _ => bind(o, id, &mut r, me.dict),
        };
        if !ok {
            return true;
        }
    }
    out.push(r);
    true
}

// --- JSON ------------------------------------------------------------------------

enum JKey {
    Root,
    Name(Vec<u8>),
    Index(usize),
}

#[derive(Clone, Copy)]
enum JDt {
    String,
    Integer,
    Decimal,
    Double,
    Boolean,
}

/// One JSON value: its pointer, its parent's, its key, its kind (object,
/// array, string, number, boolean, null), a scalar's lexical form, its
/// position among its siblings (None for the root; a kept duplicate key's is
/// its first occurrence's), a scalar as JSON.stringify writes it, and whether
/// JSON.parse keeps it (not an earlier duplicate key, nor inside one).
struct JValue {
    path: Vec<u8>,
    parent: Option<Vec<u8>>,
    key: JKey,
    kind: u8,
    value: Option<(Vec<u8>, JDt)>,
    index: Option<usize>,
    json: Option<Vec<u8>>,
    kept: bool,
}

const MAX_DEPTH: usize = 512;

/// Every value of a JSON text in document order, or None if it is not JSON.
fn json(s: &[u8]) -> Option<Vec<JValue>> {
    let mut p = Json { s, i: 0, out: Vec::new() };
    p.ws();
    p.value(Vec::new(), None, JKey::Root, None, 0)?;
    p.ws();
    if p.i != s.len() {
        return None;
    }
    Some(p.out)
}

struct Json<'a> {
    s: &'a [u8],
    i: usize,
    out: Vec<JValue>,
}

impl Json<'_> {
    fn peek(&self) -> u8 {
        self.s.get(self.i).copied().unwrap_or(0)
    }

    fn ws(&mut self) {
        while matches!(self.peek(), b' ' | b'\t' | b'\n' | b'\r') && self.i < self.s.len() {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.i < self.s.len() && self.s[self.i] == c {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn lit(&mut self, word: &[u8]) -> Option<()> {
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            Some(())
        } else {
            None
        }
    }

    fn value(&mut self, path: Vec<u8>, parent: Option<Vec<u8>>, key: JKey, at: Option<usize>, depth: usize) -> Option<()> {
        if self.i >= self.s.len() {
            return None;
        }
        match self.peek() {
            b'{' | b'[' => {
                if depth >= MAX_DEPTH {
                    return None;
                }
                let object = self.peek() == b'{';
                self.i += 1;
                self.out.push(JValue { path: path.clone(), parent, key, kind: if object { 0 } else { 1 }, value: None, index: at, json: None, kept: true });
                self.ws();
                let close = if object { b'}' } else { b']' };
                if self.eat(close) {
                    return Some(());
                }
                let mut index = 0;
                // each member name (as spelled, so lone surrogates stay apart): its
                // first position and the rows of its last value [start, end)
                let (mut names, mut seen) = (IdMap::new(), Vec::<(usize, usize, usize)>::new());
                loop {
                    self.ws();
                    let mut spelled = Vec::new();
                    let key = if object {
                        if self.peek() != b'"' {
                            return None;
                        }
                        let (k, j) = self.string()?;
                        spelled = j;
                        self.ws();
                        if !self.eat(b':') {
                            return None;
                        }
                        self.ws();
                        JKey::Name(k)
                    } else {
                        JKey::Index(index)
                    };
                    let mut child = path.clone();
                    child.push(b'/');
                    match &key {
                        JKey::Name(k) => {
                            for &b in k {
                                match b {
                                    b'~' => child.extend_from_slice(b"~0"),
                                    b'/' => child.extend_from_slice(b"~1"),
                                    _ => child.push(b),
                                }
                            }
                        }
                        JKey::Index(n) => {
                            let mut d = Vec::new();
                            num::write_int(&mut d, *n as i128);
                            child.extend_from_slice(&d);
                        }
                        JKey::Root => {}
                    }
                    let start = self.out.len();
                    let name = if object { bytes_key(&spelled) } else { Vec::new() };
                    let earlier = names.get(&name).map(|e| seen[e as usize]);
                    self.value(child, Some(path.clone()), key, Some(earlier.map_or(index, |e| e.0)), depth + 1)?;
                    if object {
                        let end = self.out.len();
                        // JSON.parse keeps the last value, at the first one's position
                        if let Some((_, s, e)) = earlier {
                            for v in &mut self.out[s..e] {
                                v.kept = false;
                            }
                        }
                        let (e, _) = names.insert(&name, seen.len() as u32);
                        if e as usize == seen.len() {
                            seen.push((index, start, end));
                        } else {
                            seen[e as usize] = (seen[e as usize].0, start, end);
                        }
                    }
                    index += 1;
                    self.ws();
                    if self.eat(close) {
                        return Some(());
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                }
            }
            b'"' => {
                let (v, j) = self.string()?;
                self.out.push(JValue { path, parent, key, kind: 2, value: Some((v, JDt::String)), index: at, json: Some(j), kept: true });
                Some(())
            }
            b't' | b'f' => {
                let t = self.peek() == b't';
                self.lit(if t { b"true" } else { b"false" })?;
                let word = if t { b"true".to_vec() } else { b"false".to_vec() };
                self.out.push(JValue { path, parent, key, kind: 4, value: Some((word.clone(), JDt::Boolean)), index: at, json: Some(word), kept: true });
                Some(())
            }
            b'n' => {
                self.lit(b"null")?;
                self.out.push(JValue { path, parent, key, kind: 5, value: None, index: at, json: Some(b"null".to_vec()), kept: true });
                Some(())
            }
            _ => {
                let start = self.i;
                self.eat(b'-');
                let digits = |me: &mut Self| {
                    let from = me.i;
                    while me.peek().is_ascii_digit() && me.i < me.s.len() {
                        me.i += 1;
                    }
                    me.i - from
                };
                if self.peek() == b'0' {
                    self.i += 1;
                } else if digits(self) == 0 {
                    return None;
                }
                let mut dt = JDt::Integer;
                if self.eat(b'.') {
                    if digits(self) == 0 {
                        return None;
                    }
                    dt = JDt::Decimal;
                }
                if self.eat(b'e') || self.eat(b'E') {
                    let _ = self.eat(b'+') || self.eat(b'-');
                    if digits(self) == 0 {
                        return None;
                    }
                    dt = JDt::Double;
                }
                let text = &self.s[start..self.i];
                let json = js_number(core::str::from_utf8(text).ok()?.parse::<f64>().ok()?);
                self.out.push(JValue { path, parent, key, kind: 3, value: Some((text.to_vec(), dt)), index: at, json: Some(json), kept: true });
                Some(())
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let mut n = 0;
        for _ in 0..4 {
            n = n << 4 | hex_digit(*self.s.get(self.i)?)? as u32;
            self.i += 1;
        }
        Some(n)
    }

    /// A string at the cursor (on its `"`): unescaped (a lone surrogate as
    /// U+FFFD), and as JSON.stringify writes it.
    fn string(&mut self) -> Option<(Vec<u8>, Vec<u8>)> {
        self.i += 1;
        let mut out = Vec::new();
        let mut json = Vec::from(*b"\"");
        loop {
            let c = *self.s.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => {
                    json.push(b'"');
                    return Some((out, json));
                }
                b'\\' => {
                    let e = *self.s.get(self.i)?;
                    self.i += 1;
                    let cp = match e {
                        b'"' | b'\\' | b'/' => e as u32,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let hi = self.hex4()?;
                            let mut cp = hi;
                            if (0xd800..=0xdbff).contains(&hi) {
                                // a low surrogate escape after it makes a pair
                                let at = self.i;
                                match (self.eat(b'\\') && self.eat(b'u')).then(|| self.hex4()).flatten() {
                                    Some(lo) if (0xdc00..=0xdfff).contains(&lo) => cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00),
                                    _ => self.i = at,
                                }
                            }
                            if (0xd800..=0xdfff).contains(&cp) {
                                // lone: JSON.parse keeps it, JSON.stringify escapes it
                                crate::lex::push_utf8(&mut out, 0xfffd);
                                js_escape(&mut json, cp);
                                continue;
                            }
                            cp
                        }
                        _ => return None,
                    };
                    crate::lex::push_utf8(&mut out, cp);
                    js_escape(&mut json, cp);
                }
                0..=0x1f => return None,
                _ => {
                    out.push(c);
                    if c == b'"' || c == b'\\' {
                        json.push(b'\\');
                    }
                    json.push(c);
                }
            }
        }
    }
}

/// Code point cp into a string as JSON.stringify writes it: `"`, `\\` and the
/// controls escaped (\b \t \n \f \r, else \u00xx), a lone surrogate as \udxxx.
fn js_escape(out: &mut Vec<u8>, cp: u32) {
    let short = match cp {
        0x22 => b'"',
        0x5c => b'\\',
        8 => b'b',
        9 => b't',
        10 => b'n',
        12 => b'f',
        13 => b'r',
        _ => 0,
    };
    if short != 0 {
        out.extend_from_slice(&[b'\\', short]);
    } else if cp < 0x20 || (0xd800..=0xdfff).contains(&cp) {
        out.extend_from_slice(b"\\u");
        for k in (0..4).rev() {
            out.push(HEX[(cp >> (k * 4)) as usize & 15]);
        }
    } else {
        crate::lex::push_utf8(out, cp);
    }
}

/// A number as JSON.stringify writes it (ECMAScript Number::toString): the
/// shortest digits that read back, plain from 1e-6 to below 1e21, else with an
/// exponent ("1e+21", "1.5e-7"); -0 as "0", and a number too large as "null".
fn js_number(x: f64) -> Vec<u8> {
    use core::fmt::Write;
    let mut out = Vec::new();
    if !x.is_finite() {
        out.extend_from_slice(b"null");
        return out;
    }
    if x == 0.0 {
        out.push(b'0');
        return out;
    }
    if x < 0.0 {
        out.push(b'-');
    }
    // core's {:e} has the shortest digits that read back ("1.2345e-7"), but on
    // a tie between two of them it takes the upper; ECMAScript the nearest, and
    // on a tie the even one: x correctly rounded to that many digits (core
    // rounds ties to even), when it reads back
    let mut sci = alloc::string::String::new();
    let _ = write!(sci, "{:e}", x.abs());
    let k = sci.split('e').next().unwrap_or("").bytes().filter(u8::is_ascii_digit).count();
    let mut near = alloc::string::String::new();
    let _ = write!(near, "{:.*e}", k.saturating_sub(1), x.abs());
    if near.parse::<f64>() == Ok(x.abs()) {
        sci = near;
    }
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let mut digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    while digits.len() > 1 && digits.last() == Some(&b'0') {
        digits.pop();
    }
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let k = digits.len() as i32;
    if k <= n && n <= 21 {
        out.extend_from_slice(&digits);
        out.resize(out.len() + (n - k) as usize, b'0');
    } else if 0 < n && n <= 21 {
        out.extend_from_slice(&digits[..n as usize]);
        out.push(b'.');
        out.extend_from_slice(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.extend_from_slice(b"0.");
        out.resize(out.len() + (-n) as usize, b'0');
        out.extend_from_slice(&digits);
    } else {
        out.push(digits[0]);
        if k > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        out.push(b'e');
        out.push(if n - 1 < 0 { b'-' } else { b'+' });
        num::write_int(&mut out, ((n - 1) as i128).abs());
    }
    out
}
