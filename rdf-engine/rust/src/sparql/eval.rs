//! Evaluation: patterns to solution rows (one term id per variable, 0 = unbound).
//!
//! `eval(p, sub)` evaluates `p` with the bindings in `sub` substituted, which is
//! both how bound query variables work and the semantics of EXISTS and LATERAL.
//! Joins pass rows sideways into "pure" patterns (triples, paths, VALUES, and
//! unions or joins of them), where substitution cannot change the result, and
//! otherwise join independently evaluated sides.

use super::expr::{R, Val};
use super::regex::Regex;
use super::*;
use crate::dict::{self, DEFAULT_GRAPH_ID, Dict, Key, NONE};
use crate::store::Store;
use crate::idmap::{IdMap, bytes_key};
use alloc::rc::Rc;
use core::cmp::Ordering;

pub type Row = Vec<u32>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Active {
    Default,
    Named(u32),
}

pub struct Ctx<'a> {
    pub dict: &'a mut Dict,
    pub store: &'a Store,
    /// The graphs whose union is the default graph.
    pub default: Vec<u32>,
    /// The named graphs; `None`: every graph in the store.
    pub named: Option<Vec<u32>>,
    pub base: &'a [u8],
    pub nvars: usize,
    pub now_ms: f64,
    /// Datatype kinds by datatype id (`Dt as u32`).
    pub dt_cache: IdMap,
    /// Compiled regexes by pattern and flags (an index into `regex_list`).
    regexes: IdMap,
    regex_list: Vec<Rc<Regex>>,
    /// BNODE(str) per solution and string.
    bnodes: IdMap,
    scan: Vec<u32>,
    /// The active graph of the pattern being evaluated (for EXISTS in expressions).
    active: Active,
}

impl<'a> Ctx<'a> {
    pub fn new(dict: &'a mut Dict, store: &'a Store, default: Vec<u32>, named: Option<Vec<u32>>, base: &'a [u8], nvars: usize) -> Self {
        Ctx {
            dict,
            store,
            default,
            named,
            base,
            nvars,
            now_ms: crate::host::now(),
            dt_cache: IdMap::new(),
            regexes: IdMap::new(),
            regex_list: Vec::new(),
            bnodes: IdMap::new(),
            scan: Vec::new(),
            active: Active::Default,
        }
    }

    pub fn random(&mut self) -> f64 {
        crate::host::random()
    }

    pub fn uuid(&mut self) -> Vec<u8> {
        let mut b = [0u8; 16];
        for x in b.iter_mut() {
            *x = (self.random() * 256.0) as u8;
        }
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        let mut out = Vec::with_capacity(36);
        for (i, x) in b.iter().enumerate() {
            if matches!(i, 4 | 6 | 8 | 10) {
                out.push(b'-');
            }
            out.push(b"0123456789abcdef"[(x >> 4) as usize]);
            out.push(b"0123456789abcdef"[(x & 15) as usize]);
        }
        out
    }

    pub fn now_lexical(&self) -> Vec<u8> {
        let ms = self.now_ms as i64;
        let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
        let (y, m, d) = super::expr::civil_from_days(days);
        let mut out = Vec::new();
        let two = |out: &mut Vec<u8>, n: u32| {
            out.push(b'0' + (n / 10) as u8);
            out.push(b'0' + (n % 10) as u8);
        };
        super::num::write_int(&mut out, y as i128);
        out.push(b'-');
        two(&mut out, m);
        out.push(b'-');
        two(&mut out, d);
        out.push(b'T');
        two(&mut out, (rem / 3_600_000) as u32);
        out.push(b':');
        two(&mut out, (rem / 60_000 % 60) as u32);
        out.push(b':');
        two(&mut out, (rem / 1000 % 60) as u32);
        out.push(b'.');
        let msec = (rem % 1000) as u32;
        out.push(b'0' + (msec / 100) as u8);
        two(&mut out, msec % 100);
        out.push(b'Z');
        out
    }

