//! A power-of-two size-class allocator over linear memory: one free list per
//! class, a bump pointer for fresh blocks, `memory.grow` when it runs out.
//! Freed blocks are reused for the same class only; memory is never returned.

use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;
use core::cell::UnsafeCell;
use core::ptr::{copy_nonoverlapping, null_mut};

const PAGE: usize = 65536;

struct State {
    free: [usize; 32],
    next: usize,
    end: usize,
}

pub struct Heap(UnsafeCell<State>);

// Wasm without threads: there is one caller at a time.
unsafe impl Sync for Heap {}

unsafe extern "C" {
    static __heap_base: u8;
}

/// The class of a block: the smallest `c` with `1 << c >= size` (at least 8 bytes).
fn class(l: &Layout) -> usize {
    let size = l.size().max(l.align()).max(8);
    (usize::BITS - (size - 1).leading_zeros()) as usize
}

impl Heap {
    pub const fn new() -> Heap {
        Heap(UnsafeCell::new(State { free: [0; 32], next: 0, end: 0 }))
    }
}

unsafe impl GlobalAlloc for Heap {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let h = unsafe { &mut *self.0.get() };
        let c = class(&l);
        if c >= 32 {
            return null_mut();
        }
        let head = h.free[c];
        // Free blocks are only known to be 8-aligned.
        if head != 0 && l.align() <= 8 {
            h.free[c] = unsafe { *(head as *const usize) };
            return head as *mut u8;
        }
        if h.end == 0 {
            h.next = &raw const __heap_base as usize;
            h.end = wasm32::memory_size(0) * PAGE;
        }
        let align = l.align().max(8);
        let start = (h.next + align - 1) & !(align - 1);
        let stop = start + (1 << c);
        if stop > h.end {
            let pages = (stop - h.end).div_ceil(PAGE);
            if wasm32::memory_grow(0, pages) == usize::MAX {
                return null_mut();
            }
            h.end += pages * PAGE;
        }
        h.next = stop;
        start as *mut u8
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        let h = unsafe { &mut *self.0.get() };
        let c = class(&l);
        unsafe { *(p as *mut usize) = h.free[c] };
        h.free[c] = p as usize;
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let to = unsafe { Layout::from_size_align_unchecked(size, l.align()) };
        if class(&to) == class(&l) {
            return p;
        }
        let n = unsafe { self.alloc(to) };
        if !n.is_null() {
            unsafe {
                copy_nonoverlapping(p, n, l.size().min(size));
                self.dealloc(p, l);
            }
        }
        n
    }
}
