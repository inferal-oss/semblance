//! Jelly-RDF (../JELLY.md, ABI.md "Jelly"): a reader of 1.2 (the column layout) and 1.0/1.1 (the
//! row layout) and a writer of 1.2, frame by frame, decoding protobuf in place. The writer makes
//! the choices JELLY.md fixes, so it writes the bytes the WAT build and `src/jelly/` write.

use crate::dict::{Dict, Key, BNODE, DEFAULT_GRAPH_ID, IRI, LITERAL, TRIPLE, XSD_STRING, lowercase};
use crate::hash;
use crate::idmap::{IdMap, bytes_key};
use crate::store::Quad;
use alloc::vec::Vec;

pub type R<T> = Result<T, &'static str>;

const MAX: [u32; 3] = [16384, 4096, 256];
const MAX_DEPTH: u32 = 100;
const MAX_ROWS: u64 = (1 << 27) - 1;
/// Rows per batch this reader takes (a batch of a few bytes may declare millions of rows).
const BATCH_ROWS: u64 = 1 << 20;
const VERSION: u32 = 3;
const RDF_LANG: &[u8] = b"http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
const RDF_DIR_LANG: &[u8] = b"http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString";

// ---- the wire format --------------------------------------------------------

/// A cursor over `b[i..end]`.
#[derive(Clone, Copy)]
struct P<'a> {
    b: &'a [u8],
    i: usize,
    end: usize,
}

impl<'a> P<'a> {
    fn new(b: &'a [u8], i: usize, end: usize) -> Self {
        P { b, i, end }
    }
    fn done(&self) -> bool {
        self.i >= self.end
    }
    fn varint(&mut self) -> R<u64> {
        let mut x = 0u64;
        let mut shift = 0;
        for _ in 0..10 {
            if self.i >= self.end {
                return Err("truncated varint");
            }
            let c = self.b[self.i];
            self.i += 1;
            if shift < 64 {
                x |= ((c & 0x7f) as u64) << shift;
            }
            if c < 0x80 {
                return Ok(x);
            }
            shift += 7;
        }
        Err("varint longer than 10 bytes")
    }
    /// A varint as a u32, saturated.
    fn u32(&mut self) -> R<u32> {
        Ok(self.varint()?.min(u32::MAX as u64) as u32)
    }
    fn uint(&mut self, wire: u8) -> R<u32> {
        if wire != 0 {
            return Err("expected a varint field");
        }
        self.u32()
    }
    fn tag(&mut self) -> R<(u32, u8)> {
        let t = self.varint()?;
        let field = t >> 3;
        if field == 0 {
            return Err("field number 0");
        }
        Ok((field.min(u32::MAX as u64) as u32, (t & 7) as u8))
    }
    fn len(&mut self) -> R<(usize, usize)> {
        let n = self.varint()?;
        if n > (self.end - self.i) as u64 {
            return Err("truncated field");
        }
        let s = self.i;
        self.i = s + n as usize;
        Ok((s, self.i))
    }
    fn sub(&mut self) -> R<P<'a>> {
        let (s, e) = self.len()?;
        Ok(P::new(self.b, s, e))
    }
    /// A string field's bytes, checked to be UTF-8.
    fn string(&mut self) -> R<(usize, usize)> {
        let (s, e) = self.len()?;
        utf8(&self.b[s..e])?;
        Ok((s, e))
    }
    fn skip(&mut self, wire: u8) -> R<()> {
        match wire {
            0 => self.varint().map(|_| ()),
            2 => self.len().map(|_| ()),
            1 | 5 => {
                let n = if wire == 1 { 8 } else { 4 };
                if self.end - self.i < n {
                    return Err("truncated field");
                }
                self.i += n;
                Ok(())
            }
            _ => Err("unsupported wire type"),
        }
    }
    /// The varints of a repeated field, packed or not.
    fn packed(&mut self, wire: u8, out: &mut Vec<u32>) -> R<()> {
        match wire {
            0 => out.push(self.u32()?),
            2 => {
                let mut r = self.sub()?;
                while !r.done() {
                    out.push(r.u32()?);
                }
            }
            _ => return Err("expected a varint field"),
        }
        Ok(())
    }
}

fn utf8(b: &[u8]) -> R<()> {
    if b.is_ascii() || core::str::from_utf8(b).is_ok() { Ok(()) } else { Err("invalid UTF-8") }
}

// ---- reader -----------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Opts {
    physical: u32,
    stream_type: u32,
    max: [u32; 3],
    version: u32,
}

#[derive(Default)]
struct Entry {
    value: Vec<u8>,
    set: bool,
    /// A prefix: a number that changes whenever the entry does.
    /// A name: the prefix (and its number) of the last IRI made with it, and that IRI.
    /// A datatype: its IRI's term id, once made.
    stamp: u32,
    prefix: u32,
    term: u32,
}

/// A run value of a column. `dep` 0: the term `id`; 1: a blank node labelled `f[a..b]`; 2: the
/// triple term `f[a..b]` holding blank nodes, decoded again with the IRI sequence `seq`.
#[derive(Clone, Copy, Default)]
struct Val {
    id: u32,
    dep: u8,
    a: u32,
    b: u32,
    seq: [u32; 2],
    scope: u32,
}

#[derive(Default)]
struct Lists {
    layouts: Vec<u32>,
    names: Vec<u32>,
    prefixes: Vec<u32>,
    lex: Vec<(usize, usize)>,
    kinds: Vec<u32>,
    langs: Vec<(usize, usize)>,
    dirs: Vec<u32>,
    bnodes: Vec<(usize, usize)>,
    tts: Vec<(usize, usize)>,
}

impl Lists {
    fn clear(&mut self) {
        self.layouts.clear();
        self.names.clear();
        self.prefixes.clear();
        self.lex.clear();
        self.kinds.clear();
        self.langs.clear();
        self.dirs.clear();
        self.bnodes.clear();
        self.tts.clear();
    }
}

#[derive(Default)]
pub struct Reader {
    pub graph: u32,
    pub failed: bool,
    opts: Option<Opts>,
    opts_bytes: Vec<u8>,
    tables: [Vec<Entry>; 3],
    stamp: u32,
    last_entry: [u32; 3],
    // Row layout: the stream's IRI sequence, the terms statements repeat, the GRAPHS graph.
    seq: [u32; 2],
    last: [u32; 4],
    cur_graph: u32,
    // RDF Messages.
    scope: u32,
    in_message: u32,
    blanks: IdMap,
    /// Message ends in the last frame: statements before each.
    pub ends: Vec<u32>,
    buf: Vec<u8>,
    lang: Vec<u8>,
    lists: Lists,
    vals: Vec<Val>,
    cells: [Vec<u32>; 4],
    bounds: Vec<u32>,
}

const LOOKUP_ERR: [[&str; 4]; 3] = [
    ["a name entry, with that lookup disabled", "name entry outside the lookup", "name outside the lookup", "name not defined"],
    ["a prefix entry, with that lookup disabled", "prefix entry outside the lookup", "prefix outside the lookup", "prefix not defined"],
    ["a datatype entry, with that lookup disabled", "datatype entry outside the lookup", "datatype outside the lookup", "datatype not defined"],
];

impl Reader {
    pub fn new(graph: u32) -> Reader {
        Reader { graph, ..Default::default() }
    }

