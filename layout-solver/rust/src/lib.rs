// The layout solver and checker as a WebAssembly module: one solver per instance, exchanging
// numbers through two buffers in linear memory (layout-solver/host.ts is the JavaScript side).
//
// in:  f64 buffer (`buf`): terms as variable, coefficient pairs; suggestions as variable, value
//      pairs; boxes for the checker
// in:  i32 buffer (`prog`): the checker program
// out: f64 buffer (`out`): values, or findings as invariant, member, by triples

pub mod check;
pub mod solver;

use solver::Solver;

static mut SOLVER: Option<Solver> = None;
static mut BUF: Vec<f64> = Vec::new();
static mut PROG: Vec<i32> = Vec::new();
static mut OUT: Vec<f64> = Vec::new();

#[allow(static_mut_refs)]
fn solver() -> &'static mut Solver {
    unsafe { SOLVER.get_or_insert_with(Solver::new) }
}

/// Reserve the f64 input buffer for `n` numbers; returns its address.
#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn buf(n: u32) -> *mut f64 {
    unsafe {
        BUF.resize(n as usize, 0.0);
        BUF.as_mut_ptr()
    }
}

#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn prog(n: u32) -> *mut i32 {
    unsafe {
        PROG.resize(n as usize, 0);
        PROG.as_mut_ptr()
    }
}

#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn out() -> *const f64 {
    unsafe { OUT.as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    unsafe { SOLVER = Some(Solver::new()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn add_variable() -> u32 {
    solver().add_variable()
}

/// Add `Σ terms + constant OP 0`, its `n` terms in `buf`; the constraint's id, or -1.
#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn add_constraint(n: u32, constant: f64, op: u32, strength: f64) -> i32 {
    let terms: Vec<(u32, f64)> = unsafe { (0..n as usize).map(|i| (BUF[i * 2] as u32, BUF[i * 2 + 1])).collect() };
    match solver().add_constraint(&terms, constant, op, strength) {
        Ok(id) => id as i32,
        Err(_) => -1,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn remove_constraint(id: u32) -> i32 {
    if solver().remove_constraint(id).is_ok() { 0 } else { -1 }
}

#[unsafe(no_mangle)]
pub extern "C" fn add_edit_variable(variable: u32, strength: f64) -> i32 {
    if solver().add_edit_variable(variable, strength).is_ok() { 0 } else { -1 }
}

#[unsafe(no_mangle)]
pub extern "C" fn remove_edit_variable(variable: u32) -> i32 {
    if solver().remove_edit_variable(variable).is_ok() { 0 } else { -1 }
}

/// Suggest `n` values at once, as variable, value pairs in `buf`.
#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn suggest(n: u32) -> i32 {
    let s = solver();
    for i in 0..n as usize {
        let (v, x) = unsafe { (BUF[i * 2] as u32, BUF[i * 2 + 1]) };
        if s.suggest_value(v, x).is_err() {
            return -1;
        }
    }
    0
}

/// Every variable's value into `out`; returns the count.
#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn values() -> u32 {
    let s = solver();
    let n = s.variable_count();
    unsafe {
        OUT.clear();
        for i in 0..n {
            OUT.push(s.value(i as u32));
        }
    }
    n as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn pivots() -> f64 {
    solver().pivots as f64
}

/// Run the checker program in `prog` over the boxes in `buf`; findings into `out`, their count back.
#[allow(static_mut_refs)]
#[unsafe(no_mangle)]
pub extern "C" fn check() -> u32 {
    unsafe {
        OUT.clear();
        check::check(&BUF, &PROG, &mut OUT);
        (OUT.len() / 3) as u32
    }
}
