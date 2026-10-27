// The Rust twin of src/layout/solver.ts: Cassowary in kiwi's shape, step for step. Rows and cells
// iterate in insertion order, as a JavaScript Map does, so both twins pivot identically.

pub const REQUIRED: f64 = 1_001_001_000.0;
const EPS: f64 = 1.0e-8;
const INVALID: u32 = u32::MAX;

#[inline]
fn near_zero(n: f64) -> bool {
    n.abs() < EPS
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Kind {
    External,
    Slack,
    Error,
    Dummy,
}

pub const LE: u32 = 0;
pub const GE: u32 = 1;
pub const EQ: u32 = 2;

/// `constant + Σ cells`; cells in insertion order (removal keeps the order of the rest).
#[derive(Clone, Default)]
struct Row {
    constant: f64,
    cells: Vec<(u32, f64)>,
}

impl Row {
    fn new(constant: f64) -> Self {
        Row { constant, cells: Vec::new() }
    }
    #[inline]
    fn find(&self, sym: u32) -> Option<usize> {
        self.cells.iter().position(|&(s, _)| s == sym)
    }
    #[inline]
    fn coefficient_for(&self, sym: u32) -> f64 {
        self.find(sym).map_or(0.0, |i| self.cells[i].1)
    }
    fn add(&mut self, v: f64) -> f64 {
        self.constant += v;
        self.constant
    }
    fn insert(&mut self, sym: u32, coefficient: f64) {
        match self.find(sym) {
            Some(i) => {
                let v = self.cells[i].1 + coefficient;
                if near_zero(v) {
                    self.cells.remove(i);
                } else {
                    self.cells[i].1 = v;
                }
            }
            None => {
                if !near_zero(coefficient) {
                    self.cells.push((sym, coefficient));
                }
            }
        }
    }
    fn insert_row(&mut self, other: &Row, coefficient: f64) {
        self.constant += other.constant * coefficient;
        for &(s, c) in &other.cells {
            self.insert(s, c * coefficient);
        }
    }
    fn remove(&mut self, sym: u32) {
        if let Some(i) = self.find(sym) {
            self.cells.remove(i);
        }
    }
    fn reverse_sign(&mut self) {
        self.constant = -self.constant;
        for c in &mut self.cells {
            c.1 = -c.1;
        }
    }
    fn solve_for(&mut self, sym: u32) {
        let i = self.find(sym).unwrap();
        let coefficient = -1.0 / self.cells[i].1;
        self.cells.remove(i);
        self.constant *= coefficient;
        for c in &mut self.cells {
            c.1 *= coefficient;
        }
    }
    fn solve_for_pair(&mut self, lhs: u32, rhs: u32) {
        self.insert(lhs, -1.0);
        self.solve_for(rhs);
    }
    fn substitute(&mut self, sym: u32, row: &Row) {
        if let Some(i) = self.find(sym) {
            let c = self.cells[i].1;
            self.cells.remove(i);
            self.insert_row(row, c);
        }
    }
}

/// Rows keyed by their basic symbol, iterated in insertion order: an append-only list with
/// tombstones and a symbol → slot index, compacted when half of it is dead.
#[derive(Default)]
struct Rows {
    list: Vec<(u32, Option<Row>)>,
    slot: Vec<u32>,
    live: usize,
}

impl Rows {
    fn get(&self, sym: u32) -> Option<&Row> {
        let i = *self.slot.get(sym as usize)?;
        if i == INVALID { None } else { self.list[i as usize].1.as_ref() }
    }
    fn get_mut(&mut self, sym: u32) -> Option<&mut Row> {
        let i = *self.slot.get(sym as usize)?;
        if i == INVALID { None } else { self.list[i as usize].1.as_mut() }
    }
    fn take(&mut self, sym: u32) -> Option<Row> {
        let i = *self.slot.get(sym as usize)?;
        if i == INVALID {
            return None;
        }
        self.slot[sym as usize] = INVALID;
        self.live -= 1;
        self.list[i as usize].1.take()
    }
    fn set(&mut self, sym: u32, row: Row) {
        if self.slot.len() <= sym as usize {
            self.slot.resize(sym as usize + 1, INVALID);
        }
        debug_assert!(self.slot[sym as usize] == INVALID);
        if self.list.len() > 64 && self.live * 2 < self.list.len() {
            self.compact();
        }
        self.slot[sym as usize] = self.list.len() as u32;
        self.list.push((sym, Some(row)));
        self.live += 1;
    }
    fn compact(&mut self) {
        self.list.retain(|(_, r)| r.is_some());
        for (i, (s, _)) in self.list.iter().enumerate() {
            self.slot[*s as usize] = i as u32;
        }
    }
}

#[derive(Clone, Copy)]
struct Tag {
    marker: u32,
    other: u32,
}

struct Constraint {
    tag: Tag,
    strength: f64,
}

struct Edit {
    tag: Tag,
    constraint: u32,
    constant: f64,
}

#[derive(Debug)]
pub enum SolverError {
    Unsatisfiable,
    Unknown,
    Internal,
}

#[derive(Default)]
pub struct Solver {
    kinds: Vec<Kind>,
    var_symbols: Vec<u32>,
    rows: Rows,
    constraints: Vec<Option<Constraint>>,
    /// variable → edit
    edits: Vec<Option<Edit>>,
    infeasible: Vec<u32>,
    objective: Row,
    pub pivots: u64,
}

impl Solver {
    pub fn new() -> Self {
        Self::default()
    }

    fn symbol(&mut self, kind: Kind) -> u32 {
        self.kinds.push(kind);
        (self.kinds.len() - 1) as u32
    }

    pub fn add_variable(&mut self) -> u32 {
        let s = self.symbol(Kind::External);
        self.var_symbols.push(s);
        (self.var_symbols.len() - 1) as u32
    }

    pub fn add_constraint(&mut self, terms: &[(u32, f64)], constant: f64, op: u32, strength: f64) -> Result<u32, SolverError> {
        let strength = strength.clamp(0.0, REQUIRED);
        let mut tag = Tag { marker: INVALID, other: INVALID };
        let mut row = self.create_row(terms, constant, op, strength, &mut tag);
        let mut subject = self.choose_subject(&row, tag);
        if subject == INVALID && self.all_dummies(&row) {
            if !near_zero(row.constant) {
                return Err(SolverError::Unsatisfiable);
            }
            subject = tag.marker;
        }
        if subject == INVALID {
            if !self.add_with_artificial_variable(row)? {
                return Err(SolverError::Unsatisfiable);
            }
        } else {
            row.solve_for(subject);
            self.substitute(subject, &row);
            self.rows.set(subject, row);
        }
        let id = self.constraints.len() as u32;
        self.constraints.push(Some(Constraint { tag, strength }));
        let mut objective = core::mem::take(&mut self.objective);
        let r = self.optimize(&mut objective);
        self.objective = objective;
        r?;
        Ok(id)
    }

    pub fn remove_constraint(&mut self, id: u32) -> Result<(), SolverError> {
        let c = self.constraints.get_mut(id as usize).and_then(|c| c.take()).ok_or(SolverError::Unknown)?;
        let Constraint { tag, strength } = c;
        if self.kinds[tag.marker as usize] == Kind::Error {
            self.remove_marker_effects(tag.marker, strength);
        }
        if tag.other != INVALID && self.kinds[tag.other as usize] == Kind::Error {
            self.remove_marker_effects(tag.other, strength);
        }
        if self.rows.take(tag.marker).is_none() {
            let leaving = self.marker_leaving_row(tag.marker);
            if leaving == INVALID {
                return Err(SolverError::Internal);
            }
            let mut row = self.rows.take(leaving).unwrap();
            row.solve_for_pair(leaving, tag.marker);
            // the marker leaves the system with its row (as in kiwi)
            self.substitute(tag.marker, &row);
        }
        let mut objective = core::mem::take(&mut self.objective);
        let r = self.optimize(&mut objective);
        self.objective = objective;
        r
    }

    pub fn add_edit_variable(&mut self, variable: u32, strength: f64) -> Result<(), SolverError> {
        if self.edits.get(variable as usize).is_some_and(|e| e.is_some()) {
            return Err(SolverError::Unknown);
        }
        let strength = strength.clamp(0.0, REQUIRED);
        if strength == REQUIRED {
            return Err(SolverError::Unknown);
        }
        let constraint = self.add_constraint(&[(variable, 1.0)], 0.0, EQ, strength)?;
        let tag = self.constraints[constraint as usize].as_ref().unwrap().tag;
        if self.edits.len() <= variable as usize {
            self.edits.resize_with(variable as usize + 1, || None);
        }
        self.edits[variable as usize] = Some(Edit { tag, constraint, constant: 0.0 });
        Ok(())
    }

    pub fn remove_edit_variable(&mut self, variable: u32) -> Result<(), SolverError> {
        let e = self.edits.get_mut(variable as usize).and_then(|e| e.take()).ok_or(SolverError::Unknown)?;
        self.remove_constraint(e.constraint)
    }

    pub fn suggest_value(&mut self, variable: u32, value: f64) -> Result<(), SolverError> {
        let info = self.edits.get_mut(variable as usize).and_then(|e| e.as_mut()).ok_or(SolverError::Unknown)?;
        let delta = value - info.constant;
        info.constant = value;
        let Tag { marker, other } = info.tag;
        if let Some(row) = self.rows.get_mut(marker) {
            if row.add(-delta) < 0.0 {
                self.infeasible.push(marker);
            }
        } else if let Some(row) = self.rows.get_mut(other) {
            if row.add(delta) < 0.0 {
                self.infeasible.push(other);
            }
        } else {
            for (s, row) in self.rows.list.iter_mut() {
                let Some(row) = row.as_mut() else { continue };
                let c = row.coefficient_for(marker);
                if c != 0.0 && row.add(delta * c) < 0.0 && self.kinds[*s as usize] != Kind::External {
                    self.infeasible.push(*s);
                }
            }
        }
        self.dual_optimize()
    }

    pub fn value(&self, variable: u32) -> f64 {
        self.rows.get(self.var_symbols[variable as usize]).map_or(0.0, |r| r.constant)
    }

    pub fn variable_count(&self) -> usize {
        self.var_symbols.len()
    }

    fn create_row(&mut self, terms: &[(u32, f64)], constant: f64, op: u32, strength: f64, tag: &mut Tag) -> Row {
        let mut row = Row::new(constant);
        for &(variable, coefficient) in terms {
            if near_zero(coefficient) {
                continue;
            }
            let sym = self.var_symbols[variable as usize];
            match self.rows.get(sym) {
                Some(r) => row.insert_row(r, coefficient),
                None => row.insert(sym, coefficient),
            }
        }
        if op == LE || op == GE {
            let coeff = if op == LE { 1.0 } else { -1.0 };
            let slack = self.symbol(Kind::Slack);
            tag.marker = slack;
            row.insert(slack, coeff);
            if strength < REQUIRED {
                let error = self.symbol(Kind::Error);
                tag.other = error;
                row.insert(error, -coeff);
                self.objective.insert(error, strength);
            }
        } else if strength < REQUIRED {
            let plus = self.symbol(Kind::Error);
            let minus = self.symbol(Kind::Error);
            tag.marker = plus;
            tag.other = minus;
            row.insert(plus, -1.0);
            row.insert(minus, 1.0);
            self.objective.insert(plus, strength);
            self.objective.insert(minus, strength);
        } else {
            let dummy = self.symbol(Kind::Dummy);
            tag.marker = dummy;
            row.insert(dummy, 1.0);
        }
        if row.constant < 0.0 {
            row.reverse_sign();
        }
        row
    }

    fn pivotable(&self, s: u32) -> bool {
        s != INVALID && matches!(self.kinds[s as usize], Kind::Slack | Kind::Error)
    }

    fn choose_subject(&self, row: &Row, tag: Tag) -> u32 {
        for &(s, _) in &row.cells {
            if self.kinds[s as usize] == Kind::External {
                return s;
            }
        }
        if self.pivotable(tag.marker) && row.coefficient_for(tag.marker) < 0.0 {
            return tag.marker;
        }
        if self.pivotable(tag.other) && row.coefficient_for(tag.other) < 0.0 {
            return tag.other;
        }
        INVALID
    }

    fn all_dummies(&self, row: &Row) -> bool {
        row.cells.iter().all(|&(s, _)| self.kinds[s as usize] == Kind::Dummy)
    }

    fn add_with_artificial_variable(&mut self, row: Row) -> Result<bool, SolverError> {
        let art = self.symbol(Kind::Slack);
        self.rows.set(art, row.clone());
        // optimize the artificial objective; optimize keeps it substituted as rows pivot
        let mut artificial = row;
        self.optimize(&mut artificial)?;
        let success = near_zero(artificial.constant);
        if let Some(mut r) = self.rows.take(art) {
            if r.cells.is_empty() {
                return Ok(success);
            }
            let entering = self.any_pivotable_symbol(&r);
            if entering == INVALID {
                return Ok(false);
            }
            r.solve_for_pair(art, entering);
            self.substitute(entering, &r);
            self.rows.set(entering, r);
        }
        for (_, row) in self.rows.list.iter_mut() {
            if let Some(row) = row.as_mut() {
                row.remove(art);
            }
        }
        self.objective.remove(art);
        Ok(success)
    }

    fn substitute(&mut self, sym: u32, row: &Row) {
        for (s, r) in self.rows.list.iter_mut() {
            let Some(r) = r.as_mut() else { continue };
            r.substitute(sym, row);
            if self.kinds[*s as usize] != Kind::External && r.constant < 0.0 {
                self.infeasible.push(*s);
            }
        }
        self.objective.substitute(sym, row);
    }

    /// Optimize `objective`, held outside self: the artificial objective (self.substitute keeps the
    /// real one current too) or the real one taken out of self.objective for the duration.
    fn optimize(&mut self, objective: &mut Row) -> Result<(), SolverError> {
        loop {
            let entering = self.entering_symbol(objective);
            if entering == INVALID {
                return Ok(());
            }
            let leaving = self.leaving_row(entering);
            if leaving == INVALID {
                return Err(SolverError::Internal);
            }
            let mut row = self.rows.take(leaving).unwrap();
            row.solve_for_pair(leaving, entering);
            self.substitute(entering, &row);
            objective.substitute(entering, &row);
            self.rows.set(entering, row);
            self.pivots += 1;
        }
    }

    fn dual_optimize(&mut self) -> Result<(), SolverError> {
        while let Some(leaving) = self.infeasible.pop() {
            let Some(row) = self.rows.get(leaving) else { continue };
            if row.constant >= 0.0 {
                continue;
            }
            let entering = self.dual_entering_symbol(row);
            if entering == INVALID {
                return Err(SolverError::Internal);
            }
            let mut row = self.rows.take(leaving).unwrap();
            row.solve_for_pair(leaving, entering);
            self.substitute(entering, &row);
            self.rows.set(entering, row);
            self.pivots += 1;
        }
        Ok(())
    }

    fn entering_symbol(&self, objective: &Row) -> u32 {
        for &(s, c) in &objective.cells {
            if self.kinds[s as usize] != Kind::Dummy && c < 0.0 {
                return s;
            }
        }
        INVALID
    }

    fn dual_entering_symbol(&self, row: &Row) -> u32 {
        let mut entering = INVALID;
        let mut ratio = f64::MAX;
        for &(s, c) in &row.cells {
            if c > 0.0 && self.kinds[s as usize] != Kind::Dummy {
                let r = self.objective.coefficient_for(s) / c;
                if r < ratio {
                    ratio = r;
                    entering = s;
                }
            }
        }
        entering
    }

    fn any_pivotable_symbol(&self, row: &Row) -> u32 {
        for &(s, _) in &row.cells {
            if matches!(self.kinds[s as usize], Kind::Slack | Kind::Error) {
                return s;
            }
        }
        INVALID
    }

    fn leaving_row(&self, entering: u32) -> u32 {
        let mut ratio = f64::MAX;
        let mut found = INVALID;
        for (s, row) in &self.rows.list {
            let Some(row) = row else { continue };
            if self.kinds[*s as usize] == Kind::External {
                continue;
            }
            let c = row.coefficient_for(entering);
            if c < 0.0 {
                let r = -row.constant / c;
                if r < ratio {
                    ratio = r;
                    found = *s;
                }
            }
        }
        found
    }

    fn marker_leaving_row(&self, marker: u32) -> u32 {
        let (mut r1, mut r2) = (f64::MAX, f64::MAX);
        let (mut first, mut second, mut third) = (INVALID, INVALID, INVALID);
        for (s, row) in &self.rows.list {
            let Some(row) = row else { continue };
            let c = row.coefficient_for(marker);
            if c == 0.0 {
                continue;
            }
            if self.kinds[*s as usize] == Kind::External {
                third = *s;
            } else if c < 0.0 {
                let r = -row.constant / c;
                if r < r1 {
                    r1 = r;
                    first = *s;
                }
            } else {
                let r = row.constant / c;
                if r < r2 {
                    r2 = r;
                    second = *s;
                }
            }
        }
        if first != INVALID {
            first
        } else if second != INVALID {
            second
        } else {
            third
        }
    }

    fn remove_marker_effects(&mut self, marker: u32, strength: f64) {
        if let Some(row) = self.rows.get(marker) {
            let row = row.clone();
            self.objective.insert_row(&row, -strength);
        } else {
            self.objective.insert(marker, -strength);
        }
    }
}
