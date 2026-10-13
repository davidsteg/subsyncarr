//! CHANGELOG.md is compiled into the binary and parsed for the UI.

use serde::Serialize;

const RAW: &str = include_str!("../CHANGELOG.md");

#[derive(Serialize, Debug)]
pub struct Section {
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub version: String,
    pub date: String,
    pub sections: Vec<Section>,
}

fn strip_bold(s: &str) -> String {
    s.replace("**", "")
}

pub fn parse(raw: &str, limit: usize) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## [") {
            if out.len() == limit {
                break;
            }
            let Some((version, tail)) = rest.split_once(']') else {
                continue;
            };
            let date = tail.trim_start_matches(|c: char| !c.is_ascii_digit()).chars().take(10).collect();
            out.push(Entry { version: version.to_string(), date, sections: Vec::new() });
        } else if let Some(title) = line.strip_prefix("### ") {
            if let Some(e) = out.last_mut() {
                e.sections.push(Section { title: title.trim().to_string(), items: Vec::new() });
            }
        } else if let Some(item) = line.strip_prefix("- ") {
            if let Some(s) = out.last_mut().and_then(|e| e.sections.last_mut()) {
                s.items.push(strip_bold(item.trim()));
            }
        } else if line.starts_with("  ") && !line.trim().is_empty() {
            // Continuation / nested bullet: fold into the previous item.
            if let Some(last) = out.last_mut().and_then(|e| e.sections.last_mut()).and_then(|s| s.items.last_mut()) {
                last.push(' ');
                last.push_str(&strip_bold(line.trim().trim_start_matches("- ")));
            }
        }
    }
    out
}

pub fn entries() -> Vec<Entry> {
    parse(RAW, 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        let raw = "# Changelog\n\n## [2.0.0] — 2026-10-13\n\n### Changed\n\n- **Big** rewrite\n  - nested\n\n### Fixed\n\n- a `bug`\n\n## [1.0.0] — 2026-01-01\n\n### Added\n\n- x\n";
        let e = parse(raw, 10);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].version, "2.0.0");
        assert_eq!(e[0].date, "2026-10-13");
        assert_eq!(e[0].sections[0].items, vec!["Big rewrite nested"]);
        assert_eq!(e[0].sections[1].items, vec!["a `bug`"]);
        assert_eq!(parse(raw, 1).len(), 1);
        assert!(!entries().is_empty());
    }
}
