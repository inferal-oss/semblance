//! Validated numeric lexical input and one correctly rounded IEEE conversion.
//! The input is borrowed; eight fixed 256-limb buffers bound conversion storage.

use crate::budget;

const LIMBS: usize = 256;
const PREFIX: usize = 800;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    Integer, Decimal, Float, Double, Long, Int, Short, Byte,
    NonNegative, Positive, NonPositive, Negative,
    UnsignedLong, UnsignedInt, UnsignedShort, UnsignedByte,
}

impl Family {
    pub fn local(name: &[u8]) -> Option<Self> {
        Some(match name {
            b"integer" => Self::Integer, b"decimal" => Self::Decimal,
            b"float" => Self::Float, b"double" => Self::Double,
            b"long" => Self::Long, b"int" => Self::Int,
            b"short" => Self::Short, b"byte" => Self::Byte,
            b"nonNegativeInteger" => Self::NonNegative, b"positiveInteger" => Self::Positive,
            b"nonPositiveInteger" => Self::NonPositive, b"negativeInteger" => Self::Negative,
            b"unsignedLong" => Self::UnsignedLong, b"unsignedInt" => Self::UnsignedInt,
            b"unsignedShort" => Self::UnsignedShort, b"unsignedByte" => Self::UnsignedByte,
            _ => return None,
        })
    }

    pub fn floating(self) -> bool { matches!(self, Self::Float | Self::Double) }

    fn limit(self, negative: bool) -> Option<&'static [u8]> {
        use Family::*;
        Some(match (self, negative) {
            (Long, false) => b"9223372036854775807", (Long, true) => b"9223372036854775808",
            (Int, false) => b"2147483647", (Int, true) => b"2147483648",
            (Short, false) => b"32767", (Short, true) => b"32768",
            (Byte, false) => b"127", (Byte, true) => b"128",
            (UnsignedLong, _) => b"18446744073709551615",
            (UnsignedInt, _) => b"4294967295", (UnsignedShort, _) => b"65535",
            (UnsignedByte, _) => b"255", _ => return None,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Error { Invalid, Interrupted, InternalBound, UnsupportedNative }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Special { Finite, Infinity, Nan }

/// Complete lexical validation; unsupported exact arithmetic is not invalidity.
pub struct Lexical<'a> {
    source: &'a [u8],
    first: usize,
    mantissa_end: usize,
    pub negative: bool,
    pub zero: bool,
    significant: usize,
    fractional: usize,
    trailing_fraction_zeros: usize,
    exponent: i64,
    special: Special,
}

/// A deadline-only poll never consumes or resets evaluator row fuel/countdown.
pub struct Poll { work: u16 }
impl Poll {
    pub fn new() -> Result<Self, Error> {
        let mut p = Self { work: 0 };
        p.check()?;
        Ok(p)
    }
    pub fn check(&mut self) -> Result<(), Error> {
        if budget::poll_deadline() { Err(Error::Interrupted) } else { Ok(()) }
    }
    fn tick(&mut self) -> Result<(), Error> {
        self.work += 1;
        if self.work == 256 { self.work = 0; self.check()?; }
        Ok(())
    }
}

fn space(c: u8) -> bool { matches!(c, b' ' | b'\t' | b'\n' | b'\r') }

pub fn validate<'a>(source: &'a [u8], family: Family, poll: &mut Poll) -> Result<Lexical<'a>, Error> {
    // Every engine input span already uses the unchanged wasm32 ABI.
    if source.len() > u32::MAX as usize { return Err(Error::InternalBound); }
    let (mut begin, mut end) = (0, source.len());
    while begin < end && space(source[begin]) { begin += 1; poll.tick()?; }
    while end > begin && space(source[end - 1]) { end -= 1; poll.tick()?; }
    if begin == end { return Err(Error::Invalid); }
    let mut at = begin;
    let mut negative = false;
    if matches!(source[at], b'+' | b'-') { negative = source[at] == b'-'; at += 1; }
    if at == end { return Err(Error::Invalid); }
    let mut x = Lexical {
        source, first: end, mantissa_end: end, negative, zero: true,
        significant: 0, fractional: 0, trailing_fraction_zeros: 0,
        exponent: 0, special: Special::Finite,
    };
    if family.floating() && &source[at..end] == b"INF" {
        x.special = Special::Infinity; poll.check()?; return Ok(x);
    }
    if family.floating() && at == begin && &source[at..end] == b"NaN" {
        x.special = Special::Nan; poll.check()?; return Ok(x);
    }
    let (mut digits, mut dot) = (0usize, false);
    while at < end {
        let c = source[at];
        if c.is_ascii_digit() {
            digits += 1;
            if dot {
                x.fractional += 1;
                x.trailing_fraction_zeros = if c == b'0' { x.trailing_fraction_zeros + 1 } else { 0 };
            }
            if !x.zero || c != b'0' {
                if x.zero { x.first = at; x.zero = false; }
                x.significant += 1;
            }
            at += 1;
        } else if c == b'.' && !dot && (family == Family::Decimal || family.floating()) {
            dot = true; at += 1;
        } else { break; }
        poll.tick()?;
    }
    if digits == 0 { return Err(Error::Invalid); }
    x.mantissa_end = at;
    if at < end {
        if !family.floating() || !matches!(source[at], b'e' | b'E') { return Err(Error::Invalid); }
        at += 1;
        let mut eneg = false;
        if at < end && matches!(source[at], b'+' | b'-') { eneg = source[at] == b'-'; at += 1; }
        if at == end { return Err(Error::Invalid); }
        let cap = source.len() as i64 + 2048;
        while at < end {
            let c = source[at];
            if !c.is_ascii_digit() { return Err(Error::Invalid); }
            if x.exponent < cap { x.exponent = (x.exponent * 10 + (c - b'0') as i64).min(cap); }
            at += 1; poll.tick()?;
        }
        if eneg { x.exponent = -x.exponent; }
    }
    if !family.floating() && family != Family::Decimal {
        use Family::*;
        if match family {
            Positive => negative || x.zero, Negative => !negative || x.zero,
            NonNegative | UnsignedLong | UnsignedInt | UnsignedShort | UnsignedByte => negative && !x.zero,
            NonPositive => !negative && !x.zero, _ => false,
        } { return Err(Error::Invalid); }
        if !x.zero {
            if let Some(limit) = family.limit(negative) {
                if x.significant > limit.len() { return Err(Error::Invalid); }
                if x.significant == limit.len() && &source[x.first..x.mantissa_end] > limit { return Err(Error::Invalid); }
            }
        }
    }
    if x.zero && !family.floating() { x.negative = false; }
    poll.check()?;
    Ok(x)
}

