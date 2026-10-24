//! The exports of `../ABI.md`. Wire types are i32; ids and counts are u32.

use crate::dict::{self, Dict, Key, lowercase};
use crate::lex;
use crate::sparql;
use crate::ntriples;
use crate::turtle;
use crate::store::{Quad, Store};
use alloc::vec::Vec;
use core::cell::UnsafeCell;

struct Prepared {
    query: sparql::Query,
    /// Bound variables: one term each, or several (run once per combination).
    binds: Vec<(sparql::Var, Vec<u32>)>,
}

struct State {
    queries: Vec<Option<Prepared>>,
    dict: Dict,
    store: Store,
    input: Vec<u8>,
    result: Vec<u32>,
    error: Vec<u8>,
    scratch: Vec<u8>,
}

struct Global(UnsafeCell<Option<State>>);

// Wasm without threads: there is one caller at a time.
unsafe impl Sync for Global {}

static STATE: Global = Global(UnsafeCell::new(None));

fn st() -> &'static mut State {
    unsafe {
        (*STATE.0.get()).get_or_insert_with(|| State {
            queries: Vec::new(),
            dict: Dict::new(),
            store: Store::default(),
            input: Vec::new(),
            result: Vec::new(),
            error: Vec::new(),
            scratch: Vec::new(),
        })
    }
}

fn fail(msg: &[u8]) -> i32 {
    let s = st();
    s.error.clear();
    s.error.extend_from_slice(msg);
    -1
}

