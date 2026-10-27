// The Rust twin of src/layout/check.ts: the same program over the same packed boxes.

const SAME_BLOCK_SIZE: i32 = 1;
const SAME_INLINE_SIZE: i32 = 2;
const SAME_TOP: i32 = 3;
const SAME_BOTTOM: i32 = 4;
const SAME_START: i32 = 5;
const FITS_WITHIN: i32 = 7;

#[inline]
fn top(b: &[f64], i: usize) -> f64 {
    b[i * 4 + 1]
}
#[inline]
fn bottom(b: &[f64], i: usize) -> f64 {
    b[i * 4 + 1] + b[i * 4 + 3]
}
#[inline]
fn start(b: &[f64], i: usize) -> f64 {
    b[i * 4]
}
#[inline]
fn end(b: &[f64], i: usize) -> f64 {
    b[i * 4] + b[i * 4 + 2]
}

/// Findings are appended as (invariant, member, by) triples.
pub fn check(boxes: &[f64], program: &[i32], out: &mut Vec<f64>) {
    let mut pc = 0;
    let mut inv = 0;
    while pc < program.len() {
        let rel = program[pc];
        let tolerance = program[pc + 1] as f64 / 100.0;
        let n = program[pc + 2] as usize;
        let members = &program[pc + 3..pc + 3 + n];
        pc += 3 + n;
        let measure: Option<fn(&[f64], usize) -> f64> = match rel {
            SAME_BLOCK_SIZE => Some(|b, i| b[i * 4 + 3]),
            SAME_INLINE_SIZE => Some(|b, i| b[i * 4 + 2]),
            SAME_TOP => Some(top),
            SAME_BOTTOM => Some(bottom),
            SAME_START => Some(start),
            _ => None,
        };
        if let Some(measure) = measure {
            let v0 = measure(boxes, members[0] as usize);
            let (mut lo, mut hi, mut worst, mut far) = (v0, v0, members[0], 0.0);
            for &m in &members[1..] {
                let v = measure(boxes, m as usize);
                lo = lo.min(v);
                hi = hi.max(v);
                if (v - v0).abs() > far {
                    far = (v - v0).abs();
                    worst = m;
                }
            }
            if hi - lo > tolerance {
                out.extend_from_slice(&[inv as f64, worst as f64, hi - lo]);
            }
        } else {
            let c = members[0] as usize;
            for &m in &members[1..] {
                let i = m as usize;
                let mut over = (start(boxes, c) - start(boxes, i)).max(end(boxes, i) - end(boxes, c));
                if rel == FITS_WITHIN {
                    over = over.max(top(boxes, c) - top(boxes, i)).max(bottom(boxes, i) - bottom(boxes, c));
                }
                if over > tolerance {
                    out.extend_from_slice(&[inv as f64, m as f64, over]);
                }
            }
        }
        inv += 1;
    }
}