impl Lexical<'_> {
    fn magnitude(&self, limit: u128, strip_fraction_zeros: bool, poll: &mut Poll) -> Result<(u128, usize), Error> {
        if self.special != Special::Finite { return Err(Error::UnsupportedNative); }
        if self.zero { return Ok((0, 0)); }
        let trim = if strip_fraction_zeros { self.trailing_fraction_zeros } else { 0 };
        let end = self.mantissa_end - trim;
        let mut m = 0u128;
        for &c in &self.source[self.first..end] {
            if c != b'.' {
                m = m.checked_mul(10).and_then(|v| v.checked_add((c - b'0') as u128)).ok_or(Error::UnsupportedNative)?;
                if m > limit { return Err(Error::UnsupportedNative); }
            }
            poll.tick()?;
        }
        Ok((m, self.fractional - trim))
    }

    pub fn integer(&self, poll: &mut Poll) -> Result<i128, Error> {
        let limit = (i128::MAX as u128) + self.negative as u128;
        let (m, scale) = self.magnitude(limit, false, poll)?;
        if scale != 0 { return Err(Error::UnsupportedNative); }
        poll.check()?;
        Ok(if self.negative { (m as i128).wrapping_neg() } else { m as i128 })
    }

    pub fn decimal(&self, poll: &mut Poll) -> Result<i128, Error> {
        let limit = (i128::MAX as u128) + self.negative as u128;
        let (mut m, scale) = self.magnitude(limit, true, poll)?;
        if scale > 18 { return Err(Error::UnsupportedNative); }
        for _ in scale..18 {
            m = m.checked_mul(10).filter(|&v| v <= limit).ok_or(Error::UnsupportedNative)?;
            poll.tick()?;
        }
        poll.check()?;
        Ok(if self.negative { (m as i128).wrapping_neg() } else { m as i128 })
    }
}