    pub fn regex(&mut self, pattern: &[u8], flags: &[u8]) -> R<Rc<Regex>> {
        let mut key = bytes_key(pattern);
        key.extend(bytes_key(flags));
        if let Some(i) = self.regexes.get(&key) {
            return Ok(self.regex_list[i as usize].clone());
        }
        let r = Rc::new(super::regex::compile(pattern, flags).ok_or(())?);
        self.regex_list.push(r.clone());
        self.regexes.insert(&key, self.regex_list.len() as u32 - 1);
        Ok(r)
    }

    pub fn bnode_for(&mut self, row: &[u32], s: &[u8]) -> u32 {
        let mut key = row.to_vec();
        key.extend(bytes_key(s));
        if let Some(b) = self.bnodes.get(&key) {
            return b;
        }
        let b = self.dict.fresh_bnode();
        self.bnodes.insert(&key, b);
        b
    }

    pub fn exists(&mut self, p: &Pattern, row: &[u32]) -> bool {
        let active = self.active;
        !self.eval(p, row, active).is_empty()
    }

    fn graphs(&self, active: Active) -> Vec<u32> {
        match active {
            Active::Default => self.default.clone(),
            Active::Named(g) => alloc::vec![g],
        }
    }

    pub fn named_graphs(&self) -> Vec<u32> {
        match &self.named {
            Some(n) => n.clone(),
            None => self.store.graphs().into_iter().filter(|&g| g != DEFAULT_GRAPH_ID).collect(),
        }
    }

    // --- patterns ----------------------------------------------------------------

    pub fn eval(&mut self, p: &Pattern, sub: &[u32], active: Active) -> Vec<Row> {
        let outer = core::mem::replace(&mut self.active, active);
        let rows = self.eval_in(p, sub, active);
        self.active = outer;
        rows
    }

