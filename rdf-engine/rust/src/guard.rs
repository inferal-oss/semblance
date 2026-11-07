//! Conservative absence proofs for compiled joins. No solutions or expressions
//! are evaluated here, and the shared compiled stack/frame are never changed.

use core::cell::UnsafeCell;
use crate::{budget, store::Store};

/// Graph visits and candidate comparisons share this per-call work allowance.
const WORK: u32 = 128;
struct Counters(UnsafeCell<[u32; 6]>);
// Single-threaded Wasm. The caller must not reenter this engine from a clock
// callback; this helper does not add host-side reentry protection.
unsafe impl Sync for Counters {}
static COUNTERS: Counters = Counters(UnsafeCell::new([0; 6]));

/// Last compiled run: calls, graph visits, candidates, absent, unknown, present.
pub fn count(index: u32) -> u32 {
    unsafe { (*COUNTERS.0.get()).get(index as usize).copied().unwrap_or(0) }
}
pub fn reset() { unsafe { *COUNTERS.0.get() = [0; 6]; } }
fn add(index: usize, n: u32) {
    let counters = unsafe { &mut *COUNTERS.0.get() };
    counters[index] = counters[index].saturating_add(n);
}
fn unknown() -> u32 { add(4, 1); 1 }

/// 0 only after every selected graph is proved absent. A match, work cap or
/// stopped/deadline query returns 1: normal execution/budget unwinding decides.
pub fn may_match(store: &Store, graphs: &[u32], s: u32, p: u32, o: u32) -> u32 {
    add(0, 1);
    if budget::poll_deadline() { return unknown(); }
    let mut left = WORK;
    let mut graph = 0;
    while graph < graphs.len() {
        if left == 0 { return unknown(); }
        left -= 1;
        add(1, 1);
        let (result, tested) = store.any_bounded([s, p, o, graphs[graph]], left);
        left -= tested;
        add(2, tested);
        match result {
            Some(true) => {
                if budget::poll_deadline() { return unknown(); }
                add(5, 1);
                return 1;
            }
            None => return unknown(),
            Some(false) => {}
        }
        graph += 1;
    }
    if budget::poll_deadline() { return unknown(); }
    add(3, 1);
    0
}