struct Big { words: [u32; LIMBS], len: usize }
impl Big {
    const fn zero() -> Self { Self { words: [0; LIMBS], len: 0 } }
    fn word(&self, at: usize) -> u32 { if at < self.len { self.words[at] } else { 0 } }
    fn trim(&mut self, poll: &mut Poll) -> Result<(), Error> {
        while self.len > 0 && self.words[self.len - 1] == 0 { self.len -= 1; poll.tick()?; }
        Ok(())
    }
    fn bits(&self) -> i32 { if self.len == 0 { 0 } else { (self.len as i32 - 1) * 32 + (32 - self.words[self.len - 1].leading_zeros()) as i32 } }
    fn small(&mut self, n: u32) { self.len = (n != 0) as usize; if n != 0 { self.words[0] = n; } }
    fn assign(&mut self, src: &Self, poll: &mut Poll) -> Result<(), Error> {
        for at in 0..src.len { self.words[at] = src.words[at]; poll.tick()?; }
        self.len = src.len; Ok(())
    }
    fn mul_add(&mut self, m: u32, a: u32, poll: &mut Poll) -> Result<(), Error> {
        let mut carry = a as u64;
        for at in 0..self.len {
            let n = self.words[at] as u64 * m as u64 + carry;
            self.words[at] = n as u32; carry = n >> 32; poll.tick()?;
        }
        if carry != 0 {
            if self.len == LIMBS { return Err(Error::InternalBound); }
            self.words[self.len] = carry as u32; self.len += 1;
        }
        Ok(())
    }
    fn shifted(&mut self, src: &Self, bits: usize, poll: &mut Poll) -> Result<(), Error> {
        if src.len == 0 { self.len = 0; return Ok(()); }
        let whole = bits / 32;
        let part = bits % 32;
        let size = src.len.checked_add(whole).and_then(|v| v.checked_add((part != 0) as usize)).ok_or(Error::InternalBound)?;
        if size > LIMBS { return Err(Error::InternalBound); }
        for at in 0..whole { self.words[at] = 0; poll.tick()?; }
        let mut carry = 0u64;
        for at in 0..src.len {
            let n = ((src.words[at] as u64) << part) | carry;
            self.words[whole + at] = n as u32; carry = n >> 32; poll.tick()?;
        }
        if part != 0 { self.words[whole + src.len] = carry as u32; }
        self.len = size; self.trim(poll)
    }
    fn cmp(&self, other: &Self, poll: &mut Poll) -> Result<core::cmp::Ordering, Error> {
        if self.len != other.len { return Ok(self.len.cmp(&other.len)); }
        for at in (0..self.len).rev() {
            poll.tick()?;
            if self.words[at] != other.words[at] { return Ok(self.words[at].cmp(&other.words[at])); }
        }
        Ok(core::cmp::Ordering::Equal)
    }
    fn sub(&mut self, other: &Self, poll: &mut Poll) -> Result<(), Error> {
        let mut borrow = 0u64;
        for at in 0..self.len {
            let lhs = self.words[at] as u64;
            let rhs = other.word(at) as u64 + borrow;
            self.words[at] = lhs.wrapping_sub(rhs) as u32;
            borrow = (lhs < rhs) as u64; poll.tick()?;
        }
        if borrow != 0 { return Err(Error::InternalBound); }
        self.trim(poll)
    }
}

