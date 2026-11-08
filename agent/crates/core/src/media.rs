//! The parts of "now playing" that need no Windows: the readable name of a player, the image type, the art cache and the art key.
//! Parity with `legacy/server/src/media.js`.
use std::collections::{HashMap, VecDeque};

const KNOWN: [(&str, &str); 8] = [
    ("spotify", "Spotify"),
    ("brave", "Brave"),
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("vlc", "VLC"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
];

/// "Spotify.exe" is "Spotify", "brave" is "Brave", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" is "ZuneMusic".
pub fn app_name(id: &str) -> String {
    let before_bang = id.split('!').next().unwrap_or(id);
    let without_exe = match before_bang.len().checked_sub(4) {
        Some(cut)
            if before_bang.is_char_boundary(cut)
                && before_bang[cut..].eq_ignore_ascii_case(".exe") =>
        {
            &before_bang[..cut]
        }
        _ => before_bang,
    };
    let base = without_exe
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(without_exe);
    let key: String = base
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase())
        .collect();
    if let Some((_, name)) = KNOWN.iter().find(|(known, _)| key.contains(known)) {
        return (*name).to_owned();
    }
    let readable = base
        .split('_')
        .next()
        .unwrap_or(base)
        .rsplit('.')
        .next()
        .unwrap_or(base);
    let mut chars = readable.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Windows often leaves the content type empty, so the file signature decides.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() > 8 && bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.len() > 3 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.len() > 3 && &bytes[..3] == b"GIF" {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// A short key that changes with the track (12 hex characters; the phone puts it in the art URL and caches the image under it).
pub fn art_key(id: &str, title: &str, artist: &str, album: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a
    for byte in [id, title, artist, album].join("|").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:012x}", hash & 0xffff_ffff_ffff)
}

pub fn is_art_key(key: &str) -> bool {
    key.len() == 12
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Cover art is fetched once per track and kept in memory; at most 40 images, the oldest goes first.
#[derive(Default)]
pub struct ArtCache {
    order: VecDeque<String>,
    entries: HashMap<String, Option<(String, Vec<u8>)>>,
}

const ART_LIMIT: usize = 40;

impl ArtCache {
    pub fn get(&self, key: &str) -> Option<&Option<(String, Vec<u8>)>> {
        self.entries.get(key)
    }

    pub fn remember(&mut self, key: &str, value: Option<(String, Vec<u8>)>) {
        if self.entries.len() >= ART_LIMIT && !self.entries.contains_key(key) {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        if self.entries.insert(key.to_owned(), value).is_none() {
            self.order.push_back(key.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_get_a_readable_name() {
        for (id, name) in [
            ("Spotify.exe", "Spotify"),
            ("brave", "Brave"),
            ("Brave.QUMMLHSRIJLZGRKURWAPPZUJI4", "Brave"),
            (
                "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic",
                "ZuneMusic",
            ),
            ("C:\\Program Files\\VideoLAN\\vlc.exe", "VLC"),
            ("MSEdge", "Edge"),
            ("someplayer", "Someplayer"),
        ] {
            assert_eq!(app_name(id), name, "{id}");
        }
    }

    #[test]
    fn the_image_type_comes_from_the_signature() {
        assert_eq!(
            sniff_mime(&[0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]),
            "image/png"
        );
        assert_eq!(sniff_mime(&[0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
        assert_eq!(sniff_mime(b"RIFF....WEBPVP8 "), "image/webp");
        assert_eq!(sniff_mime(b"GIF89a"), "image/gif");
        assert_eq!(sniff_mime(b"?"), "image/jpeg");
    }

    #[test]
    fn the_art_key_is_12_hex_and_changes_with_the_track() {
        let a = art_key("s1", "Faixa", "Banda", "Disco");
        assert!(is_art_key(&a));
        assert_ne!(a, art_key("s1", "Outra", "Banda", "Disco"));
        assert_eq!(a, art_key("s1", "Faixa", "Banda", "Disco"));
        assert!(!is_art_key("0123456789AB") && !is_art_key("0123456789a"));
    }

    #[test]
    fn the_cache_keeps_the_newest_forty() {
        let mut cache = ArtCache::default();
        for n in 0..45 {
            cache.remember(&format!("k{n}"), Some(("image/png".into(), vec![n as u8])));
        }
        assert!(cache.get("k0").is_none() && cache.get("k4").is_none());
        assert!(cache.get("k5").is_some() && cache.get("k44").is_some());
        cache.remember("none", None);
        assert_eq!(
            cache.get("none"),
            Some(&None),
            "a track without art is remembered too"
        );
    }
}