    /// Term ids the reader holds on to (its blank nodes), for `collect`; its caches are dropped.
    pub fn held(&mut self, f: &mut impl FnMut(u32)) {
        self.blanks.values().for_each(&mut *f);
        for t in &mut self.tables {
            for e in t.iter_mut() {
                e.term = 0;
            }
        }
        for &x in &self.last {
            f(x);
        }
        f(self.cur_graph);
    }

    /// Read one frame; its statements are appended to `out` (which the caller empties first).
    pub fn frame(&mut self, f: &[u8], dict: &mut Dict, out: &mut Vec<Quad>) -> R<()> {
        self.ends.clear();
        let mut p = P::new(f, 0, f.len());
        let mut rows: Vec<(usize, usize)> = Vec::new();
        let mut columns = None;
        while !p.done() {
            let (field, wire) = p.tag()?;
            if field == 1 && wire == 2 {
                rows.push(p.len()?);
            } else if field == 2 && wire == 2 {
                columns = Some(p.len()?);
            } else {
                p.skip(wire)?;
            }
        }
        for (i, &(s, e)) in rows.iter().enumerate() {
            if matches!(self.opts, Some(o) if o.version < 3) {
                self.row(f, s, e, dict, out)?;
                continue;
            }
            if i > 0 {
                return Err("a Jelly-RDF 1.2 frame has at most one row");
            }
            let mut r = P::new(f, s, e);
            let mut opts = None;
            while !r.done() {
                let (field, wire) = r.tag()?;
                if field == 1 && wire == 2 {
                    opts = Some(r.len()?);
                } else {
                    return Err("a Jelly-RDF 1.2 row holds only the stream options");
                }
            }
            let (os, oe) = opts.ok_or("an empty row")?;
            self.options(&f[os..oe], out.len() as u32)?;
        }
        if let Some((s, e)) = columns {
            match self.opts {
                Some(o) if o.version == 3 => self.batch(f, s, e, dict, out)?,
                None => return Err("statements before the stream options"),
                _ => {}
            }
        }
        Ok(())
    }

    /// The end of the stream: whether the message in progress ends here.
    pub fn finish(&mut self) -> bool {
        if self.in_message > 0 {
            self.in_message = 0;
            self.scope += 1;
            self.blanks = IdMap::new();
            return true;
        }
        false
    }

    fn end_message(&mut self, at: u32) {
        self.ends.push(at);
        self.in_message = 0;
        self.scope += 1;
        self.blanks = IdMap::new();
    }

    fn options(&mut self, b: &[u8], at: u32) -> R<()> {
        let mut o = Opts::default();
        let (mut generalized, mut star, mut logical, mut rdf_version) = (0, 0, 0, 0);
        let mut p = P::new(b, 0, b.len());
        while !p.done() {
            let (field, wire) = p.tag()?;
            match field {
                1 if wire == 2 => {
                    p.string()?;
                }
                2 => o.physical = p.uint(wire)?,
                3 => generalized = p.uint(wire)?,
                4 => star = p.uint(wire)?,
                5 => o.stream_type = p.uint(wire)?,
                6 => rdf_version = p.uint(wire)?,
                9 => o.max[0] = p.uint(wire)?,
                10 => o.max[1] = p.uint(wire)?,
                11 => o.max[2] = p.uint(wire)?,
                14 => logical = p.uint(wire)?,
                15 => o.version = p.uint(wire)?,
                _ => p.skip(wire)?,
            }
        }
        if o.version == 0 {
            return Err("version tag 0");
        }
        if o.version > VERSION {
            return Err("a version tag newer than this reader");
        }
        if let Some(prev) = self.opts {
            if (prev.version < 3) != (o.version < 3) {
                return Err("a stream mixes Jelly-RDF 1.2 with 1.0/1.1");
            }
        }
        for k in 0..3 {
            if o.max[k] > MAX[k] {
                return Err("a lookup larger than the limit");
            }
        }
        if o.version < 3 {
            if self.opts.is_some() {
                return if self.opts_bytes == b { Ok(()) } else { Err("the stream options differ from the first ones") };
            }
            if !(1..=3).contains(&o.physical) {
                return Err("an unknown physical stream type");
            }
            if o.max[0] < 8 {
                return Err("a name lookup smaller than 8");
            }
            self.opts = Some(o);
            self.opts_bytes = b.to_vec();
            return Ok(());
        }
        if generalized != 0 || star != 0 || logical != 0 {
            return Err("a Jelly-RDF 1.0/1.1 stream option in a 1.2 stream");
        }
        if o.physical != 1 && o.physical != 2 {
            return Err("an unknown physical stream type");
        }
        if o.stream_type > 1 {
            return Err("an unknown stream type");
        }
        if rdf_version > 3 {
            return Err("an unknown RDF version");
        }
        if o.max[0] < 128 {
            return Err("a name lookup smaller than 128");
        }
        if let Some(prev) = self.opts {
            if prev.physical != o.physical {
                return Err("the restated stream options change the physical type");
            }
            if prev.stream_type != o.stream_type {
                return Err("the restated stream options change the stream type");
            }
            for t in &mut self.tables {
                t.clear();
            }
            self.last_entry = [0; 3];
            if o.stream_type == 1 && self.in_message > 0 {
                self.end_message(at);
            }
        }
        self.opts = Some(o);
        Ok(())
    }

    // ---- lookups ----

    fn entries(&mut self, kind: usize, mut id: u32, values: &[(usize, usize)], f: &[u8]) -> R<()> {
        let max = self.opts.unwrap().max[kind];
        if id == 0 {
            id = self.last_entry[kind] + 1;
        }
        if max == 0 {
            return Err(LOOKUP_ERR[kind][0]);
        }
        if id as u64 + values.len() as u64 - 1 > max as u64 {
            return Err(LOOKUP_ERR[kind][1]);
        }
        let t = &mut self.tables[kind];
        if t.len() < (id as usize + values.len()) {
            t.resize_with(id as usize + values.len(), Entry::default);
        }
        for &(s, e) in values {
            self.stamp += 1;
            let x = &mut t[id as usize];
            x.value.clear();
            x.value.extend_from_slice(&f[s..e]);
            x.set = true;
            x.stamp = self.stamp;
            x.term = 0;
            id += 1;
        }
        self.last_entry[kind] = id - 1;
        Ok(())
    }

    fn entry(&self, kind: usize, id: u32) -> R<&Entry> {
        let max = self.opts.unwrap().max[kind];
        if id < 1 || id > max {
            return Err(LOOKUP_ERR[kind][2]);
        }
        match self.tables[kind].get(id as usize) {
            Some(e) if e.set => Ok(e),
            _ => Err(LOOKUP_ERR[kind][3]),
        }
    }

    fn iri(&mut self, prefix: u32, name: u32, dict: &mut Dict) -> R<u32> {
        let pgen = if prefix != 0 { self.entry(1, prefix)?.stamp } else { 0 };
        let n = self.entry(0, name)?;
        if n.term != 0 && n.prefix == prefix && n.stamp == pgen {
            return Ok(n.term);
        }
        self.buf.clear();
        if prefix != 0 {
            self.buf.extend_from_slice(&self.tables[1][prefix as usize].value);
        }
        self.buf.extend_from_slice(&self.tables[0][name as usize].value);
        let id = dict.intern(Key::iri(&self.buf));
        let n = &mut self.tables[0][name as usize];
        n.prefix = prefix;
        n.stamp = pgen;
        n.term = id;
        Ok(id)
    }

