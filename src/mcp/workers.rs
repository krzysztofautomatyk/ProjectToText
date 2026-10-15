//! Runs MCP tool calls on worker threads with a time limit and a cap on running workers.
//!
//! The MCP server calls [`tool_workers`] for each `tools/call`. The pool owns the slot count,
//! so timed-out workers that keep running still count against the cap.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

/// Maximum tool workers that may run at once, including timed-out workers that are still running.
/// Normal calls use one slot at a time, so the cap only binds after several calls have timed out.
const MAX_TOOL_WORKERS: usize = 4;

/// Runs tool calls on worker threads with a time limit. Each running worker holds one slot until its
/// work ends, so timed-out workers count against the cap. Without the cap, an untrusted client could
/// make timed-out workers pile up without limit.
///
/// A worker cannot be stopped safely, so a timed-out call keeps running in the background. The client
/// gets the timeout error at once, and a later call that needs the shared workspace index waits for
/// that worker to finish.
pub(super) struct ToolWorkers {
    in_flight: Arc<AtomicUsize>,
    limit: usize,
}

/// Holds one worker slot. Dropping it frees the slot, including when a worker unwinds.
struct WorkerSlot(Arc<AtomicUsize>);

impl Drop for WorkerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ToolWorkers {
    fn new(limit: usize) -> Self {
        Self {
            in_flight: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }

    fn try_acquire(&self) -> Option<WorkerSlot> {
        let mut in_flight = self.in_flight.load(Ordering::SeqCst);
        loop {
            if in_flight >= self.limit {
                return None;
            }
            match self.in_flight.compare_exchange_weak(
                in_flight,
                in_flight + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(WorkerSlot(Arc::clone(&self.in_flight))),
                Err(current) => in_flight = current,
            }
        }
    }

    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Runs `work` on a worker and returns its result, or an error once `time_limit` has elapsed.
    /// Refuses without starting a worker when all slots are taken.
    pub(super) fn run<F>(&self, time_limit: std::time::Duration, work: F) -> Result<String, String>
    where
        F: FnOnce() -> Result<String, String> + Send + 'static,
    {
        let Some(slot) = self.try_acquire() else {
            return Err(format!(
                "{} tool calls are still running after earlier timeouts; retry once they finish",
                self.limit
            ));
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new().spawn(move || {
            let result = work();
            // Free the slot before reporting, so a client that sends its next call on receiving this
            // result is never refused by a slot that is already done.
            drop(slot);
            // The receiver is gone after a timeout; the discarded result is intentional.
            let _ = sender.send(result);
        });
        if let Err(error) = spawned {
            return Err(format!("could not start tool worker: {error}"));
        }
        match receiver.recv_timeout(time_limit) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "tool call exceeded the {:.0}s time limit; it was not cancelled and may still finish in the background",
                time_limit.as_secs_f64()
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("tool worker stopped before returning a result".to_string())
            }
        }
    }
}

pub(super) fn tool_workers() -> &'static ToolWorkers {
    static WORKERS: OnceLock<ToolWorkers> = OnceLock::new();
    WORKERS.get_or_init(|| ToolWorkers::new(MAX_TOOL_WORKERS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn tool_work_that_exceeds_the_time_limit_returns_an_error_without_waiting() {
        let workers = ToolWorkers::new(MAX_TOOL_WORKERS);
        let started = std::time::Instant::now();
        let slow = workers.run(std::time::Duration::from_millis(50), || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            Ok("late".to_string())
        });
        let err = slow.unwrap_err();
        assert!(err.contains("time limit"), "{err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the caller waited for the slow work"
        );
        let fast = workers.run(std::time::Duration::from_secs(5), || {
            Ok("on time".to_string())
        });
        assert_eq!(fast.unwrap(), "on time");
        let failed = workers.run(std::time::Duration::from_secs(5), || {
            Err("tool failed".to_string())
        });
        assert_eq!(failed.unwrap_err(), "tool failed");
    }

    /// Work that stays busy until `release` is set. It counts each worker that actually starts.
    fn gated_work(
        release: &Arc<AtomicBool>,
        started: &Arc<AtomicUsize>,
    ) -> impl FnOnce() -> Result<String, String> + Send + 'static {
        let (release, started) = (Arc::clone(release), Arc::clone(started));
        move || {
            started.fetch_add(1, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !release.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Ok("released".to_string())
        }
    }

    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !condition() {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        true
    }

    #[test]
    fn timed_out_tool_workers_are_capped_and_free_their_slots_when_they_finish() {
        let workers = ToolWorkers::new(2);
        let release = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicUsize::new(0));

        // Ten calls against a cap of two. The gate stays closed, so the first two time out and the
        // rest must be refused without starting a worker.
        let (mut timed_out, mut refused) = (0usize, 0usize);
        for _ in 0..10 {
            match workers.run(
                std::time::Duration::from_millis(50),
                gated_work(&release, &started),
            ) {
                Err(e) if e.contains("time limit") => timed_out += 1,
                Err(e) if e.contains("still running") => refused += 1,
                other => panic!("unexpected result: {other:?}"),
            }
        }
        assert_eq!(timed_out, 2, "only the two slots may start work");
        assert_eq!(refused, 8, "calls past the cap must be refused");
        assert!(
            wait_until(|| started.load(Ordering::SeqCst) == 2),
            "workers did not start"
        );
        assert_eq!(
            started.load(Ordering::SeqCst),
            2,
            "refused calls must not start a worker"
        );
        assert_eq!(workers.in_flight(), 2);

        // Once the stuck workers finish, their slots come back and calls are accepted again.
        release.store(true, Ordering::SeqCst);
        assert!(
            wait_until(|| workers.in_flight() == 0),
            "slots were not freed when the workers finished"
        );
        // A client that sends its next call as soon as a result arrives must never be refused. A
        // slot released after the send would show up here only as a race, so repeat the check.
        for _ in 0..200 {
            let after = workers.run(
                std::time::Duration::from_secs(5),
                || Ok("after".to_string()),
            );
            assert_eq!(after.unwrap(), "after");
            assert_eq!(
                workers.in_flight(),
                0,
                "a finished call must release its slot before its result is returned"
            );
        }
    }
}
