//! Text KeyValues (VDF / ACF) parser.
//!
//! Owns the `Vdf` tree. A broken file becomes an empty tree so the UI stays up.
//! Does not read the disk and does not know about Steam paths.

/// Valve KeyValues (VDF) node: a scalar or a list of key/value children.
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// Case-insensitive child lookup.
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(entries) => entries
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }

    /// Scalar value, if this node is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    /// Children of an object node.
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(entries) => entries,
            Vdf::Str(_) => &[],
        }
    }
}

pub(super) struct VdfParser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

/// Steam's own files nest seven levels deep (`localconfig.vdf` on this machine);
/// the parser recurses, so a limit far above that keeps a pathological file from
/// overflowing the stack — a hard crash, not a caught error.
const MAX_DEPTH: usize = 256;

impl<'a> VdfParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
            depth: 0,
        }
    }

    fn skip_ws(&mut self) {
        loop {
            match self.bytes.get(self.pos) {
                Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') => self.pos += 1,
                // Valve's format allows `//` to the end of the line, and people
                // paste commented examples into libraryfolders.vdf. Only ever
                // seen at a token position: a `//` inside a quoted string is
                // read by `string`, which does not come through here.
                Some(b'/') if self.bytes.get(self.pos + 1) == Some(&b'/') => {
                    while let Some(&b) = self.bytes.get(self.pos) {
                        if b == b'\n' {
                            break;
                        }
                        self.pos += 1;
                    }
                }
                _ => break,
            }
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    /// Reads a quoted string (backslash escapes are unwrapped).
    fn string(&mut self) -> Option<String> {
        if self.peek()? != b'"' {
            return None;
        }
        self.pos += 1;
        let mut out: Vec<u8> = Vec::new();
        while let Some(&b) = self.bytes.get(self.pos) {
            self.pos += 1;
            match b {
                b'"' => return Some(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => {
                    if let Some(&esc) = self.bytes.get(self.pos) {
                        self.pos += 1;
                        out.push(esc);
                    }
                }
                _ => out.push(b),
            }
        }
        None
    }

    /// Reads one token: a quoted string (escapes unwrapped) or a bareword.
    ///
    /// Valve's own writer quotes every token, but hand-edited files and some
    /// third-party tools leave numbers and paths unquoted. Stopping at the next
    /// whitespace or brace keeps the rest of the file readable instead of
    /// abandoning it on the first bareword.
    fn token(&mut self) -> Option<String> {
        match self.peek()? {
            b'"' => self.string(),
            b'}' | b'{' => None,
            _ => {
                let start = self.pos;
                while let Some(&b) = self.bytes.get(self.pos) {
                    if b.is_ascii_whitespace() || b == b'{' || b == b'}' {
                        break;
                    }
                    self.pos += 1;
                }
                (self.pos > start)
                    .then(|| String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned())
            }
        }
    }

    fn object(&mut self) -> Vec<(String, Vdf)> {
        let mut entries = Vec::new();
        loop {
            match self.peek() {
                None => break,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => {}
            }
            let key = if self.depth == 0 {
                // A real document's root key is quoted. Requiring that here keeps
                // arbitrary prose from turning into a tree of fake entries.
                let Some(key) = self.string() else { break };
                key
            } else {
                let Some(key) = self.token() else { break };
                key
            };
            match self.peek() {
                Some(b'{') => {
                    self.pos += 1;
                    if self.depth >= MAX_DEPTH {
                        // Deeper than anything Steam writes: stop here instead of
                        // recursing. The tree read so far is still usable.
                        break;
                    }
                    self.depth += 1;
                    let child = self.object();
                    self.depth -= 1;
                    entries.push((key, Vdf::Obj(child)));
                }
                Some(b'}') | None => break,
                _ => {
                    let Some(value) = self.token() else { break };
                    entries.push((key, Vdf::Str(value)));
                }
            }
        }
        entries
    }
}

/// Parses a KeyValues document (VDF/ACF). Unknown shapes yield an empty tree
/// instead of an error: a broken file must never take the UI down.
pub fn parse_vdf(text: &str) -> Vdf {
    // A UTF-8 BOM is common in files saved by Windows editors; without this
    // the first token would look like a bareword key with no value.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut parser = VdfParser::new(text);
    let root = parser.object();
    Vdf::Obj(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARY_FOLDERS: &str = r#"
    "libraryfolders"
    {
    	"0"
    	{
    		"path"		"C:\\Program Files (x86)\\Steam"
    		"label"		""
    		"apps"
    		{
    			"228980"		"123456789"
    		}
    	}
    	"1"
    	{
    		"path"		"D:\\SteamLibrary"
    		"label"		"Games"
    	}
    }
    "#;

    #[test]
    fn vdf_parser_reads_nested_objects() {
        let root = parse_vdf(LIBRARY_FOLDERS);
        let folders = root.get("libraryfolders").expect("libraryfolders node");
        assert_eq!(folders.entries().len(), 2);
        assert_eq!(
            folders
                .get("0")
                .and_then(|f| f.get("path"))
                .and_then(Vdf::as_str),
            Some(r"C:\Program Files (x86)\Steam")
        );
        assert_eq!(
            folders
                .get("1")
                .and_then(|f| f.get("label"))
                .and_then(Vdf::as_str),
            Some("Games")
        );
    }

    /// People edit this file by hand, and Valve's own examples carry `//`
    /// comments. A comment must not stop the parse where it stands: everything
    /// after it would disappear from the library.
    #[test]
    fn comments_do_not_end_the_document() {
        let text = r#"
        "libraryfolders"
        {
            // the first disk
            "0"
            {
                "path"		"C:\\Games"   // main library
            }
            "1"
            {
                "path"		"D:\\SteamLibrary"
            }
        }
        "#;
        let root = parse_vdf(text);
        let folders = root.get("libraryfolders").expect("libraryfolders node");
        assert_eq!(folders.entries().len(), 2, "both folders survive the comment");
        assert_eq!(
            folders
                .get("0")
                .and_then(|f| f.get("path"))
                .and_then(Vdf::as_str),
            Some(r"C:\Games")
        );
    }

    /// A `//` inside a quoted value is part of the value: paths and labels carry
    /// it, and cutting them there would corrupt them.
    #[test]
    fn a_double_slash_inside_a_value_stays() {
        let root = parse_vdf("\"a\"\n{\n\"path\"\t\t\"http://example.com/x\"\n}\n");
        assert_eq!(
            root.get("a").and_then(|n| n.get("path")).and_then(Vdf::as_str),
            Some("http://example.com/x")
        );
    }

    /// Files edited by hand or by a third-party tool can carry unquoted keys and
    /// values. One bareword used to stop the parse and hide every later game.
    #[test]
    fn unquoted_tokens_do_not_end_the_document() {
        let text = r#"
        "AppState"
        {
            appid 440
            name TeamFortress2
            "installed" 1
        }
        "#;
        let root = parse_vdf(text);
        let state = root.get("AppState").expect("object parsed");
        assert_eq!(state.get("appid").and_then(Vdf::as_str), Some("440"));
        assert_eq!(
            state.get("name").and_then(Vdf::as_str),
            Some("TeamFortress2")
        );
        assert_eq!(state.get("installed").and_then(Vdf::as_str), Some("1"));
    }

    /// Windows editors often write a UTF-8 BOM. It is not a key or a value.
    #[test]
    fn a_utf8_bom_is_ignored() {
        let root = parse_vdf(
            "\u{feff}\"libraryfolders\"\n{\n\"0\"\n{\n\"path\"\t\t\"C:\\\\Games\"\n}\n}\n",
        );
        assert_eq!(
            root.get("libraryfolders")
                .and_then(|node| node.get("0"))
                .and_then(|node| node.get("path"))
                .and_then(Vdf::as_str),
            Some(r"C:\Games")
        );
    }

    /// Broken input yields an empty tree instead of a panic or a hang.
    #[test]
    fn broken_documents_do_not_panic() {
        for text in [
            "",
            "{",
            "}",
            "\"unterminated",
            "\"key\" {",
            "\"key\" \"value\" }",
            "no quotes at all",
            "\"a\" \"\\",
        ] {
            let root = parse_vdf(text);
            // Whatever comes back, it must be a tree the callers can walk.
            let _ = root.get("a");
            let _ = root.entries();
        }
    }

    /// Escapes are unwrapped the way Valve writes them: `\"` is a quote inside a
    /// value, `\\` a backslash.
    #[test]
    fn escapes_are_unwrapped() {
        let root = parse_vdf("\"k\"\t\t\"a\\\"b\\\\c\"\n");
        assert_eq!(
            root.get("k").and_then(Vdf::as_str),
            Some("a\"b\\c"),
            "quote and backslash both come through"
        );
    }

    /// The parser recurses, so a file with hundreds of thousands of open braces
    /// must stop rather than overflow the stack — that would take the whole app
    /// down, not just the parse.
    #[test]
    fn a_pathologically_deep_document_stops_instead_of_crashing() {
        let mut text = String::with_capacity(4 * 1024 * 1024);
        for i in 0..200_000 {
            text.push_str("\"k");
            text.push_str(&i.to_string());
            text.push_str("\"\n{\n");
        }
        let root = parse_vdf(&text);
        // Reaching this line is the point: no crash. The tree that came back is
        // still walkable, it just stops at the limit.
        assert!(root.entries().len() >= 1, "a usable tree, not a crash");
    }
}
