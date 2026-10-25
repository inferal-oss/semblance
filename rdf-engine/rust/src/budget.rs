//! The query budget (ABI.md, "Query budget"): a deadline on `env.now` and a
//! number of evaluation steps. A step is one row from a scan, one node of a
//! path walk or one pair a join tries. Once either runs out, `stop()` holds,
//! the evaluator's loops return early, and `run` discards what they produced.

use core::cell::Cell;

struct Budget {
    deadline: Cell<f64>,
    fuel: Cell<u32>,
    left: Cell<u64>,
    ticks: Cell<u32>,
    stop: Cell<bool>,
    /// Between start() and finish(): only queries are budgeted, not updates.
    active: Cell<bool>,
}

// Wasm without threads: there is one caller at a time.
unsafe impl Sync for Budget {}

static B: Budget = Budget { deadline: Cell::new(0.0), fuel: Cell::new(0), left: Cell::new(u64::MAX), ticks: Cell::new(0), stop: Cell::new(false), active: Cell::new(false) };

/// How many steps go between two looks at the clock.
const CLOCK_EVERY: u32 = 4096;

pub fn set_deadline(at_ms: f64) {
    B.deadline.set(at_ms);
}

pub fn set_fuel(steps: u32) {
    B.fuel.set(steps);
}

/// At the start of a run: the whole budget again.
pub fn start() {
    let f = B.fuel.get();
    B.left.set(if f == 0 { u64::MAX } else { f as u64 });
    B.ticks.set(0);
    B.stop.set(false);
    B.active.set(true);
}

/// At the end of a run: whether it was stopped; later evaluation is not budgeted.
pub fn finish() -> bool {
    B.active.set(false);
    B.stop.get()
}

/// One step; true once the budget is spent.
#[inline]
pub fn step() -> bool {
    if !B.active.get() {
        return false;
    }
    if B.stop.get() {
        return true;
    }
    let left = B.left.get() - 1;
    B.left.set(left);
    let ticks = B.ticks.get().wrapping_add(1);
    B.ticks.set(ticks);
    if left == 0 || (ticks % CLOCK_EVERY == 0 && B.deadline.get() > 0.0 && crate::host::now() >= B.deadline.get()) {
        B.stop.set(true);
    }
    B.stop.get()
}

pub fn stopped() -> bool {
    B.stop.get()
}
