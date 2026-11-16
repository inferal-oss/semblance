//! Relative IRI resolution (RFC 3986, section 5.2), and what an IRI may be.

use alloc::vec::Vec;

struct Parts<'a> {
    scheme: Option<&'a [u8]>,
    authority: Option<&'a [u8]>,
    path: &'a [u8],
    query: Option<&'a [u8]>,
    fragment: Option<&'a [u8]>,
}

fn split(s: &[u8]) -> Parts<'_> {
    let end = |s: &[u8], stops: &[u8]| s.iter().position(|c| stops.contains(c)).unwrap_or(s.len());
    let mut rest = s;
    let mut scheme = None;
    let i = end(rest, b":/?#");
    if i < rest.len() && rest[i] == b':' && i > 0 && rest[0].is_ascii_alphabetic() {
        scheme = Some(&rest[..i]);
        rest = &rest[i + 1..];
    }
    let mut authority = None;
    if rest.starts_with(b"//") {
        let i = 2 + end(&rest[2..], b"/?#");
        authority = Some(&rest[2..i]);
        rest = &rest[i..];
    }
    let i = end(rest, b"?#");
    let path = &rest[..i];
    rest = &rest[i..];
    let mut query = None;
    if rest.first() == Some(&b'?') {
        let i = end(rest, b"#");
        query = Some(&rest[1..i]);
        rest = &rest[i..];
    }
    let fragment = if rest.is_empty() { None } else { Some(&rest[1..]) };
    Parts { scheme, authority, path, query, fragment }
}

fn remove_dot_segments(path: &[u8], out: &mut Vec<u8>) {
    let start = out.len();
    let mut input = path;
    // A buffer for the one rewrite that is not a suffix of the input ("/." -> "/").
    let slash: &[u8] = b"/";
    while !input.is_empty() {
        if input.starts_with(b"../") {
            input = &input[3..];
        } else if input.starts_with(b"./") {
            input = &input[2..];
        } else if input.starts_with(b"/./") {
            input = &input[2..];
        } else if input == b"/." {
            input = slash;
        } else if input.starts_with(b"/../") || input == b"/.." {
            input = if input.len() == 3 { slash } else { &input[3..] };
            let last = out[start..].iter().rposition(|&c| c == b'/').map_or(start, |i| start + i);
            out.truncate(last);
        } else if input == b"." || input == b".." {
            input = b"";
        } else {
            let first = if input[0] == b'/' { 1 } else { 0 };
            let n = input[first..].iter().position(|&c| c == b'/').map_or(input.len(), |i| first + i);
            out.extend_from_slice(&input[..n]);
            input = &input[n..];
        }
    }
}

/// Resolve `r` against `base` into `out`. With an empty base, `r` is kept as is.
pub fn resolve(base: &[u8], r: &[u8], out: &mut Vec<u8>) {
    out.clear();
    if base.is_empty() {
        out.extend_from_slice(r);
        return;
    }
    let r = split(r);
    let b = split(base);
    let (scheme, authority, query);
    if let Some(s) = r.scheme {
        scheme = Some(s);
        authority = r.authority;
        query = r.query;
    } else {
        scheme = b.scheme;
        if r.authority.is_some() {
            authority = r.authority;
            query = r.query;
        } else {
            authority = b.authority;
            query = if r.path.is_empty() { r.query.or(b.query) } else { r.query };
        }
    }
    if let Some(s) = scheme {
        out.extend_from_slice(s);
        out.push(b':');
    }
    if let Some(a) = authority {
        out.extend_from_slice(b"//");
        out.extend_from_slice(a);
    }
    if r.scheme.is_some() || r.authority.is_some() || r.path.first() == Some(&b'/') {
        remove_dot_segments(r.path, out);
    } else if r.path.is_empty() {
        out.extend_from_slice(b.path);
    } else {
        // Merge: the base path up to its last '/', then the reference's path.
        let mut merged = Vec::new();
        if b.authority.is_some() && b.path.is_empty() {
            merged.push(b'/');
        } else if let Some(i) = b.path.iter().rposition(|&c| c == b'/') {
            merged.extend_from_slice(&b.path[..=i]);
        }
        merged.extend_from_slice(r.path);
        remove_dot_segments(&merged, out);
    }
    if let Some(q) = query {
        out.push(b'?');
        out.extend_from_slice(q);
    }
    if let Some(f) = r.fragment {
        out.push(b'#');
        out.extend_from_slice(f);
    }
}

