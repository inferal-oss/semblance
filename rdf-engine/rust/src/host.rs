//! The host functions ABI.md allows: `env.now`, `env.random`, and for the
//! SPARQL extensions (EXTENSIONS.md) `env.math` and `env.intl`.

use alloc::vec::Vec;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    #[link_name = "now"]
    fn host_now() -> f64;
    #[link_name = "random"]
    fn host_random() -> f64;
    #[link_name = "math"]
    fn host_math(op: i32, x: f64, y: f64) -> f64;
    #[link_name = "intl"]
    fn host_intl(op: i32, input: *const u8, len: u32, out: *mut u8, cap: u32) -> i32;
}

/// Milliseconds since the Unix epoch.
pub fn now() -> f64 {
    unsafe { host_now() }
}

/// Uniform in [0, 1).
pub fn random() -> f64 {
    unsafe { host_random() }
}

/// The host's `Math` function `op` (EXTENSIONS.md, `sx:Math`).
pub fn math(op: i32, x: f64, y: f64) -> f64 {
    unsafe { host_math(op, x, y) }
}

/// The host's `Intl` operation `op` on NUL-separated arguments: the result
/// (ops 0, 1, 3), or the comparison as its length's sign (op 2); Err when `Intl` threw.
fn intl_call(op: i32, args: &[&[u8]], out: &mut Vec<u8>) -> Result<i32, ()> {
    let mut input = Vec::with_capacity(args.iter().map(|a| a.len() + 1).sum());
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            input.push(0);
        }
        input.extend_from_slice(a);
    }
    out.clear();
    out.reserve(64);
    loop {
        let n = unsafe { host_intl(op, input.as_ptr(), input.len() as u32, out.as_mut_ptr(), out.capacity() as u32) };
        if n == i32::MIN {
            return Err(());
        }
        if op == 2 {
            return Ok(n);
        }
        if n < 0 {
            out.reserve(n.unsigned_abs() as usize);
            continue;
        }
        // SAFETY: the host wrote n bytes, within the capacity it was given.
        unsafe { out.set_len(n as usize) };
        return Ok(n);
    }
}

/// `Intl` formatting: op 0 number, 1 date-time, 3 sort key.
pub fn intl(op: i32, args: &[&[u8]]) -> Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    intl_call(op, args, &mut out)?;
    Ok(out)
}

/// `Intl.Collator(lang).compare(a, b)`.
pub fn collate(lang: &[u8], a: &[u8], b: &[u8]) -> core::cmp::Ordering {
    let mut out = Vec::new();
    match intl_call(2, &[lang, a, b], &mut out) {
        Ok(n) => n.cmp(&0),
        Err(()) => a.cmp(b),
    }
}
