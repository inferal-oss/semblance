//! A minimal WebAssembly binary writer: just what compiled queries need
//! (i32 locals, structured control, calls, loads and stores).

use alloc::vec::Vec;

pub fn uleb(out: &mut Vec<u8>, mut v: u32) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

pub fn sleb(out: &mut Vec<u8>, v: i32) {
    let mut v = v as i64;
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// One function body under construction: its parameter and i32 local counts.
pub struct Body {
    pub ty: u32,
    pub params: u32,
    pub locals: u32,
    pub code: Vec<u8>,
}

pub const BLOCK: u8 = 0x02;
pub const LOOP: u8 = 0x03;
pub const IF: u8 = 0x04;
pub const ELSE: u8 = 0x05;
pub const END: u8 = 0x0b;
pub const BR: u8 = 0x0c;
pub const BR_IF: u8 = 0x0d;
pub const CALL: u8 = 0x10;
pub const DROP: u8 = 0x1a;
pub const SELECT: u8 = 0x1b;
pub const EQZ: u8 = 0x45;
pub const EQ: u8 = 0x46;
pub const NE: u8 = 0x47;
pub const GE_U: u8 = 0x4f;
pub const ADD: u8 = 0x6a;
pub const MUL: u8 = 0x6c;
pub const AND: u8 = 0x71;
pub const OR: u8 = 0x72;

impl Body {
    pub fn new(ty: u32, params: u32) -> Body {
        Body { ty, params, locals: 0, code: Vec::new() }
    }
    pub fn local(&mut self) -> u32 {
        self.locals += 1;
        self.params + self.locals - 1
    }
    pub fn op(&mut self, b: u8) -> &mut Self {
        self.code.push(b);
        self
    }
    /// block / loop / if without a result.
    pub fn open(&mut self, b: u8) -> &mut Self {
        self.code.extend_from_slice(&[b, 0x40]);
        self
    }
    pub fn br(&mut self, b: u8, depth: u32) -> &mut Self {
        self.code.push(b);
        uleb(&mut self.code, depth);
        self
    }
    pub fn get(&mut self, l: u32) -> &mut Self {
        self.code.push(0x20);
        uleb(&mut self.code, l);
        self
    }
    pub fn set(&mut self, l: u32) -> &mut Self {
        self.code.push(0x21);
        uleb(&mut self.code, l);
        self
    }
    pub fn tee(&mut self, l: u32) -> &mut Self {
        self.code.push(0x22);
        uleb(&mut self.code, l);
        self
    }
    pub fn i32(&mut self, v: i32) -> &mut Self {
        self.code.push(0x41);
        sleb(&mut self.code, v);
        self
    }
    pub fn global_get(&mut self, g: u32) -> &mut Self {
        self.code.push(0x23);
        uleb(&mut self.code, g);
        self
    }
    pub fn global_set(&mut self, g: u32) -> &mut Self {
        self.code.push(0x24);
        uleb(&mut self.code, g);
        self
    }
    pub fn call(&mut self, f: u32) -> &mut Self {
        self.code.push(CALL);
        uleb(&mut self.code, f);
        self
    }
    pub fn load(&mut self, offset: u32) -> &mut Self {
        self.code.extend_from_slice(&[0x28, 2]);
        uleb(&mut self.code, offset);
        self
    }
    pub fn store(&mut self, offset: u32) -> &mut Self {
        self.code.extend_from_slice(&[0x36, 2]);
        uleb(&mut self.code, offset);
        self
    }
}

fn section(out: &mut Vec<u8>, id: u8, body: &[u8]) {
    out.push(id);
    uleb(out, body.len() as u32);
    out.extend_from_slice(body);
}

fn name(out: &mut Vec<u8>, s: &[u8]) {
    uleb(out, s.len() as u32);
    out.extend_from_slice(s);
}

/// A module: function types (i32 params, 0 or 1 i32 result), imported memory
/// and functions from `module`, the defined functions, `globals` mutable i32
/// globals (initially 0), and exported functions.
pub fn module(types: &[(u32, u32)], module_name: &[u8], imports: &[(&[u8], u32)], funcs: &[Body], globals: u32, exports: &[(&[u8], u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"\0asm\x01\0\0\0");
    let mut b = Vec::new();
    uleb(&mut b, types.len() as u32);
    for &(params, results) in types {
        b.push(0x60);
        uleb(&mut b, params);
        b.extend(core::iter::repeat_n(0x7f, params as usize));
        uleb(&mut b, results);
        b.extend(core::iter::repeat_n(0x7f, results as usize));
    }
    section(&mut out, 1, &b);
    b.clear();
    uleb(&mut b, imports.len() as u32 + 1);
    name(&mut b, module_name);
    name(&mut b, b"memory");
    b.extend_from_slice(&[0x02, 0x00, 0x00]);
    for &(n, ty) in imports {
        name(&mut b, module_name);
        name(&mut b, n);
        b.push(0x00);
        uleb(&mut b, ty);
    }
    section(&mut out, 2, &b);
    b.clear();
    uleb(&mut b, funcs.len() as u32);
    for f in funcs {
        uleb(&mut b, f.ty);
    }
    section(&mut out, 3, &b);
    if globals > 0 {
        b.clear();
        uleb(&mut b, globals);
        for _ in 0..globals {
            b.extend_from_slice(&[0x7f, 0x01, 0x41, 0x00, END]);
        }
        section(&mut out, 6, &b);
    }
    b.clear();
    uleb(&mut b, exports.len() as u32);
    for &(n, f) in exports {
        name(&mut b, n);
        b.push(0x00);
        uleb(&mut b, f);
    }
    section(&mut out, 7, &b);
    b.clear();
    uleb(&mut b, funcs.len() as u32);
    let mut body = Vec::new();
    for f in funcs {
        body.clear();
        if f.locals > 0 {
            body.push(1);
            uleb(&mut body, f.locals);
            body.push(0x7f);
        } else {
            body.push(0);
        }
        body.extend_from_slice(&f.code);
        body.push(END);
        uleb(&mut b, body.len() as u32);
        b.extend_from_slice(&body);
    }
    section(&mut out, 10, &b);
    out
}