    fn datatype(&mut self, id: u32, dict: &mut Dict) -> R<u32> {
        let e = self.entry(2, id)?;
        if e.term != 0 {
            return Ok(e.term);
        }
        if e.value == RDF_LANG || e.value == RDF_DIR_LANG {
            return Err("rdf:langString or rdf:dirLangString as a datatype");
        }
        let t = dict.intern(Key::iri(&e.value));
        self.tables[2][id as usize].term = t;
        Ok(t)
    }

    fn lang_literal(&mut self, lex: &[u8], lang: &[u8], dir: u32, dict: &mut Dict) -> R<u32> {
        if dir > 2 {
            return Err("an unknown base direction");
        }
        Ok(dict.intern(Key::lang_literal(lex, lowercase(lang, &mut self.lang), dir as u8)))
    }

    fn blank(&mut self, label: &[u8], dict: &mut Dict) -> u32 {
        let key = bytes_key(label);
        if let Some(id) = self.blanks.get(&key) {
            return id;
        }
        let id = dict.fresh_bnode();
        self.blanks.insert(&key, id);
        id
    }

    /// An `RdfIri` in the IRI sequence `seq`.
    fn rdf_iri(&mut self, mut p: P, seq: &mut [u32; 2], dict: &mut Dict) -> R<u32> {
        let (mut prefix, mut name) = (0, 0);
        while !p.done() {
            let (field, wire) = p.tag()?;
            match field {
                1 => prefix = p.uint(wire)?,
                2 => name = p.uint(wire)?,
                _ => p.skip(wire)?,
            }
        }
        if prefix == 0 {
            prefix = seq[0];
        } else {
            seq[0] = prefix;
        }
        if name == 0 {
            name = seq[1].saturating_add(1);
        }
        seq[1] = name;
        self.iri(prefix, name, dict)
    }

    /// An `RdfLiteral`.
    fn rdf_literal(&mut self, mut p: P, dict: &mut Dict) -> R<u32> {
        let f = p.b;
        let mut lex = (0, 0);
        let mut lang = None;
        let mut datatype = None;
        let mut dir = 0;
        while !p.done() {
            let (field, wire) = p.tag()?;
            match field {
                1 if wire == 2 => lex = p.string()?,
                2 if wire == 2 => {
                    lang = Some(p.string()?);
                    datatype = None;
                }
                3 => {
                    datatype = Some(p.uint(wire)?);
                    lang = None;
                }
                4 => dir = p.uint(wire)?,
                _ => p.skip(wire)?,
            }
        }
        if dir != 0 && lang.is_none() {
            return Err("a base direction without a language tag");
        }
        let lexb = &f[lex.0..lex.1];
        if let Some((s, e)) = lang {
            let dir = if self.opts.unwrap().version < 3 { 0 } else { dir };
            return self.lang_literal(lexb, &f[s..e], dir, dict);
        }
        match datatype {
            None => Ok(dict.intern(Key::literal(lexb, XSD_STRING))),
            Some(0) => Err("datatype 0"),
            Some(d) => {
                let dt = self.datatype(d, dict)?;
                Ok(dict.intern(Key::literal(lexb, dt)))
            }
        }
    }

    // ---- row layout (1.0 and 1.1) ----

    fn row(&mut self, f: &[u8], s: usize, e: usize, dict: &mut Dict, out: &mut Vec<Quad>) -> R<()> {
        let mut r = P::new(f, s, e);
        let mut fields = 0;
        while !r.done() {
            let (field, wire) = r.tag()?;
            fields += 1;
            if wire != 2 {
                return Err("a row field that is not a message");
            }
            let m = r.sub()?;
            if field == 1 {
                self.options(&f[m.i..m.end], out.len() as u32)?;
                continue;
            }
            let o = self.opts.ok_or("a row before the stream options")?;
            match field {
                2 => {
                    if o.physical == 2 {
                        return Err("a triple in a stream of quads");
                    }
                    if o.physical == 3 && self.cur_graph == 0 {
                        return Err("a triple outside a graph");
                    }
                    let t = self.statement(m, 3, dict)?;
                    out.push([t[0], t[1], t[2], if o.physical == 3 { self.cur_graph } else { self.graph }]);
                }
                3 => {
                    if o.physical != 2 {
                        return Err("a quad in a stream that is not of quads");
                    }
                    let t = self.statement(m, 4, dict)?;
                    out.push(t);
                }
                4 => {
                    if o.physical != 3 {
                        return Err("a graph start in a stream that is not of graphs");
                    }
                    if self.cur_graph != 0 {
                        return Err("a graph start inside a graph");
                    }
                    let mut m = m;
                    let mut g = 0;
                    while !m.done() {
                        let (fl, w) = m.tag()?;
                        if w != 2 {
                            m.skip(w)?;
                            continue;
                        }
                        match fl {
                            1 => {
                                let x = m.sub()?;
                                let mut seq = self.seq;
                                g = self.rdf_iri(x, &mut seq, dict)?;
                                self.seq = seq;
                            }
                            2 => {
                                let (s, e) = m.string()?;
                                g = self.blank(&f[s..e], dict);
                            }
                            3 => {
                                m.len()?;
                                g = self.graph;
                            }
                            4 => return Err("a literal graph name (generalized RDF is not supported)"),
                            _ => m.skip(w)?,
                        }
                    }
                    if g == 0 {
                        return Err("a graph start without a graph");
                    }
                    self.cur_graph = g;
                }
                5 => {
                    if o.physical != 3 {
                        return Err("a graph end in a stream that is not of graphs");
                    }
                    self.cur_graph = 0;
                }
                6 => {
                    let mut seq = self.seq;
                    self.namespace(m, &mut seq, dict)?;
                    self.seq = seq;
                }
                9..=11 => {
                    let mut m = m;
                    let (mut id, mut value) = (0, (0, 0));
                    while !m.done() {
                        let (fl, w) = m.tag()?;
                        match fl {
                            1 => id = m.uint(w)?,
                            2 if w == 2 => value = m.string()?,
                            _ => m.skip(w)?,
                        }
                    }
                    self.entries(field as usize - 9, id, &[value], f)?;
                }
                _ => return Err("an unknown row field"),
            }
        }
        if fields == 0 {
            return Err("an empty row");
        }
        Ok(())
    }

    fn namespace(&mut self, mut m: P, seq: &mut [u32; 2], dict: &mut Dict) -> R<()> {
        let mut iri = false;
        while !m.done() {
            let (fl, w) = m.tag()?;
            match fl {
                1 if w == 2 => {
                    m.string()?;
                }
                2 if w == 2 => {
                    let x = m.sub()?;
                    self.rdf_iri(x, seq, dict)?;
                    iri = true;
                }
                _ => m.skip(w)?,
            }
        }
        if !iri {
            return Err("a namespace declaration without an IRI");
        }
        Ok(())
    }

    fn statement(&mut self, m: P, n: usize, dict: &mut Dict) -> R<Quad> {
        let mut t = self.terms(m, n, 0, dict)?;
        for i in 0..n {
            if t[i] == 0 {
                if self.last[i] == 0 {
                    return Err("a repeated term in the first statement");
                }
                t[i] = self.last[i];
            } else {
                self.last[i] = t[i];
            }
        }
        Ok(t)
    }

