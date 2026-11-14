//! Locks that survive a panic. A thread that panics while it holds a `Mutex` poisons it, and `lock().unwrap()` then panics in every thread
//! that comes after: one failed request would take the whole agent down with it. What these locks guard (the config, caches, counters) is
//! always left usable, so the next caller takes the lock as it is.
use std::sync::{Mutex, MutexGuard, PoisonError};

pub trait Locked<T> {
    /// The lock, whether or not a thread panicked while holding it.
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_panic_while_holding_the_lock_does_not_lock_everyone_else_out() {
        let shared = Arc::new(Mutex::new(1));
        let other = shared.clone();
        let _ = std::thread::spawn(move || {
            let _held = other.lock().unwrap();
            panic!("on purpose");
        })
        .join();
        assert!(shared.is_poisoned());
        *shared.locked() += 1;
        assert_eq!(*shared.locked(), 2);
    }
}
