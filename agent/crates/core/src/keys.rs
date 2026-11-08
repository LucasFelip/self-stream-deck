//! Shortcut specs of `config.json` ("ctrl+shift+esc") as Windows virtual-key codes, and how they are shown ("Ctrl+Shift+Esc").
//! Parity with `legacy/server/src/keys.js`; the closed list of names is the whitelist of what a shortcut may press.

const MAX_KEYS: usize = 5;

fn named(name: &str) -> Option<u8> {
    Some(match name {
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" => 0x12,
        "win" => 0x5b,
        "esc" | "escape" => 0x1b,
        "tab" => 0x09,
        "enter" => 0x0d,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2e,
        "insert" => 0x2d,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "printscreen" | "prtsc" => 0x2c,
        "playpause" => 0xb3,
        "nexttrack" => 0xb0,
        "prevtrack" => 0xb1,
        "stop" => 0xb2,
        "volumeup" => 0xaf,
        "volumedown" => 0xae,
        "mute" => 0xad,
        _ => return None,
    })
}

/// The virtual-key code of one key name.
pub fn vk_of(name: &str) -> Result<u8, String> {
    if let Some(vk) = named(name) {
        return Ok(vk);
    }
    match name.as_bytes() {
        [letter @ b'a'..=b'z'] => return Ok(letter.to_ascii_uppercase()),
        [digit @ b'0'..=b'9'] => return Ok(*digit),
        [b'f', rest @ ..]
            if !rest.is_empty()
                && rest.len() <= 2
                && rest.iter().all(u8::is_ascii_digit)
                && rest[0] != b'0' =>
        {
            let number: u8 = std::str::from_utf8(rest)
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            if (1..=24).contains(&number) {
                return Ok(0x70 + number - 1);
            }
        }
        _ => {}
    }
    Err(format!("unknown key \"{name}\""))
}

fn tokens(spec: &str) -> Result<Vec<String>, String> {
    let parts: Vec<String> = spec
        .to_lowercase()
        .split('+')
        .map(|p| p.trim().to_owned())
        .collect();
    if parts.iter().any(String::is_empty) {
        return Err(format!("invalid shortcut \"{spec}\""));
    }
    if parts.len() > MAX_KEYS {
        return Err(format!("too many keys in \"{spec}\""));
    }
    Ok(parts)
}

/// "ctrl+shift+esc" gives `[0x11, 0x10, 0x1b]`.
pub fn parse(spec: &str) -> Result<Vec<u8>, String> {
    tokens(spec)?.iter().map(|name| vk_of(name)).collect()
}

/// "ctrl+shift+esc" gives "Ctrl+Shift+Esc".
pub fn display(spec: &str) -> Result<String, String> {
    let label = |name: &str| -> String {
        match name {
            "ctrl" | "control" => "Ctrl".into(),
            "win" => "Win".into(),
            "printscreen" | "prtsc" => "PrtSc".into(),
            "pageup" => "PgUp".into(),
            "pagedown" => "PgDn".into(),
            _ if name.chars().count() == 1
                || (name.starts_with('f')
                    && name.len() > 1
                    && name[1..].bytes().all(|b| b.is_ascii_digit())) =>
            {
                name.to_uppercase()
            }
            _ => {
                let mut chars = name.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            }
        }
    };
    Ok(tokens(spec)?
        .iter()
        .map(|name| label(name))
        .collect::<Vec<_>>()
        .join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_become_virtual_keys_in_order() {
        assert_eq!(parse("ctrl+shift+esc").unwrap(), vec![0x11, 0x10, 0x1b]);
        assert_eq!(parse("Win + D").unwrap(), vec![0x5b, b'D']);
        assert_eq!(parse("alt+f4").unwrap(), vec![0x12, 0x73]);
        assert_eq!(parse("f24").unwrap(), vec![0x87]);
        assert_eq!(parse("ctrl+5").unwrap(), vec![0x11, b'5']);
    }

    #[test]
    fn bad_specs_are_refused() {
        for bad in [
            "",
            "ctrl+",
            "+c",
            "ctrl+nope",
            "f0",
            "f25",
            "a+b+c+d+e+f",
            "ctrl++c",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn display_is_how_a_person_writes_it() {
        assert_eq!(display("ctrl+shift+esc").unwrap(), "Ctrl+Shift+Esc");
        assert_eq!(display("win+shift+s").unwrap(), "Win+Shift+S");
        assert_eq!(display("alt+f4").unwrap(), "Alt+F4");
        assert_eq!(display("ctrl+pagedown").unwrap(), "Ctrl+PgDn");
        assert_eq!(display("printscreen").unwrap(), "PrtSc");
        assert_eq!(display("win+tab").unwrap(), "Win+Tab");
    }
}