    /// The terms of an `RdfTriple` (n = 3) or `RdfQuad` (n = 4); 0 where one is not set.
    fn terms(&mut self, mut m: P, n: usize, depth: u32, dict: &mut Dict) -> R<Quad> {
        let f = m.b;
        let mut t = [0u32; 4];
        while !m.done() {
            let (field, wire) = m.tag()?;
            if wire != 2 || field as usize > 4 * n {
                m.skip(wire)?;
                continue;
            }
            let pos = ((field - 1) >> 2) as usize;
            let kind = (field - 1) & 3;
            if pos == 3 {
                t[3] = match kind {
                    0 => {
                        let x = m.sub()?;
                        let mut seq = self.seq;
                        let id = self.rdf_iri(x, &mut seq, dict)?;
                        self.seq = seq;
                        id
                    }
                    1 => {
                        let (s, e) = m.string()?;
                        self.blank(&f[s..e], dict)
                    }
                    2 => {
                        m.len()?;
                        self.graph
                    }
                    _ => return Err("a literal graph name (generalized RDF is not supported)"),
                };
                continue;
            }
            t[pos] = match kind {
                0 => {
                    let x = m.sub()?;
                    let mut seq = self.seq;
                    let id = self.rdf_iri(x, &mut seq, dict)?;
                    self.seq = seq;
                    id
                }
                1 => {
                    let (s, e) = m.string()?;
                    self.blank(&f[s..e], dict)
                }
                2 => {
                    let x = m.sub()?;
                    self.rdf_literal(x, dict)?
                }
                _ => {
                    if depth >= MAX_DEPTH {
                        return Err("quoted triples nest too deep");
                    }
                    let x = m.sub()?;
                    let q = self.terms(x, 3, depth + 1, dict)?;
                    if q[0] == 0 || q[1] == 0 || q[2] == 0 {
                        return Err("a quoted triple with a repeated term");
                    }
                    dict.intern(Key::triple(q[0], q[1], q[2]))
                }
            };
            if pos == 0 && kind == 2 {
                return Err("a literal subject (generalized RDF is not supported)");
            }
            if pos == 1 && kind != 0 {
                return Err("a predicate that is not an IRI (generalized RDF is not supported)");
            }
        }
        Ok(t)
    }

    // ---- column layout (1.2) ----

    fn batch(&mut self, f: &[u8], s: usize, e: usize, dict: &mut Dict, out: &mut Vec<Quad>) -> R<()> {
        let o = self.opts.unwrap();
        let mut p = P::new(f, s, e);
        let mut rows = 0u64;
        let mut entries: Vec<(usize, P)> = Vec::new();
        let mut namespaces: Vec<P> = Vec::new();
        let mut cols: [Option<P>; 4] = [None; 4];
        let mut lengths = core::mem::take(&mut self.bounds);
        lengths.clear();
        while !p.done() {
            let (field, wire) = p.tag()?;
            match field {
                1 => rows = { if wire != 0 { return Err("expected a varint field") } p.varint()? },
                2..=4 if wire == 2 => entries.push((field as usize - 2, p.sub()?)),
                5 if wire == 2 => namespaces.push(p.sub()?),
                6..=9 if wire == 2 => cols[field as usize - 6] = Some(p.sub()?),
                15 => p.packed(wire, &mut lengths)?,
                _ => p.skip(wire)?,
            }
        }
        if rows > MAX_ROWS {
            return Err("row_count is larger than 2^27 - 1");
        }
        if rows > BATCH_ROWS {
            return Err("a batch larger than this reader's limit");
        }
        let rows = rows as usize;
        if cols[3].is_some() && o.physical == 1 {
            return Err("a graphs column in a stream of triples");
        }
        if !lengths.is_empty() && o.stream_type != 1 {
            return Err("message boundaries in a FLAT stream");
        }
        if lengths.iter().map(|&l| l as u64).sum::<u64>() > rows as u64 {
            return Err("the message lengths add up to more than row_count");
        }
        // 1. Lookup entries, in order.
        let mut values: Vec<(usize, usize)> = Vec::new();
        for (kind, mut x) in entries {
            let mut id = 0;
            values.clear();
            while !x.done() {
                let (fl, w) = x.tag()?;
                match fl {
                    1 => id = x.uint(w)?,
                    2 if w == 2 => values.push(x.string()?),
                    _ => x.skip(w)?,
                }
            }
            self.entries(kind, id, &values, f)?;
        }
        // 2. Namespace declarations: one IRI sequence.
        let mut seq = [0u32; 2];
        for m in namespaces {
            self.namespace(m, &mut seq, dict)?;
        }
        // 3. Statements: each column's cells (run value index + 1; 0 unbound), then row by row.
        self.vals.clear();
        let mut cells = core::mem::take(&mut self.cells);
        for c in 0..4 {
            cells[c].clear();
            cells[c].resize(rows, 0);
            if let Some(x) = cols[c] {
                self.column(x, rows, c, dict, &mut cells[c])?;
            } else if c < 3 && rows > 0 {
                return Err("a column with unbound cells");
            }
        }
        let mut b = 0;
        while b < lengths.len() && lengths[b] == 0 {
            self.end_message(out.len() as u32);
            b += 1;
        }
        let mut next = if b < lengths.len() { lengths[b] } else { u32::MAX };
        for r in 0..rows {
            let mut q = [0u32; 4];
            for c in 0..4 {
                let v = cells[c][r];
                q[c] = if v == 0 { 0 } else { self.value(f, v as usize - 1, dict)? };
            }
            q[3] = if o.physical == 2 { if q[3] == 0 { DEFAULT_GRAPH_ID } else { q[3] } } else { self.graph };
            out.push(q);
            self.in_message += 1;
            if next != u32::MAX {
                next -= 1;
                if next == 0 {
                    self.end_message(out.len() as u32);
                    b += 1;
                    while b < lengths.len() && lengths[b] == 0 {
                        self.end_message(out.len() as u32);
                        b += 1;
                    }
                    next = if b < lengths.len() { lengths[b] } else { u32::MAX };
                }
            }
        }
        self.cells = cells;
        self.bounds = lengths;
        Ok(())
    }

    /// The term of run value `i`, in the current message's blank node scope.
    fn value(&mut self, f: &[u8], i: usize, dict: &mut Dict) -> R<u32> {
        let v = self.vals[i];
        if v.dep == 0 || (v.id != 0 && v.scope == self.scope) {
            return Ok(v.id);
        }
        let id = if v.dep == 1 {
            self.blank(&f[v.a as usize..v.b as usize], dict)
        } else {
            let mut seq = v.seq;
            self.triple_term(P::new(f, v.a as usize, v.b as usize), &mut seq, 0, true, dict)?.unwrap()
        };
        let x = &mut self.vals[i];
        x.id = id;
        x.scope = self.scope;
        Ok(id)
    }