    fn eval_in(&mut self, p: &Pattern, sub: &[u32], active: Active) -> Vec<Row> {
        match p {
            Pattern::Unit => alloc::vec![sub.to_vec()],
            Pattern::Bgp(ts) => self.bgp(ts, sub, active),
            Pattern::Path(s, path, o) => self.path(s, path, o, sub, active),
            Pattern::Join(a, b) => {
                let left = self.eval(a, sub, active);
                if pure(b) {
                    let mut out = Vec::new();
                    for r in &left {
                        out.extend(self.eval(b, r, active));
                    }
                    out
                } else {
                    let right = self.eval(b, sub, active);
                    join_rows(left, &right)
                }
            }
            Pattern::LeftJoin(a, b, f) => {
                let left = self.eval(a, sub, active);
                let mut out = Vec::new();
                if pure(b) {
                    for r in left {
                        let mut any = false;
                        for m in self.eval(b, &r, active) {
                            if f.as_ref().is_none_or(|f| self.test(f, &m)) {
                                out.push(m);
                                any = true;
                            }
                        }
                        if !any {
                            out.push(r);
                        }
                    }
                } else {
                    let right = self.eval(b, sub, active);
                    for r in left {
                        let mut any = false;
                        for x in &right {
                            if let Some(m) = merge(&r, x) {
                                if f.as_ref().is_none_or(|f| self.test(f, &m)) {
                                    out.push(m);
                                    any = true;
                                }
                            }
                        }
                        if !any {
                            out.push(r);
                        }
                    }
                }
                out
            }
            Pattern::Filter(f, a) => {
                let rows = self.eval(a, sub, active);
                rows.into_iter().filter(|r| self.test(f, r)).collect()
            }
            Pattern::Union(a, b) => {
                let mut rows = self.eval(a, sub, active);
                rows.extend(self.eval(b, sub, active));
                rows
            }
            Pattern::Minus(a, b) => {
                let left = self.eval(a, sub, active);
                let right = self.eval(b, sub, active);
                left.into_iter()
                    .filter(|l| {
                        !right.iter().any(|r| {
                            let mut shared = false;
                            for (x, y) in l.iter().zip(r) {
                                if *x != NONE && *y != NONE {
                                    if x != y {
                                        return false;
                                    }
                                    shared = true;
                                }
                            }
                            shared
                        })
                    })
                    .collect()
            }
            Pattern::Graph(g, a) => {
                let mut out = Vec::new();
                match resolve(g, sub) {
                    Some(id) => {
                        if self.named_graphs().contains(&id) {
                            out = self.eval(a, sub, Active::Named(id));
                        }
                    }
                    None => {
                        let Tv::Var(v) = g else { return out };
                        for id in self.named_graphs() {
                            for mut r in self.eval(a, sub, Active::Named(id)) {
                                let slot = &mut r[*v as usize];
                                if *slot == NONE || *slot == id {
                                    *slot = id;
                                    out.push(r);
                                }
                            }
                        }
                    }
                }
                out
            }
            Pattern::Extend(a, v, e) => {
                let mut rows = self.eval(a, sub, active);
                for r in rows.iter_mut() {
                    if let Ok(val) = self.expr(e, r) {
                        r[*v as usize] = self.to_id(&val);
                    }
                }
                rows
            }
            Pattern::Values(vars, data) => {
                let mut out = Vec::new();
                'rows: for d in data {
                    let mut r = sub.to_vec();
                    for (v, &t) in vars.iter().zip(d) {
                        if t == NONE {
                            continue;
                        }
                        let slot = &mut r[*v as usize];
                        if *slot != NONE && *slot != t {
                            continue 'rows;
                        }
                        *slot = t;
                    }
                    out.push(r);
                }
                out
            }
            Pattern::Lateral(a, b) => {
                let left = self.eval(a, sub, active);
                let mut out = Vec::new();
                for r in &left {
                    for x in self.eval(b, r, active) {
                        if let Some(m) = merge(r, &x) {
                            out.push(m);
                        }
                    }
                }
                out
            }
            Pattern::Sub(s) => self.select(s, sub, active),
            Pattern::Service(silent) => {
                if *silent {
                    alloc::vec![sub.to_vec()]
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn test(&mut self, f: &Expr, row: &[u32]) -> bool {
        self.expr(f, row).and_then(|v| self.ebv(&v)) == Ok(true)
    }

    /// A basic graph pattern: index nested loops, most-bound pattern first.
    fn bgp(&mut self, ts: &[Triple], sub: &[u32], active: Active) -> Vec<Row> {
        let mut bound: Vec<bool> = sub.iter().map(|&x| x != NONE).collect();
        let mut left: Vec<&Triple> = ts.iter().collect();
        let mut rows = alloc::vec![sub.to_vec()];
        while !left.is_empty() {
            let score = |t: &Triple, bound: &[bool]| {
                let b = |x: &Tv, w: u32| match x {
                    Tv::Term(_) => w,
                    Tv::Var(v) if bound[*v as usize] => w,
                    _ => 0,
                };
                b(&t.s, 4) + b(&t.o, 3) + b(&t.p, 1)
            };
            let (i, _) = left.iter().enumerate().max_by_key(|(i, t)| (score(t, &bound), usize::MAX - i)).unwrap();
            let t = left.remove(i);
            let mut next = Vec::new();
            for r in &rows {
                self.triple(t, r, active, &mut next);
            }
            rows = next;
            if rows.is_empty() {
                return rows;
            }
            for x in [&t.s, &t.p, &t.o] {
                mark(x, &mut bound);
            }
        }
        rows
    }

    /// Extend `row` with every match of one triple pattern.
    fn triple(&mut self, t: &Triple, row: &[u32], active: Active, out: &mut Vec<Row>) {
        // The id to scan for at a position: 0 when free; None when it cannot match.
        let pos = |x: &Tv, me: &Self| -> Option<u32> {
            match x {
                Tv::Term(i) => Some(*i),
                Tv::Var(v) => Some(row[*v as usize]),
                Tv::Triple(b) => match (resolve(&b[0], row), resolve(&b[1], row), resolve(&b[2], row)) {
                    // A ground triple term matches only if it was ever interned.
                    (Some(s), Some(p), Some(o)) => match me.dict.get(Key::triple(s, p, o)) {
                        NONE => None,
                        id => Some(id),
                    },
                    _ => Some(NONE),
                },
            }
        };
        let (Some(s), Some(p), Some(o)) = (pos(&t.s, self), pos(&t.p, self), pos(&t.o, self)) else { return };
        let graphs = self.graphs(active);
        let dedupe = graphs.len() > 1;
        let mut seen = IdMap::new();
        let mut scan = core::mem::take(&mut self.scan);
        for g in graphs {
            scan.clear();
            self.store.scan([s, p, o, g], &mut scan);
            for q in scan.chunks_exact(4) {
                if dedupe && !seen.add(&q[..3]) {
                    continue;
                }
                let mut r = row.to_vec();
                if bind(&t.s, q[0], &mut r, self.dict) && bind(&t.p, q[1], &mut r, self.dict) && bind(&t.o, q[2], &mut r, self.dict) {
                    out.push(r);
                }
            }
        }
        self.scan = scan;
    }

    // --- property paths ------------------------------------------------------------

    fn path(&mut self, s: &Tv, path: &Path, o: &Tv, sub: &[u32], active: Active) -> Vec<Row> {
        let (sb, ob) = (resolve(s, sub), resolve(o, sub));
        let pairs = self.pairs(path, sb, ob, active);
        let mut out = Vec::new();
        for (x, y) in pairs {
            // A zero-length match at a variable endpoint must be a node of the graph.
            // (A constant endpoint matches itself even outside the graph.)
            let constant = matches!(s, Tv::Term(_)) || matches!(o, Tv::Term(_));
            if x == y && !constant && !self.is_node(x, active) {
                continue;
            }
            let mut r = sub.to_vec();
            if bind(s, x, &mut r, self.dict) && bind(o, y, &mut r, self.dict) {
                out.push(r);
            }
        }
        out
    }

    fn scan_pairs(&mut self, s: u32, p: u32, o: u32, active: Active, out: &mut Vec<(u32, u32, u32)>) {
        let graphs = self.graphs(active);
        let dedupe = graphs.len() > 1;
        let mut seen = IdMap::new();
        let mut scan = core::mem::take(&mut self.scan);
        for g in graphs {
            scan.clear();
            self.store.scan([s, p, o, g], &mut scan);
            for q in scan.chunks_exact(4) {
                if !dedupe || seen.add(&q[..3]) {
                    out.push((q[0], q[1], q[2]));
                }
            }
        }
        self.scan = scan;
    }

    /// The (start, end) pairs of a path, with either end optionally fixed.
    fn pairs(&mut self, path: &Path, s: Option<u32>, o: Option<u32>, active: Active) -> Vec<(u32, u32)> {
        let (s0, o0) = (s.unwrap_or(NONE), o.unwrap_or(NONE));
        match path {
            Path::Iri(p) => {
                let mut t = Vec::new();
                self.scan_pairs(s0, *p, o0, active, &mut t);
                t.into_iter().map(|(a, _, b)| (a, b)).collect()
            }
            Path::Inverse(q) => self.pairs(q, o, s, active).into_iter().map(|(a, b)| (b, a)).collect(),
            Path::Alt(a, b) => {
                let mut v = self.pairs(a, s, o, active);
                v.extend(self.pairs(b, s, o, active));
                v
            }
            Path::Seq(a, b) => {
                let mut out = Vec::new();
                // Each middle node's continuations, computed once.
                let (mut index, mut cached) = (IdMap::new(), Vec::<Vec<(u32, u32)>>::new());
                if s.is_some() || o.is_none() {
                    for (x, m) in self.pairs(a, s, None, active) {
                        let i = match index.get(&[m]) {
                            Some(i) => i as usize,
                            None => {
                                cached.push(self.pairs(b, Some(m), o, active));
                                index.insert(&[m], cached.len() as u32 - 1);
                                cached.len() - 1
                            }
                        };
                        out.extend(cached[i].iter().map(|&(_, y)| (x, y)));
                    }
                } else {
                    for (m, y) in self.pairs(b, None, o, active) {
                        let i = match index.get(&[m]) {
                            Some(i) => i as usize,
                            None => {
                                cached.push(self.pairs(a, None, Some(m), active));
                                index.insert(&[m], cached.len() as u32 - 1);
                                cached.len() - 1
                            }
                        };
                        out.extend(cached[i].iter().map(|&(x, _)| (x, y)));
                    }
                }
                out
            }
            Path::ZeroOrOne(q) => {
                let mut seen = IdMap::new();
                let mut out = Vec::new();
                let zero: Vec<(u32, u32)> = self.zero_nodes(s, o, active).into_iter().map(|n| (n, n)).collect();
                for (a, b) in zero.into_iter().chain(self.pairs(q, s, o, active)) {
                    if seen.add(&[a, b]) {
                        out.push((a, b));
                    }
                }
                out
            }
            Path::ZeroOrMore(q) | Path::OneOrMore(q) => {
                let zero = matches!(path, Path::ZeroOrMore(_));
                let mut out = Vec::new();
                if let Some(start) = s {
                    for n in self.closure(q, start, zero, false, active) {
                        if o.is_none_or(|o| o == n) {
                            out.push((start, n));
                        }
                    }
                } else if let Some(end) = o {
                    for n in self.closure(q, end, zero, true, active) {
                        out.push((n, end));
                    }
                } else {
                    for n in self.nodes(active) {
                        for m in self.closure(q, n, zero, false, active) {
                            out.push((n, m));
                        }
                    }
                }
                out
            }
            Path::Negated(fwd, inv) => {
                let mut out = Vec::new();
                if !fwd.is_empty() || inv.is_empty() {
                    let mut t = Vec::new();
                    self.scan_pairs(s0, NONE, o0, active, &mut t);
                    out.extend(t.into_iter().filter(|(_, p, _)| !fwd.contains(p)).map(|(a, _, b)| (a, b)));
                }
                if !inv.is_empty() {
                    let mut t = Vec::new();
                    self.scan_pairs(o0, NONE, s0, active, &mut t);
                    out.extend(t.into_iter().filter(|(_, p, _)| !inv.contains(p)).map(|(a, _, b)| (b, a)));
                }
                out
            }
        }
    }

    fn is_node(&mut self, n: u32, active: Active) -> bool {
        let mut scan = core::mem::take(&mut self.scan);
        let mut found = false;
        for g in self.graphs(active) {
            scan.clear();
            self.store.scan([n, 0, 0, g], &mut scan);
            if scan.is_empty() {
                self.store.scan([0, 0, n, g], &mut scan);
            }
            if !scan.is_empty() {
                found = true;
                break;
            }
        }
        self.scan = scan;
        found
    }

    /// Nodes a zero-length path can start (and end) at.
    fn zero_nodes(&mut self, s: Option<u32>, o: Option<u32>, active: Active) -> Vec<u32> {
        match (s, o) {
            (Some(a), Some(b)) => if a == b { alloc::vec![a] } else { Vec::new() },
            (Some(a), None) | (None, Some(a)) => alloc::vec![a],
            (None, None) => self.nodes(active),
        }
    }

    fn nodes(&mut self, active: Active) -> Vec<u32> {
        let mut t = Vec::new();
        self.scan_pairs(NONE, NONE, NONE, active, &mut t);
        let mut seen = IdMap::new();
        let mut out = Vec::new();
        for (a, _, b) in t {
            for n in [a, b] {
                if seen.add(&[n]) {
                    out.push(n);
                }
            }
        }
        out
    }

    /// Nodes reachable from `start` by one or more steps of `q` (or zero, with `zero`).
    fn closure(&mut self, q: &Path, start: u32, zero: bool, backwards: bool, active: Active) -> Vec<u32> {
        let mut seen = IdMap::new();
        let mut out = Vec::new();
        if zero {
            seen.add(&[start]);
            out.push(start);
        }
        let mut frontier = alloc::vec![start];
        while let Some(n) = frontier.pop() {
            let next = if backwards { self.pairs(q, None, Some(n), active).into_iter().map(|(a, _)| a).collect::<Vec<_>>() } else { self.pairs(q, Some(n), None, active).into_iter().map(|(_, b)| b).collect() };
            for m in next {
                if seen.add(&[m]) {
                    out.push(m);
                    frontier.push(m);
                }
            }
        }
        out
    }

    // --- queries -------------------------------------------------------------------

    pub fn select(&mut self, s: &Select, sub: &[u32], active: Active) -> Vec<Row> {
        let mut rows = self.eval(&s.pattern, sub, active);
        if s.group.is_some() || !s.aggregates.is_empty() {
            rows = self.group(s, rows);
            rows.retain(|r| s.having.iter().all(|h| self.test_owned(h, r)));
        }
        if let Some(v) = &s.values {
            let data = self.eval(v, &alloc::vec![NONE; self.nvars], active);
            rows = join_rows(rows, &data);
        }
        for (v, e) in &s.extend {
            for r in rows.iter_mut() {
                if let Ok(val) = self.expr(e, r) {
                    r[*v as usize] = self.to_id(&val);
                }
            }
        }
        if !s.order.is_empty() {
            let mut keyed: Vec<(Vec<Option<Val>>, Row)> = rows.into_iter().map(|r| (s.order.iter().map(|(e, _)| self.expr(e, &r).ok()).collect(), r)).collect();
            keyed.sort_unstable_by(|(a, _), (b, _)| {
                for (i, (_, desc)) in s.order.iter().enumerate() {
                    let o = self.sort_cmp(a[i].as_ref(), b[i].as_ref());
                    if o != Ordering::Equal {
                        return if *desc { o.reverse() } else { o };
                    }
                }
                Ordering::Equal
            });
            rows = keyed.into_iter().map(|(_, r)| r).collect();
        }
        // Projection: keep only the projected variables.
        let mut keep = alloc::vec![false; self.nvars];
        for &v in &s.project {
            keep[v as usize] = true;
        }
        for r in rows.iter_mut() {
            for (i, x) in r.iter_mut().enumerate() {
                if !keep[i] {
                    *x = NONE;
                }
            }
        }
        if s.distinct || s.reduced {
            let mut seen = IdMap::new();
            rows.retain(|r| seen.add(r));
        }
        let rows: Vec<Row> = rows.into_iter().skip(s.offset).take(s.limit.unwrap_or(usize::MAX)).collect();
        rows
    }

    fn test_owned(&mut self, f: &Expr, row: &[u32]) -> bool {
        self.test(f, row)
    }

    fn group(&mut self, s: &Select, rows: Vec<Row>) -> Vec<Row> {
        let keys = s.group.as_deref().unwrap_or(&[]);
        // Groups in order of first appearance.
        let mut index = IdMap::new();
        let mut groups: Vec<(Row, Vec<Row>)> = Vec::new();
        for r in rows {
            let key: Row = keys.iter().map(|(e, _)| self.expr(e, &r).map(|v| self.to_id(&v)).unwrap_or(NONE)).collect();
            let (i, new) = index.insert(&key, groups.len() as u32);
            if new {
                groups.push((key, Vec::new()));
            }
            groups[i as usize].1.push(r);
        }
        if keys.is_empty() && groups.is_empty() {
            groups.push((Vec::new(), Vec::new()));
        }
        let mut out = Vec::new();
        for (key, members) in groups {
            let mut r = alloc::vec![NONE; self.nvars];
            for ((e, v), k) in keys.iter().zip(&key) {
                match (e, v) {
                    (_, Some(v)) => r[*v as usize] = *k,
                    (Expr::Var(v), None) => r[*v as usize] = *k,
                    _ => {}
                }
            }
            for (v, agg) in &s.aggregates {
                r[*v as usize] = self.aggregate(agg, &members).map_or(NONE, |val| self.to_id(&val));
            }
            out.push(r);
        }
        out
    }

    fn aggregate(&mut self, a: &Aggregate, rows: &[Row]) -> R<Val> {
        use super::num::Num;
        let Some(e) = &a.expr else {
            let n = if a.distinct {
                let mut seen = IdMap::new();
                rows.iter().filter(|r| seen.add(r)).count()
            } else {
                rows.len()
            };
            return Ok(Val::Num(Num::Int(n as i128)));
        };
        let mut vals: Vec<R<Val>> = rows.iter().map(|r| self.expr(e, r)).collect();
        if a.distinct {
            let mut seen = IdMap::new();
            let mut kept = Vec::new();
            for v in vals {
                match v {
                    Ok(v) => {
                        let id = self.to_id(&v);
                        if seen.add(&[id]) {
                            kept.push(Ok(Val::Id(id)));
                        }
                    }
                    Err(()) => kept.push(Err(())),
                }
            }
            vals = kept;
        }
        match a.kind {
            AggKind::Count => Ok(Val::Num(Num::Int(vals.iter().filter(|v| v.is_ok()).count() as i128))),
            AggKind::Sum | AggKind::Avg => {
                let mut total = Num::Int(0);
                let mut n = 0i128;
                for v in vals {
                    let x = self.num(&v?).ok_or(())?;
                    total = super::num::arith(Op::Add, total, x).ok_or(())?;
                    n += 1;
                }
                if a.kind == AggKind::Sum || n == 0 {
                    return Ok(Val::Num(total));
                }
                super::num::arith(Op::Div, total, Num::Int(n)).map(Val::Num).ok_or(())
            }
            AggKind::Min | AggKind::Max => {
                let mut best: Option<Val> = None;
                for v in vals.into_iter().flatten() {
                    best = Some(match best {
                        None => v,
                        Some(b) => {
                            let o = self.sort_cmp(Some(&v), Some(&b));
                            if (a.kind == AggKind::Min) == (o == Ordering::Less) && o != Ordering::Equal { v } else { b }
                        }
                    });
                }
                best.ok_or(())
            }
            AggKind::Sample => vals.into_iter().flatten().next().ok_or(()),
            AggKind::GroupConcat => {
                let mut out = Vec::new();
                for (i, v) in vals.into_iter().enumerate() {
                    let (s, _) = self.string(&v?)?;
                    if i > 0 {
                        out.extend_from_slice(&a.separator);
                    }
                    out.extend_from_slice(&s);
                }
                Ok(Val::Str(out, None))
            }
        }
    }
}

/// Whether evaluating with extra bindings substituted equals joining with them.
/// True for matching (triples, paths, VALUES, and joins and unions of them),
/// and for BIND / FILTER over such a pattern when the expression only reads
/// variables the pattern always binds: a substituted value then equals the
/// pattern's own, so the expression cannot tell.
fn pure(p: &Pattern) -> bool {
    match p {
        Pattern::Unit | Pattern::Bgp(_) | Pattern::Values(..) => true,
        // (A zero-length match at a variable endpoint is checked in `path`.)
        Pattern::Path(..) => true,
        Pattern::Join(a, b) | Pattern::Union(a, b) => pure(a) && pure(b),
        Pattern::Graph(_, a) => pure(a),
        Pattern::Extend(a, _, e) | Pattern::Filter(e, a) => pure(a) && reads_only(e, &certain(a)),
        _ => false,
    }
}

/// Variables a pattern binds in every solution.
fn certain(p: &Pattern) -> Vec<Var> {
    let mut out = Vec::new();
    match p {
        Pattern::Bgp(ts) => {
            for t in ts {
                for x in [&t.s, &t.p, &t.o] {
                    tv_vars(x, &mut out);
                }
            }
        }
        Pattern::Path(s, _, o) => {
            tv_vars(s, &mut out);
            tv_vars(o, &mut out);
        }
        Pattern::Join(a, b) => {
            out = certain(a);
            out.extend(certain(b));
        }
        Pattern::Union(a, b) => {
            let right = certain(b);
            out = certain(a).into_iter().filter(|v| right.contains(v)).collect();
        }
        Pattern::Graph(g, a) => {
            out = certain(a);
            tv_vars(g, &mut out);
        }
        Pattern::Extend(a, _, _) | Pattern::Filter(_, a) => out = certain(a),
        Pattern::Values(vars, rows) => out = vars.iter().enumerate().filter(|(i, _)| rows.iter().all(|r| r[*i] != NONE)).map(|(_, v)| *v).collect(),
        _ => {}
    }
    out
}

fn tv_vars(t: &Tv, out: &mut Vec<Var>) {
    match t {
        Tv::Var(v) => out.push(*v),
        Tv::Triple(b) => b.iter().for_each(|x| tv_vars(x, out)),
        Tv::Term(_) => {}
    }
}

/// Whether an expression reads only `vars` (and has no EXISTS, which sees more).
fn reads_only(e: &Expr, vars: &[Var]) -> bool {
    match e {
        Expr::Var(v) | Expr::Bound(v) => vars.contains(v),
        Expr::Const(_) | Expr::Unknown => true,
        Expr::Exists(..) => false,
        Expr::Or(a, b) | Expr::And(a, b) | Expr::Cmp(_, a, b) | Expr::Arith(_, a, b) => reads_only(a, vars) && reads_only(b, vars),
        Expr::Not(a) | Expr::Neg(a) | Expr::Plus(a) | Expr::Cast(_, a) => reads_only(a, vars),
        Expr::In(a, l, _) => reads_only(a, vars) && l.iter().all(|x| reads_only(x, vars)),
        Expr::Call(_, l) | Expr::Coalesce(l) => l.iter().all(|x| reads_only(x, vars)),
        Expr::If(a, b, c) => reads_only(a, vars) && reads_only(b, vars) && reads_only(c, vars),
    }
}

fn mark(x: &Tv, bound: &mut [bool]) {
    match x {
        Tv::Var(v) => bound[*v as usize] = true,
        Tv::Triple(b) => b.iter().for_each(|y| mark(y, bound)),
        Tv::Term(_) => {}
    }
}

/// A position's value under a row, if it is fixed.
fn resolve(x: &Tv, row: &[u32]) -> Option<u32> {
    match x {
        Tv::Term(i) => Some(*i),
        Tv::Var(v) => match row[*v as usize] {
            NONE => None,
            id => Some(id),
        },
        Tv::Triple(_) => None,
    }
}

/// Bind a pattern position to a term; false if it conflicts.
fn bind(x: &Tv, id: u32, row: &mut [u32], dict: &Dict) -> bool {
    match x {
        Tv::Term(t) => *t == id,
        Tv::Var(v) => {
            let slot = &mut row[*v as usize];
            if *slot == NONE {
                *slot = id;
                true
            } else {
                *slot == id
            }
        }
        Tv::Triple(b) => match dict.term(id) {
            Some(t) if t.kind == dict::TRIPLE => {
                let (s, p, o) = (t.a, t.b, t.c);
                bind(&b[0], s, row, dict) && bind(&b[1], p, row, dict) && bind(&b[2], o, row, dict)
            }
            _ => false,
        },
    }
}

pub fn merge(a: &[u32], b: &[u32]) -> Option<Row> {
    let mut r = a.to_vec();
    for (x, &y) in r.iter_mut().zip(b) {
        if y != NONE {
            if *x == NONE {
                *x = y;
            } else if *x != y {
                return None;
            }
        }
    }
    Some(r)
}

/// Join two sets of rows; hashes on a variable bound on both sides throughout.
pub fn join_rows(left: Vec<Row>, right: &[Row]) -> Vec<Row> {
    let mut out = Vec::new();
    if left.is_empty() || right.is_empty() {
        return out;
    }
    let n = left[0].len();
    let key = (0..n).find(|&v| left.iter().all(|r| r[v] != NONE) && right.iter().all(|r| r[v] != NONE));
    match key {
        Some(v) => {
            // Right rows by key value: (first, next) chains through `next`.
            let mut first = IdMap::new();
            let mut next = alloc::vec![u32::MAX; right.len()];
            for (i, r) in right.iter().enumerate().rev() {
                let (head, new) = first.insert(&[r[v]], i as u32);
                if !new {
                    next[i] = head;
                    first.set(&[r[v]], i as u32);
                }
            }
            for l in &left {
                if let Some(head) = first.get(&[l[v]]) {
                    let mut at = head;
                    while at != u32::MAX {
                        let i = at as usize;
                        at = next[i];
                        if let Some(m) = merge(l, &right[i]) {
                            out.push(m);
                        }
                    }
                }
            }
        }
        None => {
            for l in &left {
                for r in right {
                    if let Some(m) = merge(l, r) {
                        out.push(m);
                    }
                }
            }
        }
    }
    out
}
