//! Fetching (ABI.md, "Optional: fetching"): the requests a run made for
//! `SERVICE` results and `LOAD`ed documents, and the host's answers. A run
//! that asks for something not answered yet goes on as if it had no
//! solutions there and ends "waiting" (-3); the host answers and runs it again.

use alloc::vec::Vec;
use core::cell::UnsafeCell;

pub const WAITING: u32 = 0;
pub const ANSWERED: u32 = 1;
pub const FAILED: u32 = 2;
pub const SERVICE: u32 = 1;
pub const LOAD: u32 = 2;

pub struct Req {
    pub state: u32,
    /// The last run or update waited on it (only these are the host's to fetch then).
    pub asked: bool,
    pub kind: u32,
    /// The endpoint's or the document's IRI.
    pub target: u32,
    /// SERVICE: the query to send; LOAD: empty.
    pub text: Vec<u8>,
    /// SERVICE: the pattern's in-scope variables (the width of a row).
    pub names: Vec<Vec<u8>>,
    /// Binding rows, `names.len()` ids each (0 = not sent); they bind the same positions.
    pub rows: Vec<u32>,
    pub nrows: u32,
    /// SERVICE: solutions, `names.len()` ids each; LOAD: triples.
    pub answer: Vec<u32>,
    pub nanswer: u32,
    pub why: Vec<u8>,
}

impl Req {
    fn width(&self) -> usize {
        self.names.len()
    }

    fn row(&self, i: usize) -> &[u32] {
        let w = self.width();
        &self.rows[i * w..(i + 1) * w]
    }

    fn holds(&self, row: &[u32]) -> bool {
        (0..self.nrows as usize).any(|i| self.row(i) == row)
    }

    /// Whether `row` binds the positions this request's rows bind.
    fn same_domain(&self, row: &[u32]) -> bool {
        self.nrows == 0 || self.row(0).iter().zip(row).all(|(&a, &b)| (a == 0) == (b == 0))
    }
}

pub struct Fetch {
    pub reqs: Vec<Req>,
    /// This run asked for something not answered yet.
    pub waiting: bool,
    /// This run failed on a failed request (not SILENT).
    pub error: Option<Vec<u8>>,
}

struct Global(UnsafeCell<Fetch>);

// Wasm without threads: there is one caller at a time.
unsafe impl Sync for Global {}

static F: Global = Global(UnsafeCell::new(Fetch { reqs: Vec::new(), waiting: false, error: None }));

pub fn f() -> &'static mut Fetch {
    unsafe { &mut *F.0.get() }
}

/// At the start of a run or update.
pub fn start() {
    let f = f();
    f.waiting = false;
    f.error = None;
    f.reqs.iter_mut().for_each(|r| r.asked = false);
}

pub fn clear() {
    let f = f();
    f.reqs.clear();
    f.waiting = false;
    f.error = None;
}

/// The run fails with `why` (the first failure wins).
pub fn fail(why: Vec<u8>) {
    let f = f();
    if f.error.is_none() {
        f.error = Some(why);
    }
}

/// The request answering `row` for this SERVICE, if it was answered or failed;
/// otherwise it is asked for (the run then waits) and None.
pub fn service(target: u32, text: &[u8], names: &[Vec<u8>], row: &[u32]) -> Option<usize> {
    let f = f();
    let key = |r: &Req| r.kind == SERVICE && r.target == target && r.text == text && r.same_domain(row);
    if let Some(i) = f.reqs.iter().position(|r| r.state != WAITING && key(r) && r.holds(row)) {
        return Some(i);
    }
    f.waiting = true;
    if let Some(r) = f.reqs.iter_mut().find(|r| r.state == WAITING && key(r) && r.holds(row)) {
        r.asked = true;
        return None;
    }
    if let Some(r) = f.reqs.iter_mut().find(|r| r.state == WAITING && key(r)) {
        r.rows.extend_from_slice(row);
        r.nrows += 1;
        r.asked = true;
        return None;
    }
    f.reqs.push(Req {
        state: WAITING,
        asked: true,
        kind: SERVICE,
        target,
        text: text.to_vec(),
        names: names.to_vec(),
        rows: row.to_vec(),
        nrows: 1,
        answer: Vec::new(),
        nanswer: 0,
        why: Vec::new(),
    });
    None
}

/// The request for this document, if answered or failed; otherwise it is asked for.
pub fn load(target: u32) -> Option<usize> {
    let f = f();
    if let Some(i) = f.reqs.iter().position(|r| r.kind == LOAD && r.target == target) {
        if f.reqs[i].state != WAITING {
            return Some(i);
        }
        f.waiting = true;
        f.reqs[i].asked = true;
        return None;
    }
    f.waiting = true;
    f.reqs.push(Req {
        state: WAITING,
        asked: true,
        kind: LOAD,
        target,
        text: Vec::new(),
        names: Vec::new(),
        rows: Vec::new(),
        nrows: 0,
        answer: Vec::new(),
        nanswer: 0,
        why: Vec::new(),
    });
    None
}

/// The width of an answer row: the variables, or 3 for a LOAD's triples.
pub fn answer_width(r: &Req) -> usize {
    if r.kind == LOAD { 3 } else { r.width() }
}