struct Workspace { buffers: [Big; 8] }
impl Workspace {
    fn new() -> Self { Self { buffers: [const { Big::zero() }; 8] } }
    fn pair(&mut self, dst: usize, src: usize) -> (&mut Big, &Big) {
        assert!(dst != src);
        if dst < src { let (a, b) = self.buffers.split_at_mut(src); (&mut a[dst], &b[0]) }
        else { let (a, b) = self.buffers.split_at_mut(dst); (&mut b[0], &a[src]) }
    }
    fn assign(&mut self, dst: usize, src: usize, p: &mut Poll) -> Result<(), Error> { let (a, b) = self.pair(dst, src); a.assign(b, p) }
    fn shift(&mut self, dst: usize, src: usize, bits: usize, p: &mut Poll) -> Result<(), Error> { let (a, b) = self.pair(dst, src); a.shifted(b, bits, p) }
    fn cmp(&self, a: usize, b: usize, p: &mut Poll) -> Result<core::cmp::Ordering, Error> { self.buffers[a].cmp(&self.buffers[b], p) }
    fn sub(&mut self, dst: usize, src: usize, p: &mut Poll) -> Result<(), Error> { let (a, b) = self.pair(dst, src); a.sub(b, p) }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Precision { Single, Double }
impl Precision {
    fn p(self) -> i32 { if self == Self::Single { 24 } else { 53 } }
    fn bias(self) -> i32 { if self == Self::Single { 127 } else { 1023 } }
    fn sign(self, negative: bool) -> u64 { if negative { 1 << if self == Self::Single { 31 } else { 63 } } else { 0 } }
    fn infinity(self) -> u64 { if self == Self::Single { 0x7f80_0000 } else { 0x7ff0_0000_0000_0000 } }
    fn nan(self) -> u64 { if self == Self::Single { 0x7fc0_0000 } else { 0x7ff8_0000_0000_0000 } }
    pub fn value(self, bits: u64) -> f64 { if self == Self::Single { f32::from_bits(bits as u32) as f64 } else { f64::from_bits(bits) } }
}

fn round(work: &mut Workspace, exponent: i32, sticky: bool, negative: bool, precision: Precision, poll: &mut Poll) -> Result<u64, Error> {
    use core::cmp::Ordering::*;
    if !(-1123..=308).contains(&exponent) { return Err(Error::InternalBound); }
    let sign = precision.sign(negative);
    if work.buffers[0].len == 0 { return Ok(sign); }
    // Slots: 0=A, 1=N, 2=D, 3=scaled N, 4=scaled D, 5=temporary,
    // 6=remainder, 7=shifted divisor. No recursive conversion or heap storage.
    work.assign(1, 0, poll)?;
    work.buffers[2].small(1);
    let power_slot = if exponent >= 0 { 1 } else { 2 };
    for _ in 0..exponent.unsigned_abs() { work.buffers[power_slot].mul_add(5, 0, poll)?; }
    let mut e = work.buffers[1].bits() - work.buffers[2].bits();
    let below = if e >= 0 { work.shift(5, 2, e as usize, poll)?; work.cmp(1, 5, poll)? == Less }
        else { work.shift(5, 1, (-e) as usize, poll)?; work.cmp(5, 2, poll)? == Less };
    if below { e -= 1; }
    e += exponent;
    if e > precision.bias() { return Ok(sign | precision.infinity()); }
    let fraction = precision.p() - 1;
    let mut h = (e - fraction).max(1 - precision.bias() - fraction);
    let shift = exponent - h;
    work.shift(3, 1, shift.max(0) as usize, poll)?;
    work.shift(4, 2, (-shift).max(0) as usize, poll)?;
    work.assign(6, 3, poll)?;
    let difference = work.buffers[6].bits() - work.buffers[4].bits();
    if difference > precision.p() { return Err(Error::InternalBound); }
    let mut q = 0u64;
    for bit in (0..=difference.max(-1)).rev() {
        work.shift(7, 4, bit as usize, poll)?;
        if work.cmp(6, 7, poll)? != Less { work.sub(6, 7, poll)?; q |= 1u64 << bit; }
    }
    work.shift(5, 6, 1, poll)?;
    let halfway = work.cmp(5, 4, poll)?;
    if halfway == Greater || (halfway == Equal && (sticky || q & 1 != 0)) { q += 1; }
    if q == 0 { return Ok(sign); }
    let hidden = 1u64 << fraction;
    if q >= hidden << 1 { q >>= 1; h += 1; }
    if q < hidden { return Ok(sign | q); }
    let normal = h + fraction;
    if normal > precision.bias() { return Ok(sign | precision.infinity()); }
    if q >= hidden << 1 || normal < 1 - precision.bias() { return Err(Error::InternalBound); }
    Ok(sign | (((normal + precision.bias()) as u64) << fraction) | (q - hidden))
}

/// Convert a fully validated source directly to the selected precision.
pub fn bits(x: &Lexical<'_>, precision: Precision, poll: &mut Poll) -> Result<u64, Error> {
    let sign = precision.sign(x.negative);
    if x.special == Special::Infinity { poll.check()?; return Ok(sign | precision.infinity()); }
    if x.special == Special::Nan { poll.check()?; return Ok(precision.nan()); }
    if x.zero { poll.check()?; return Ok(sign); }
    let kept = x.significant.min(PREFIX);
    let exponent = x.exponent - x.fractional as i64 + (x.significant - kept) as i64;
    let order = kept as i64 - 1 + exponent;
    if order >= if precision == Precision::Double { 309 } else { 39 } { poll.check()?; return Ok(sign | precision.infinity()); }
    if order < if precision == Precision::Double { -324 } else { -46 } { poll.check()?; return Ok(sign); }
    let mut work = Workspace::new();
    let (mut count, mut sticky) = (0usize, false);
    for &c in &x.source[x.first..x.mantissa_end] {
        if c != b'.' {
            if count < PREFIX { work.buffers[0].mul_add(10, (c - b'0') as u32, poll)?; }
            else if c != b'0' { sticky = true; }
            count += 1;
        }
        poll.tick()?;
    }
    let result = round(&mut work, i32::try_from(exponent).map_err(|_| Error::InternalBound)?, sticky, x.negative, precision, poll)?;
    poll.check()?;
    Ok(result)
}

pub fn parse(source: &[u8], family: Family, precision: Precision) -> Result<f64, Error> {
    let mut poll = Poll::new()?;
    let x = validate(source, family, &mut poll)?;
    let result = precision.value(bits(&x, precision, &mut poll)?);
    poll.check()?;
    Ok(result)
}

/// A computed exact integer or scaled decimal does not round through f64 on
/// its way to f32. The native magnitude has at most four input limbs.
pub fn native(mantissa: i128, scale: u32, precision: Precision) -> Result<f64, Error> {
    if scale > 18 { return Err(Error::InternalBound); }
    let mut poll = Poll::new()?;
    let mut work = Workspace::new();
    let mut magnitude = mantissa.unsigned_abs();
    while magnitude != 0 {
        let at = work.buffers[0].len;
        work.buffers[0].words[at] = magnitude as u32;
        work.buffers[0].len += 1;
        magnitude >>= 32;
    }
    let result = round(&mut work, -(scale as i32), false, mantissa < 0, precision, &mut poll)?;
    poll.check()?;
    Ok(precision.value(result))
}