    fn column(&mut self, mut p: P, rows: usize, pos: usize, dict: &mut Dict, cells: &mut [u32]) -> R<()> {
        let f = p.b;
        let mut l = core::mem::take(&mut self.lists);
        l.clear();
        let mut kinds = (0, 0);
        while !p.done() {
            let (field, wire) = p.tag()?;
            match field {
                1 if wire == 2 => kinds = p.len()?,
                2 => p.packed(wire, &mut l.layouts)?,
                3 => p.packed(wire, &mut l.names)?,
                4 => p.packed(wire, &mut l.prefixes)?,
                5 if wire == 2 => l.lex.push(p.string()?),
                6 => p.packed(wire, &mut l.kinds)?,
                7 if wire == 2 => l.langs.push(p.string()?),
                8 => p.packed(wire, &mut l.dirs)?,
                9 if wire == 2 => l.bnodes.push(p.string()?),
                10 if wire == 2 => l.tts.push(p.len()?),
                _ => p.skip(wire)?,
            }
        }
        let r = self.column_values(f, &l, kinds, rows, pos, dict, cells);
        self.lists = l;
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn column_values(&mut self, f: &[u8], l: &Lists, kinds: (usize, usize), rows: usize, pos: usize, dict: &mut Dict, cells: &mut [u32]) -> R<()> {
        let counts = [l.names.len(), l.lex.len(), l.bnodes.len(), l.tts.len()];
        let m = counts.iter().sum::<usize>();
        let kinds = &f[kinds.0..kinds.1];
        let single = if kinds.is_empty() {
            let mut lists = 0;
            let mut which = 0;
            for (t, &c) in counts.iter().enumerate() {
                if c > 0 {
                    lists += 1;
                    which = t;
                }
            }
            if lists > 1 {
                return Err("a column of several term types without kinds");
            }
            Some(which)
        } else {
            if kinds.len() != m.div_ceil(4) {
                return Err("kinds has the wrong length");
            }
            if m % 4 != 0 && kinds[kinds.len() - 1] >> (2 * (m % 4)) != 0 {
                return Err("unused bits of kinds are set");
            }
            let mut seen = [0usize; 4];
            for i in 0..m {
                let t = (kinds[i >> 2] >> (2 * (i & 3))) as usize & 3;
                seen[t] += 1;
                if seen[t] > counts[t] {
                    return Err("kinds refers to more values of a type than the column has");
                }
            }
            None
        };
        if l.prefixes.len() > 1 && l.prefixes.len() != l.names.len() {
            return Err("prefix_ids has the wrong length");
        }
        if l.kinds.len() > 1 && l.kinds.len() != l.lex.len() {
            return Err("literal_kinds has the wrong length");
        }
        if !l.dirs.is_empty() && l.dirs.len() != l.langs.len() {
            return Err("langtag_directions has the wrong length");
        }
        if l.dirs.iter().any(|&d| d > 2) {
            return Err("an unknown base direction");
        }
        let allowed: u32 = match pos {
            1 => 1,
            2 => 15,
            _ => 5,
        };
        let base = self.vals.len();
        let mut next = [0usize; 4];
        let (mut prev_name, mut prev_prefix) = (0u32, 0u32);
        let mut tt_seq = [0u32; 2];
        for i in 0..m {
            let t = match single {
                Some(t) => t,
                None => (kinds[i >> 2] >> (2 * (i & 3))) as usize & 3,
            };
            if allowed & (1 << t) == 0 {
                return Err("a term type the column does not allow");
            }
            let k = next[t];
            next[t] += 1;
            let mut v = Val::default();
            match t {
                0 => {
                    let name = if l.names[k] == 0 { prev_name.saturating_add(1) } else { l.names[k] };
                    prev_name = name;
                    let mut prefix = match l.prefixes.len() {
                        0 => 0,
                        1 => l.prefixes[0],
                        _ => l.prefixes[k],
                    };
                    if l.prefixes.len() > 1 {
                        if prefix == 0 {
                            prefix = prev_prefix;
                        }
                        prev_prefix = prefix;
                    }
                    v.id = self.iri(prefix, name, dict)?;
                }
                1 => {
                    let kind = match l.kinds.len() {
                        0 => 0,
                        1 => l.kinds[0],
                        _ => l.kinds[k],
                    };
                    let (s, e) = l.lex[k];
                    let lex = &f[s..e];
                    v.id = if kind == 0 {
                        dict.intern(Key::literal(lex, XSD_STRING))
                    } else if kind & 1 == 1 {
                        let dt = self.datatype(kind / 2 + 1, dict)?;
                        dict.intern(Key::literal(lex, dt))
                    } else {
                        let j = (kind / 2 - 1) as usize;
                        if j >= l.langs.len() {
                            return Err("a literal kind refers to a language tag past the end of langtags");
                        }
                        let (ls, le) = l.langs[j];
                        let dir = if l.dirs.is_empty() { 0 } else { l.dirs[j] };
                        self.lang_literal(lex, &f[ls..le], dir, dict)?
                    };
                }
                2 => {
                    let (s, e) = l.bnodes[k];
                    v.dep = 1;
                    v.a = s as u32;
                    v.b = e as u32;
                }
                _ => {
                    let (s, e) = l.tts[k];
                    let before = tt_seq;
                    match self.triple_term(P::new(f, s, e), &mut tt_seq, 0, false, dict)? {
                        Some(id) => v.id = id,
                        None => {
                            v.dep = 2;
                            v.a = s as u32;
                            v.b = e as u32;
                            v.seq = before;
                        }
                    }
                }
            }
            self.vals.push(v);
        }
        // The sequence layout.
        let (mut i, mut at) = (0usize, 0usize);
        let mut x = 0;
        while x < l.layouts.len() {
            let token = l.layouts[x];
            let skip = (token >> 5) as usize;
            let mut len = (token & 15) as u64;
            if len == 15 {
                x += 1;
                if x >= l.layouts.len() {
                    return Err("a layout token without its extension varint");
                }
                len += l.layouts[x] as u64;
            }
            x += 1;
            if i + skip > m {
                return Err("a layout skips past the last run value");
            }
            if at + skip > rows {
                return Err("a column longer than row_count");
            }
            for _ in 0..skip {
                cells[at] = (base + i + 1) as u32;
                at += 1;
                i += 1;
            }
            if token & 16 != 0 {
                if at as u64 + len + 1 > rows as u64 {
                    return Err("a column longer than row_count");
                }
                at += len as usize + 1;
            } else {
                if i >= m {
                    return Err("a repeat run past the last run value");
                }
                if at as u64 + len + 2 > rows as u64 {
                    return Err("a column longer than row_count");
                }
                for _ in 0..len + 2 {
                    cells[at] = (base + i + 1) as u32;
                    at += 1;
                }
                i += 1;
            }
        }
        if at + (m - i) > rows {
            return Err("a column longer than row_count");
        }
        while i < m {
            cells[at] = (base + i + 1) as u32;
            at += 1;
            i += 1;
        }
        if pos < 3 && cells.iter().any(|&c| c == 0) {
            return Err("a column with unbound cells");
        }
        Ok(())
    }

    /// An `RdfTripleTerm` in the IRI sequence `seq`. Unless `resolve`, one holding a blank node is
    /// checked but not made (None): its blank nodes depend on the message it is in.
    fn triple_term(&mut self, mut p: P, seq: &mut [u32; 2], depth: u32, resolve: bool, dict: &mut Dict) -> R<Option<u32>> {
        if depth >= MAX_DEPTH {
            return Err("triple terms nest too deep");
        }
        let f = p.b;
        let mut set = [false; 3];
        let mut ids = [0u32; 3];
        let mut blank = false;
        while !p.done() {
            let (field, wire) = p.tag()?;
            if wire != 2 {
                p.skip(wire)?;
                continue;
            }
            let (slot, id) = match field {
                1 => (0, Some(self.rdf_iri(p.sub()?, seq, dict)?)),
                2 => {
                    let (s, e) = p.string()?;
                    (0, if resolve { Some(self.blank(&f[s..e], dict)) } else { None })
                }
                5 => (1, Some(self.rdf_iri(p.sub()?, seq, dict)?)),
                9 => (2, Some(self.rdf_iri(p.sub()?, seq, dict)?)),
                10 => {
                    let (s, e) = p.string()?;
                    (2, if resolve { Some(self.blank(&f[s..e], dict)) } else { None })
                }
                11 => (2, Some(self.rdf_literal(p.sub()?, dict)?)),
                12 => {
                    let x = p.sub()?;
                    (2, self.triple_term(x, seq, depth + 1, resolve, dict)?)
                }
                _ => {
                    p.skip(wire)?;
                    continue;
                }
            };
            set[slot] = true;
            match id {
                Some(id) => ids[slot] = id,
                None => {
                    ids[slot] = 0;
                    blank = true;
                }
            }
        }
        if !set[0] {
            return Err("a triple term without a subject");
        }
        if !set[1] {
            return Err("a triple term without a predicate");
        }
        if !set[2] {
            return Err("a triple term without an object");
        }
        if blank && ids.contains(&0) {
            return Ok(None);
        }
        Ok(Some(dict.intern(Key::triple(ids[0], ids[1], ids[2]))))
    }
}

// ---- writer -----------------------------------------------------------------

fn varint(out: &mut Vec<u8>, mut x: u64) {
    while x >= 0x80 {
        out.push(x as u8 | 0x80);
        x >>= 7;
    }
    out.push(x as u8);
}

fn tag(out: &mut Vec<u8>, field: u32, wire: u8) {
    varint(out, (field as u64) << 3 | wire as u64);
}

fn uint(out: &mut Vec<u8>, field: u32, x: u32) {
    if x != 0 {
        tag(out, field, 0);
        varint(out, x as u64);
    }
}

fn bytes(out: &mut Vec<u8>, field: u32, b: &[u8]) {
    tag(out, field, 2);
    varint(out, b.len() as u64);
    out.extend_from_slice(b);
}

fn packed(out: &mut Vec<u8>, field: u32, xs: &[u32]) {
    if xs.is_empty() {
        return;
    }
    let size: usize = xs.iter().map(|&x| varint_size(x as u64)).sum();
    tag(out, field, 2);
    varint(out, size as u64);
    for &x in xs {
        varint(out, x as u64);
    }
}

fn varint_size(mut x: u64) -> usize {
    let mut n = 1;
    while x >= 0x80 {
        x >>= 7;
        n += 1;
    }
    n
}

/// After its last '#' or '/': (prefix, name).
fn split(iri: &[u8]) -> (&[u8], &[u8]) {
    match iri.iter().rposition(|&c| c == b'#' || c == b'/') {
        Some(i) => iri.split_at(i + 1),
        None => (b"", iri),
    }
}

/// A least-recently-used lookup: values to identifiers 1..=max, with the batch's use of them.
#[derive(Default)]
struct Lru {
    max: u32,
    next: u32,
    last: u32,
    /// Open addressing over identifiers (0 empty), keyed by their values; at most half full.
    table: Vec<u32>,
    hashes: Vec<u32>,
    vals: Vec<Vec<u8>>,
    /// Recency: a list from the least recently used (`head`) to the most (`tail`).
    prev: Vec<u32>,
    nxt: Vec<u32>,
    head: u32,
    tail: u32,
    epoch: Vec<u32>,
    now: u32,
    touched: u32,
    fresh: Vec<u32>,
}

fn hash_bytes(b: &[u8]) -> u32 {
    hash::top32(hash::bytes(0, b)) | 1
}

impl Lru {
    fn new(max: u32) -> Lru {
        let mut size = 8;
        while size < max as usize * 2 + 2 {
            size *= 2;
        }
        let n = max as usize + 1;
        Lru {
            max,
            next: 1,
            table: alloc::vec![0; size],
            hashes: alloc::vec![0; n],
            vals: (0..n).map(|_| Vec::new()).collect(),
            prev: alloc::vec![0; n],
            nxt: alloc::vec![0; n],
            epoch: alloc::vec![0; n],
            now: 1,
            ..Default::default()
        }
    }

