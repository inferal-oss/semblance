//! Quads in four sorted indexes, so that every pattern with a bound subject,
//! predicate, object or graph is a prefix range: SPOG, POSG, OSPG, GSPO.

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

pub type Quad = [u32; 4];

#[derive(Default)]
pub struct Store {
    spog: BTreeSet<Quad>,
    posg: BTreeSet<Quad>,
    ospg: BTreeSet<Quad>,
    gspo: BTreeSet<Quad>,
}

#[derive(Clone, Copy)]
enum Order {
    Spog,
    Posg,
    Ospg,
    Gspo,
}

impl Order {
    fn key(self, [s, p, o, g]: Quad) -> Quad {
        match self {
            Order::Spog => [s, p, o, g],
            Order::Posg => [p, o, s, g],
            Order::Ospg => [o, s, p, g],
            Order::Gspo => [g, s, p, o],
        }
    }
    fn quad(self, k: Quad) -> Quad {
        match self {
            Order::Spog => k,
            Order::Posg => [k[2], k[0], k[1], k[3]],
            Order::Ospg => [k[1], k[2], k[0], k[3]],
            Order::Gspo => [k[1], k[2], k[3], k[0]],
        }
    }
}

impl Store {
    pub fn add(&mut self, q: Quad) -> bool {
        if !self.spog.insert(q) {
            return false;
        }
        self.posg.insert(Order::Posg.key(q));
        self.ospg.insert(Order::Ospg.key(q));
        self.gspo.insert(Order::Gspo.key(q));
        true
    }

    pub fn remove(&mut self, q: Quad) -> bool {
        if !self.spog.remove(&q) {
            return false;
        }
        self.posg.remove(&Order::Posg.key(q));
        self.ospg.remove(&Order::Ospg.key(q));
        self.gspo.remove(&Order::Gspo.key(q));
        true
    }

    pub fn has(&self, q: Quad) -> bool {
        self.spog.contains(&q)
    }

    pub fn len(&self) -> usize {
        self.spog.len()
    }

    /// Every graph that holds a quad.
    pub fn graphs(&self) -> Vec<u32> {
        let mut out = Vec::new();
        let mut from = 0u32;
        while let Some(k) = self.gspo.range([from, 0, 0, 0]..).next() {
            out.push(k[0]);
            if k[0] == u32::MAX {
                break;
            }
            from = k[0] + 1;
        }
        out
    }

    /// Append every quad matching the pattern (0 = any) to `out`, 4 ids each.
    pub fn scan(&self, pat: Quad, out: &mut Vec<u32>) {
        let [s, p, o, g] = pat;
        let (order, bound) = match (s != 0, p != 0, o != 0) {
            (true, true, true) => (Order::Spog, 3),
            (true, true, false) => (Order::Spog, 2),
            (true, false, true) => (Order::Ospg, 2),
            (true, false, false) => (Order::Spog, 1),
            (false, true, true) => (Order::Posg, 2),
            (false, true, false) => (Order::Posg, 1),
            (false, false, true) => (Order::Ospg, 1),
            (false, false, false) if g != 0 => (Order::Gspo, 1),
            (false, false, false) => (Order::Spog, 0),
        };
        let index = match order {
            Order::Spog => &self.spog,
            Order::Posg => &self.posg,
            Order::Ospg => &self.ospg,
            Order::Gspo => &self.gspo,
        };
        let key = order.key(pat);
        let (mut lo, mut hi) = (key, key);
        for i in bound..4 {
            lo[i] = 0;
            hi[i] = u32::MAX;
        }
        for &k in index.range(lo..=hi) {
            let q = order.quad(k);
            if pat.iter().zip(q).all(|(&x, y)| x == 0 || x == y) {
                out.extend_from_slice(&q);
            }
        }
    }
}