fn fail_at(e: lex::Error) -> i32 {
    let s = st();
    s.error.clear();
    s.error.extend_from_slice(b"line ");
    let mut digits = [0u8; 10];
    let mut i = digits.len();
    let mut n = e.line;
    loop {
        i -= 1;
        digits[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    s.error.extend_from_slice(&digits[i..]);
    s.error.extend_from_slice(b": ");
    s.error.extend_from_slice(e.msg.as_bytes());
    -1
}

/// The input buffer split into consecutive strings of the given lengths.
fn args<const N: usize>(input: &[u8], lens: [u32; N]) -> [&[u8]; N] {
    let mut at = 0;
    lens.map(|n| {
        let s = &input[at..at + n as usize];
        at += n as usize;
        s
    })
}

// --- housekeeping ------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> i32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn input(len: u32) -> *mut u8 {
    let s = st();
    s.input.clear();
    s.input.resize(len as usize, 0);
    s.input.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u32 {
    st().result.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    st().error.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> u32 {
    st().error.len() as u32
}

// --- terms -------------------------------------------------------------------

fn lang_key<'a>(input: &'a [u8], scratch: &'a mut Vec<u8>, len: u32, lang_len: u32, dir: u32) -> Key<'a> {
    let [v, l] = args(input, [len, lang_len]);
    Key::lang_literal(v, lowercase(l, scratch), dir as u8)
}

#[unsafe(no_mangle)]
pub extern "C" fn intern_iri(len: u32) -> u32 {
    let s = st();
    s.dict.intern(Key::iri(&s.input[..len as usize]))
}

#[unsafe(no_mangle)]
pub extern "C" fn intern_bnode(len: u32) -> u32 {
    let s = st();
    s.dict.intern(Key::bnode(&s.input[..len as usize]))
}

#[unsafe(no_mangle)]
pub extern "C" fn fresh_bnode() -> u32 {
    st().dict.fresh_bnode()
}

#[unsafe(no_mangle)]
pub extern "C" fn intern_literal(len: u32, datatype: u32) -> u32 {
    let s = st();
    s.dict.intern(Key::literal(&s.input[..len as usize], datatype))
}

#[unsafe(no_mangle)]
pub extern "C" fn intern_lang_literal(len: u32, lang_len: u32, dir: u32) -> u32 {
    let s = st();
    s.dict.intern(lang_key(&s.input, &mut s.scratch, len, lang_len, dir))
}

#[unsafe(no_mangle)]
pub extern "C" fn intern_triple(sub: u32, p: u32, o: u32) -> u32 {
    st().dict.intern(Key::triple(sub, p, o))
}

#[unsafe(no_mangle)]
pub extern "C" fn lookup_iri(len: u32) -> u32 {
    let s = st();
    s.dict.get(Key::iri(&s.input[..len as usize]))
}

#[unsafe(no_mangle)]
pub extern "C" fn lookup_bnode(len: u32) -> u32 {
    let s = st();
    s.dict.get(Key::bnode(&s.input[..len as usize]))
}

#[unsafe(no_mangle)]
pub extern "C" fn lookup_literal(len: u32, datatype: u32) -> u32 {
    let s = st();
    s.dict.get(Key::literal(&s.input[..len as usize], datatype))
}

#[unsafe(no_mangle)]
pub extern "C" fn lookup_lang_literal(len: u32, lang_len: u32, dir: u32) -> u32 {
    let s = st();
    s.dict.get(lang_key(&s.input, &mut s.scratch, len, lang_len, dir))
}

#[unsafe(no_mangle)]
pub extern "C" fn lookup_triple(sub: u32, p: u32, o: u32) -> u32 {
    st().dict.get(Key::triple(sub, p, o))
}

#[unsafe(no_mangle)]
pub extern "C" fn term_kind(id: u32) -> u32 {
    st().dict.term(id).map_or(dict::FREE, |t| t.kind) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn term_value_ptr(id: u32) -> *const u8 {
    st().dict.value(id).as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn term_value_len(id: u32) -> u32 {
    st().dict.value(id).len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn term_datatype(id: u32) -> u32 {
    st().dict.term(id).filter(|t| t.kind == dict::LITERAL).map_or(0, |t| t.a)
}

#[unsafe(no_mangle)]
pub extern "C" fn term_lang_ptr(id: u32) -> *const u8 {
    st().dict.lang(id).as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn term_lang_len(id: u32) -> u32 {
    st().dict.lang(id).len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn term_direction(id: u32) -> u32 {
    st().dict.term(id).map_or(0, |t| t.dir) as u32
}

fn triple_part(id: u32, k: usize) -> u32 {
    st().dict.term(id).filter(|t| t.kind == dict::TRIPLE).map_or(0, |t| [t.a, t.b, t.c][k])
}

#[unsafe(no_mangle)]
pub extern "C" fn triple_subject(id: u32) -> u32 {
    triple_part(id, 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn triple_predicate(id: u32) -> u32 {
    triple_part(id, 1)
}

#[unsafe(no_mangle)]
pub extern "C" fn triple_object(id: u32) -> u32 {
    triple_part(id, 2)
}

#[unsafe(no_mangle)]
pub extern "C" fn term_count() -> u32 {
    st().dict.len()
}

// --- store -------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn add(s: u32, p: u32, o: u32, g: u32) -> i32 {
    st().store.add([s, p, o, g]) as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn remove(s: u32, p: u32, o: u32, g: u32) -> i32 {
    st().store.remove([s, p, o, g]) as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn has(s: u32, p: u32, o: u32, g: u32) -> i32 {
    st().store.has([s, p, o, g]) as i32
}

#[unsafe(export_name = "match")]
pub extern "C" fn match_(s: u32, p: u32, o: u32, g: u32) -> i32 {
    let st = st();
    st.result.clear();
    st.store.scan([s, p, o, g], &mut st.result);
    (st.result.len() / 4) as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn apply(removes: u32, adds: u32) -> i32 {
    let s = st();
    let quad = |i: usize| -> Quad {
        let w = |k: usize| u32::from_le_bytes([s.input[k], s.input[k + 1], s.input[k + 2], s.input[k + 3]]);
        [w(i * 16), w(i * 16 + 4), w(i * 16 + 8), w(i * 16 + 12)]
    };
    let (removes, adds) = (removes as usize, adds as usize);
    if s.input.len() < (removes + adds) * 16 {
        return fail(b"input buffer too short");
    }
    for i in 0..removes {
        s.store.remove(quad(i));
    }
    for i in removes..removes + adds {
        s.store.add(quad(i));
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn quad_count() -> u32 {
    st().store.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn load(format: u32, text_len: u32, base_len: u32, graph: u32) -> i32 {
    let s = st();
    let [text, base] = args(&s.input, [text_len, base_len]);
    let mut quads = Vec::new();
    let parsed = match format {
        1 | 2 => ntriples::parse(text, format == 2, graph, &mut s.dict, &mut quads),
        3 | 4 => turtle::parse(text, format == 4, base, graph, &mut s.dict, &mut quads),
        _ => return fail(b"unknown format"),
    };
    if let Err(e) = parsed {
        return fail_at(e);
    }
    for &q in &quads {
        s.store.add(q);
    }
    quads.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn collect() -> i32 {
    st().result.clear();
    0
}

// --- queries -----------------------------------------------------------------

fn prepared(h: u32) -> Option<&'static mut Prepared> {
    st().queries.get_mut((h as usize).wrapping_sub(1))?.as_mut()
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare(text_len: u32, base_len: u32) -> i32 {
    let s = st();
    let [text, base] = args(&s.input, [text_len, base_len]);
    match sparql::parse::parse_query(text, base, &mut s.dict) {
        Ok(query) => {
            let p = Prepared { query, binds: Vec::new() };
            match s.queries.iter().position(Option::is_none) {
                Some(i) => {
                    s.queries[i] = Some(p);
                    i as i32 + 1
                }
                None => {
                    s.queries.push(Some(p));
                    s.queries.len() as i32
                }
            }
        }
        Err(e) => fail_at(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn query_form(h: u32) -> u32 {
    prepared(h).map_or(0, |p| p.query.form as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn query_var_count(h: u32) -> u32 {
    prepared(h).filter(|p| p.query.form == sparql::Form::Select).map_or(0, |p| p.query.select.project.len() as u32)
}

fn var_name(h: u32, i: u32) -> &'static [u8] {
    prepared(h).and_then(|p| p.query.select.project.get(i as usize).map(|&v| &p.query.vars[v as usize][..])).unwrap_or(b"")
}

#[unsafe(no_mangle)]
pub extern "C" fn query_var_ptr(h: u32, i: u32) -> *const u8 {
    var_name(h, i).as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn query_var_len(h: u32, i: u32) -> u32 {
    var_name(h, i).len() as u32
}

fn set_binding(h: u32, name: &[u8], values: Vec<u32>) -> i32 {
    let Some(p) = prepared(h) else { return fail(b"no such query") };
    let Some(v) = p.query.var(name) else { return 0 };
    p.binds.retain(|(x, _)| *x != v);
    if !values.is_empty() {
        p.binds.push((v, values));
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn bind(h: u32, name_len: u32, id: u32) -> i32 {
    let name = st().input[..name_len as usize].to_vec();
    set_binding(h, &name, if id == 0 { Vec::new() } else { alloc::vec![id] })
}

#[unsafe(no_mangle)]
pub extern "C" fn bind_values(h: u32, count: u32, name_len: u32) -> i32 {
    let s = st();
    let n = count as usize;
    let ids: Vec<u32> = (0..n).map(|i| u32::from_le_bytes([s.input[i * 4], s.input[i * 4 + 1], s.input[i * 4 + 2], s.input[i * 4 + 3]])).collect();
    let name = s.input[n * 4..n * 4 + name_len as usize].to_vec();
    set_binding(h, &name, ids)
}

#[unsafe(no_mangle)]
pub extern "C" fn run(h: u32, graphs: u32) -> i32 {
    let s = st();
    let graph_ids: Vec<u32> = (0..graphs as usize).map(|i| u32::from_le_bytes([s.input[i * 4], s.input[i * 4 + 1], s.input[i * 4 + 2], s.input[i * 4 + 3]])).collect();
    let Some(p) = s.queries.get((h as usize).wrapping_sub(1)).and_then(Option::as_ref) else { return fail(b"no such query") };
    // One run per combination of bound values.
    let mut combos: Vec<Vec<(sparql::Var, u32)>> = alloc::vec![Vec::new()];
    for (v, values) in &p.binds {
        combos = combos.into_iter().flat_map(|c| values.iter().map(move |&x| {
            let mut c = c.clone();
            c.push((*v, x));
            c
        })).collect();
    }
    s.result.clear();
    let mut count = 0usize;
    let mut seen = crate::idmap::IdMap::new();
    for c in combos {
        match sparql::execute(&p.query, &mut s.dict, &s.store, &graph_ids, &c) {
            sparql::Output::Rows(r, n) => {
                count += n;
                s.result.extend(r);
            }
            sparql::Output::Triples(t) => {
                for x in t.chunks_exact(3) {
                    if seen.add(x) {
                        s.result.extend_from_slice(x);
                        count += 1;
                    }
                }
            }
            sparql::Output::Bool(b) => {
                if b {
                    return 1;
                }
            }
        }
    }
    if p.query.form == sparql::Form::Ask {
        return 0;
    }
    count as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn release(h: u32) -> i32 {
    if let Some(slot) = st().queries.get_mut((h as usize).wrapping_sub(1)) {
        *slot = None;
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_update(text_len: u32, base_len: u32) -> i32 {
    let s = st();
    let [text, base] = args(&s.input, [text_len, base_len]);
    match sparql::parse::parse_update(text, base, &mut s.dict) {
        Ok(_) => 0,
        Err(e) => fail_at(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn update(text_len: u32, base_len: u32) -> i32 {
    let s = st();
    let [text, base] = args(&s.input, [text_len, base_len]);
    let u = match sparql::parse::parse_update(text, base, &mut s.dict) {
        Ok(u) => u,
        Err(e) => return fail_at(e),
    };
    match sparql::update::execute(&u, &mut s.dict, &mut s.store) {
        Ok(()) => 0,
        Err(msg) => fail(msg.as_bytes()),
    }
}