    fn find(&self, v: &[u8], h: u32) -> (usize, u32) {
        let mask = self.table.len() - 1;
        let mut i = h as usize & mask;
        loop {
            let id = self.table[i];
            if id == 0 || (self.hashes[id as usize] == h && self.vals[id as usize] == v) {
                return (i, id);
            }
            i = (i + 1) & mask;
        }
    }

    fn get(&self, v: &[u8]) -> u32 {
        if self.max == 0 {
            return 0;
        }
        self.find(v, hash_bytes(v)).1
    }

    fn is_touched(&self, v: &[u8]) -> bool {
        let id = self.get(v);
        id != 0 && self.epoch[id as usize] == self.now
    }

    fn unlink(&mut self, id: u32) {
        let (p, n) = (self.prev[id as usize], self.nxt[id as usize]);
        if p != 0 { self.nxt[p as usize] = n } else { self.head = n }
        if n != 0 { self.prev[n as usize] = p } else { self.tail = p }
    }

    fn push_back(&mut self, id: u32) {
        self.prev[id as usize] = self.tail;
        self.nxt[id as usize] = 0;
        if self.tail != 0 { self.nxt[self.tail as usize] = id } else { self.head = id }
        self.tail = id;
    }

    /// Remove `id` from the table (backward-shift deletion).
    fn remove(&mut self, id: u32) {
        let mask = self.table.len() - 1;
        let mut i = self.hashes[id as usize] as usize & mask;
        while self.table[i] != id {
            i = (i + 1) & mask;
        }
        loop {
            self.table[i] = 0;
            let mut j = i;
            loop {
                j = (j + 1) & mask;
                let x = self.table[j];
                if x == 0 {
                    return;
                }
                let home = self.hashes[x as usize] as usize & mask;
                // x may move to i when its home is not cyclically in (i, j].
                if (j > i && (home <= i || home > j)) || (j < i && home <= i && home > j) {
                    self.table[i] = x;
                    i = j;
                    break;
                }
            }
        }
    }

    fn use_value(&mut self, v: &[u8]) -> u32 {
        let h = hash_bytes(v);
        let (_, found) = self.find(v, h);
        let id = if found != 0 {
            self.unlink(found);
            found
        } else {
            let id = if self.next <= self.max {
                self.next += 1;
                self.next - 1
            } else {
                let old = self.head;
                self.unlink(old);
                self.remove(old);
                old
            };
            self.vals[id as usize].clear();
            self.vals[id as usize].extend_from_slice(v);
            self.hashes[id as usize] = h;
            // Found again: removing the evicted entry may have moved others.
            let (slot, _) = self.find(v, h);
            self.table[slot] = id;
            self.fresh.push(id);
            id
        };
        self.push_back(id);
        if self.epoch[id as usize] != self.now {
            self.epoch[id as usize] = self.now;
            self.touched += 1;
        }
        id
    }

    /// The batch's new entries, as packed entries (field `field` of the batch).
    fn write(&mut self, out: &mut Vec<u8>, field: u32, tmp: &mut Vec<u8>) {
        let mut i = 0;
        while i < self.fresh.len() {
            let mut j = i + 1;
            while j < self.fresh.len() && self.fresh[j] == self.fresh[j - 1] + 1 {
                j += 1;
            }
            let id = self.fresh[i];
            tmp.clear();
            uint(tmp, 1, if id == self.last + 1 { 0 } else { id });
            for k in i..j {
                bytes(tmp, 2, &self.vals[self.fresh[k] as usize]);
            }
            bytes(out, field, tmp);
            self.last = self.fresh[j - 1];
            i = j;
        }
    }

