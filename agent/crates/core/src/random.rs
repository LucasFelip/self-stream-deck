//! Secrets (the pairing token, the password of a certificate file) come from the operating system's generator, never from a hasher or the clock.

/// `bytes` random bytes as lowercase hex (twice as many characters).
pub fn hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the operating system has a random generator");
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_is_hex_of_the_asked_size_and_never_the_same_twice() {
        let (a, b) = (hex(16), hex(16));
        assert_eq!(a.len(), 32);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_ne!(a, b);
    }
}