/// The bytes IRIREF excludes: controls, space, `<>"{}|^`\`.
pub fn bad_char(c: u8) -> bool {
    c <= 0x20 || b"<>\"{}|^`\\".contains(&c)
}

/// The bytes [`valid`] looks at beyond the excluded ones: `# % / : ? [ ]`.
pub fn special(c: u8) -> bool {
    b"#%/:?[]".contains(&c)
}

/// Whether `s`, an IRI reference as written (escapes decoded, not resolved),
/// is one the engine accepts: no byte IRIREF excludes, and the cheap parts of
/// RFC 3987 the IRIREF grammar leaves out: '%' starts two hex digits; a
/// reference without a scheme has no ':' in its first segment; one '#' at
/// most; an authority is [userinfo '@'] host [':' digits] where the host may
/// be an IP literal in '[' ']', and brackets appear nowhere else. The store
/// API, the Turtle family, SPARQL and `IRI()` all hold IRIs to this, so the
/// store never holds an IRI that query text cannot write (#311).
pub fn valid(s: &[u8]) -> bool {
    if s.iter().any(|&c| bad_char(c)) {
        return false;
    }
    let e = s.len();
    let scheme = scheme_len(s);
    let mut seg = scheme == 0; // in the first segment of a scheme-less reference
    let auth = if scheme > 0 { scheme + 1 } else { 0 };
    let mut auth_end = auth;
    if s[auth..].starts_with(b"//") {
        seg = false;
        let mut i = auth + 2;
        let mut h = i;
        let (mut lit, mut close, mut colon) = (false, None, None);
        while i < e && !b"/?#".contains(&s[i]) {
            match s[i] {
                b'@' => {
                    // that was userinfo: the host starts after it
                    if lit || close.is_some() {
                        return false;
                    }
                    h = i + 1;
                    colon = None;
                }
                b'[' => {
                    if i != h {
                        return false;
                    }
                    lit = true;
                }
                b']' => {
                    if !lit {
                        return false;
                    }
                    lit = false;
                    close = Some(i + 1);
                }
                b':' if !lit && colon.is_none() => colon = Some(i),
                _ => {}
            }
            i += 1;
        }
        auth_end = i;
        if lit {
            return false;
        }
        // after an IP literal comes the end of the authority or the port
        if close.is_some_and(|c| c != auth_end && Some(c) != colon) {
            return false;
        }
        if colon.is_some_and(|c| !s[c + 1..auth_end].iter().all(u8::is_ascii_digit)) {
            return false;
        }
    }
    let mut frag = false;
    for (i, &c) in s.iter().enumerate().skip(auth) {
        if !special(c) {
            continue;
        }
        match c {
            b'%' => {
                if i + 2 >= e || !s[i + 1].is_ascii_hexdigit() || !s[i + 2].is_ascii_hexdigit() {
                    return false;
                }
            }
            b'#' => {
                if frag {
                    return false;
                }
                frag = true;
            }
            b':' if seg => return false,
            b'[' | b']' if i >= auth_end => return false,
            _ => {}
        }
        seg = seg && !b"/?#".contains(&c);
    }
    true
}

/// The length of the scheme of `s` (ALPHA *(ALPHA / DIGIT / "+" / "-" / ".")
/// then ':'), or 0.
fn scheme_len(s: &[u8]) -> usize {
    match s.first() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return 0,
    }
    for (i, &c) in s.iter().enumerate().skip(1) {
        match c {
            b':' => return i,
            c if c.is_ascii_alphanumeric() || b"+-.".contains(&c) => {}
            _ => return 0,
        }
    }
    0
}