    fn end_batch(&mut self) {
        self.now += 1;
        self.touched = 0;
        self.fresh.clear();
    }
}

pub struct Writer {
    physical: u32,
    stream_type: u32,
    rdf_version: u32,
    max: [u32; 3],
    frame_rows: u32,
    started: bool,
    lru: [Lru; 3],
    rows: Vec<Quad>,
    ends: Vec<u32>,
    message_start: u32,
    /// Frames completed, delimited.
    pub out: Vec<u8>,
    keys: [Vec<(usize, usize, u32)>; 3],
}

impl Writer {
    pub fn new(physical: u32, stream_type: u32, rdf_version: u32, max: [u32; 3], frame_rows: u32) -> R<Writer> {
        if physical != 1 && physical != 2 {
            return Err("an unknown physical stream type");
        }
        if stream_type > 1 || rdf_version > 3 {
            return Err("an unknown stream type or RDF version");
        }
        if max[0] < 128 {
            return Err("a name lookup smaller than 128");
        }
        if (0..3).any(|k| max[k] > MAX[k]) {
            return Err("a lookup larger than readers take");
        }
        Ok(Writer {
            physical,
            stream_type,
            rdf_version,
            max,
            frame_rows: if frame_rows == 0 { 4096 } else { frame_rows },
            started: false,
            lru: [Lru::new(max[0]), Lru::new(max[1]), Lru::new(max[2])],
            rows: Vec::new(),
            ends: Vec::new(),
            message_start: 0,
            out: Vec::new(),
            keys: [Vec::new(), Vec::new(), Vec::new()],
        })
    }

    /// Term ids the writer holds (the frame in progress), for `collect`.
    pub fn held(&self, f: &mut impl FnMut(u32)) {
        self.rows.iter().for_each(|q| q.iter().for_each(|&x| f(x)));
    }

    /// The lookup values term `id` at position `pos` needs, each list in order of first use.
    fn keys(&mut self, dict: &Dict, id: u32, pos: u8) -> R<()> {
        let t = dict.term(id).ok_or("a free term id")?;
        match t.kind {
            IRI => {
                let v = dict.value(id);
                let (prefix, name) = if self.max[1] != 0 { split(v) } else { (&v[..0], v) };
                Self::key(&mut self.keys[0], v, name, id);
                if self.max[1] != 0 {
                    Self::key(&mut self.keys[1], v, prefix, id);
                }
                Ok(())
            }
            BNODE => if pos == 1 { Err("a blank node predicate") } else { Ok(()) },
            LITERAL => {
                if pos != 2 {
                    return Err("a literal outside the object position");
                }
                if t.a == crate::dict::RDF_LANG_STRING || t.a == crate::dict::RDF_DIR_LANG_STRING {
                    if t.dir != 0 && self.rdf_version == 1 {
                        return Err("a base direction in a stream of RDF 1.1");
                    }
                } else if t.a != XSD_STRING {
                    if self.max[2] == 0 {
                        return Err("a typed literal with the datatype lookup disabled");
                    }
                    let dv = dict.value(t.a);
                    Self::key(&mut self.keys[2], dv, dv, t.a);
                }
                Ok(())
            }
            TRIPLE => {
                if pos != 2 {
                    return Err("a triple term outside the object position");
                }
                if self.rdf_version == 1 || self.rdf_version == 2 {
                    return Err("a triple term in a stream without triple terms");
                }
                let (a, b, c) = (t.a, t.b, t.c);
                self.keys(dict, a, 0)?;
                self.keys(dict, b, 1)?;
                self.keys(dict, c, 2)
            }
            _ => Err("a term that is not an IRI, blank node, literal or triple term"),
        }
    }

    /// Note `part`, a slice of `whole` (the value of term `id`).
    fn key(list: &mut Vec<(usize, usize, u32)>, whole: &[u8], part: &[u8], id: u32) {
        let s = part.as_ptr() as usize - whole.as_ptr() as usize;
        list.push((s, s + part.len(), id));
    }

    fn dedup<'d>(dict: &'d Dict, list: &[(usize, usize, u32)], out: &mut Vec<&'d [u8]>) {
        out.clear();
        for &(s, e, id) in list {
            let v = &dict.value(id)[s..e];
            if !out.iter().any(|x| *x == v) {
                out.push(v);
            }
        }
    }

    pub fn add(&mut self, q: Quad, dict: &Dict) -> R<()> {
        for k in &mut self.keys {
            k.clear();
        }
        self.keys(dict, q[0], 0)?;
        if dict.term(q[0]).map(|t| t.kind) == Some(TRIPLE) {
            return Err("a triple term subject");
        }
        self.keys(dict, q[1], 1)?;
        if dict.term(q[1]).map(|t| t.kind) != Some(IRI) {
            return Err("a predicate that is not an IRI");
        }
        self.keys(dict, q[2], 2)?;
        let g = if q[3] == DEFAULT_GRAPH_ID { 0 } else { q[3] };
        if g != 0 {
            if self.physical == 1 {
                return Err("a statement in a named graph, in a stream of triples");
            }
            match dict.term(g).map(|t| t.kind) {
                Some(IRI) | Some(BNODE) => {}
                _ => return Err("a graph name that is not an IRI or a blank node"),
            }
            self.keys(dict, g, 0)?;
        }
        let mut lists: [Vec<&[u8]>; 3] = [Vec::new(), Vec::new(), Vec::new()];
        for k in 0..3 {
            Self::dedup(dict, &self.keys[k], &mut lists[k]);
        }
        let fits = |lru: &[Lru; 3]| (0..3).all(|k| lru[k].touched as usize + lists[k].iter().filter(|v| !lru[k].is_touched(v)).count() <= lru[k].max as usize);
        if !fits(&self.lru) {
            if self.rows.is_empty() {
                return Err("a statement needs more lookup entries than the lookups hold");
            }
            self.flush(dict);
        }
        for k in 0..3 {
            for v in &lists[k] {
                self.lru[k].use_value(v);
            }
        }
        self.rows.push([q[0], q[1], q[2], g]);
        if self.rows.len() as u32 >= self.frame_rows {
            self.flush(dict);
        }
        Ok(())
    }

    pub fn end_message(&mut self) -> R<()> {
        if self.stream_type != 1 {
            return Err("message boundaries in a FLAT stream");
        }
        self.ends.push(self.rows.len() as u32 - self.message_start);
        self.message_start = self.rows.len() as u32;
        Ok(())
    }

    /// Write the pending statements as a frame to `out` (delimited); returns whether it wrote one.
    pub fn flush(&mut self, dict: &Dict) -> bool {
        if self.rows.is_empty() && self.started && self.ends.is_empty() {
            return false;
        }
        let mut frame = Vec::new();
        let mut tmp = Vec::new();
        if !self.started {
            self.started = true;
            let mut o = Vec::new();
            uint(&mut o, 2, self.physical);
            uint(&mut o, 5, self.stream_type);
            uint(&mut o, 6, self.rdf_version);
            uint(&mut o, 9, self.max[0]);
            uint(&mut o, 10, self.max[1]);
            uint(&mut o, 11, self.max[2]);
            uint(&mut o, 15, VERSION);
            let mut row = Vec::new();
            bytes(&mut row, 1, &o);
            bytes(&mut frame, 1, &row);
        }
        if !self.rows.is_empty() || !self.ends.is_empty() {
            let mut b = Vec::new();
            uint(&mut b, 1, self.rows.len() as u32);
            self.lru[0].write(&mut b, 2, &mut tmp);
            self.lru[1].write(&mut b, 3, &mut tmp);
            self.lru[2].write(&mut b, 4, &mut tmp);
            if !self.rows.is_empty() {
                for c in 0..3 {
                    let col = self.column(c, dict);
                    bytes(&mut b, 6 + c as u32, &col);
                }
                if self.physical == 2 && self.rows.iter().any(|r| r[3] != 0) {
                    let col = self.column(3, dict);
                    bytes(&mut b, 9, &col);
                }
            }
            packed(&mut b, 15, &self.ends);
            bytes(&mut frame, 2, &b);
        }
        varint(&mut self.out, frame.len() as u64);
        self.out.extend_from_slice(&frame);
        self.rows.clear();
        self.ends.clear();
        self.message_start = 0;
        for l in &mut self.lru {
            l.end_batch();
        }
        true
    }

    fn name_prefix<'d>(&self, dict: &'d Dict, id: u32) -> (u32, u32) {
        let v = dict.value(id);
        let (prefix, name) = if self.max[1] != 0 { split(v) } else { (&v[..0], v) };
        (self.lru[0].get(name), if self.max[1] != 0 { self.lru[1].get(prefix) } else { 0 })
    }

    fn column(&self, c: usize, dict: &Dict) -> Vec<u8> {
        let rows = &self.rows;
        let mut values: Vec<u32> = Vec::new();
        let mut layouts: Vec<u32> = Vec::new();
        let mut skip = 0u32;
        let token = |layouts: &mut Vec<u32>, skip: &mut u32, kind: u32, len: u32| {
            let code = len.min(15);
            layouts.push(*skip * 32 + kind * 16 + code);
            if code == 15 {
                layouts.push(len - 15);
            }
            *skip = 0;
        };
        let mut i = 0;
        while i < rows.len() {
            let v = rows[i][c];
            let mut j = i + 1;
            if v == 0 {
                while j < rows.len() && rows[j][c] == 0 {
                    j += 1;
                }
                if j < rows.len() {
                    token(&mut layouts, &mut skip, 1, (j - i - 1) as u32);
                }
            } else {
                while j < rows.len() && rows[j][c] == v {
                    j += 1;
                }
                values.push(v);
                if j - i > 1 {
                    token(&mut layouts, &mut skip, 0, (j - i - 2) as u32);
                } else {
                    skip += 1;
                }
            }
            i = j;
        }
        let kind_of = |id: u32| match dict.term(id).map(|t| t.kind) {
            Some(IRI) => 0u8,
            Some(LITERAL) => 1,
            Some(BNODE) => 2,
            _ => 3,
        };
        let mut w = Vec::new();
        let types: Vec<u8> = values.iter().map(|&v| kind_of(v)).collect();
        if types.iter().any(|&t| t != types[0]) {
            let mut kinds = alloc::vec![0u8; types.len().div_ceil(4)];
            for (k, &t) in types.iter().enumerate() {
                kinds[k >> 2] |= t << (2 * (k & 3));
            }
            bytes(&mut w, 1, &kinds);
        }
        packed(&mut w, 2, &layouts);
        // IRIs: one sequence.
        let mut name_ids = Vec::new();
        let mut prefix_ids = Vec::new();
        let mut prev_name = 0;
        for (k, &v) in values.iter().enumerate() {
            if types[k] != 0 {
                continue;
            }
            let (n, p) = self.name_prefix(dict, v);
            name_ids.push(if n == prev_name + 1 { 0 } else { n });
            prev_name = n;
            if self.max[1] != 0 {
                prefix_ids.push(p);
            }
        }
        packed(&mut w, 3, &name_ids);
        if !prefix_ids.is_empty() {
            if prefix_ids.iter().all(|&p| p == prefix_ids[0]) {
                packed(&mut w, 4, &prefix_ids[..1]);
            } else {
                let m: Vec<u32> = prefix_ids.iter().enumerate().map(|(k, &p)| if k > 0 && p == prefix_ids[k - 1] { 0 } else { p }).collect();
                packed(&mut w, 4, &m);
            }
        }
        // Literals.
        let mut langs: Vec<(&[u8], u32)> = Vec::new();
        let mut literal_kinds = Vec::new();
        for (k, &v) in values.iter().enumerate() {
            if types[k] != 1 {
                continue;
            }
            let t = dict.term(v).unwrap();
            let lang = dict.lang(v);
            literal_kinds.push(if !lang.is_empty() {
                let dir = t.dir as u32;
                let j = match langs.iter().position(|&(l, d)| l == lang && d == dir) {
                    Some(j) => j,
                    None => {
                        langs.push((lang, dir));
                        langs.len() - 1
                    }
                };
                2 * (j as u32 + 1)
            } else if t.a == XSD_STRING {
                0
            } else {
                2 * self.lru[2].get(dict.value(t.a)) - 1
            });
            bytes(&mut w, 5, dict.value(v));
        }
        if !literal_kinds.is_empty() {
            if literal_kinds.iter().any(|&x| x != literal_kinds[0]) {
                packed(&mut w, 6, &literal_kinds);
            } else if literal_kinds[0] != 0 {
                packed(&mut w, 6, &literal_kinds[..1]);
            }
        }
        for &(l, _) in &langs {
            bytes(&mut w, 7, l);
        }
        if langs.iter().any(|&(_, d)| d != 0) {
            let dirs: Vec<u32> = langs.iter().map(|&(_, d)| d).collect();
            packed(&mut w, 8, &dirs);
        }
        for (k, &v) in values.iter().enumerate() {
            if types[k] == 2 {
                bytes(&mut w, 9, dict.value(v));
            }
        }
        let mut seq = [0u32; 2];
        for (k, &v) in values.iter().enumerate() {
            if types[k] == 3 {
                let tt = self.triple_term(dict, v, &mut seq);
                bytes(&mut w, 10, &tt);
            }
        }
        w
    }

    fn rdf_iri(&self, dict: &Dict, id: u32, seq: &mut [u32; 2]) -> Vec<u8> {
        let (n, p) = self.name_prefix(dict, id);
        let mut w = Vec::new();
        uint(&mut w, 1, if p == seq[0] { 0 } else { p });
        uint(&mut w, 2, if n == seq[1] + 1 { 0 } else { n });
        if p != 0 {
            seq[0] = p;
        }
        seq[1] = n;
        w
    }

    fn triple_term(&self, dict: &Dict, id: u32, seq: &mut [u32; 2]) -> Vec<u8> {
        let t = *dict.term(id).unwrap();
        let mut w = Vec::new();
        if dict.term(t.a).unwrap().kind == IRI {
            let x = self.rdf_iri(dict, t.a, seq);
            bytes(&mut w, 1, &x);
        } else {
            bytes(&mut w, 2, dict.value(t.a));
        }
        let x = self.rdf_iri(dict, t.b, seq);
        bytes(&mut w, 5, &x);
        let o = *dict.term(t.c).unwrap();
        match o.kind {
            IRI => {
                let x = self.rdf_iri(dict, t.c, seq);
                bytes(&mut w, 9, &x);
            }
            BNODE => bytes(&mut w, 10, dict.value(t.c)),
            LITERAL => {
                let mut l = Vec::new();
                let lex = dict.value(t.c);
                if !lex.is_empty() {
                    bytes(&mut l, 1, lex);
                }
                let lang = dict.lang(t.c);
                if !lang.is_empty() {
                    bytes(&mut l, 2, lang);
                    uint(&mut l, 4, o.dir as u32);
                } else if o.a != XSD_STRING {
                    uint(&mut l, 3, self.lru[2].get(dict.value(o.a)));
                }
                bytes(&mut w, 11, &l);
            }
            _ => {
                let x = self.triple_term(dict, t.c, seq);
                bytes(&mut w, 12, &x);
            }
        }
        w
    }
}

