//! R3f RED tests: first_byte_ms is measured from REQUEST start (time spent waiting for headers + delayed first chunk).
use super::*;
use std::cell::Cell;
use std::rc::Rc;

struct Delayed { steps: Vec<(Chunk, u128)>, clock: Rc<Cell<u128>> }
impl ByteStream for Delayed {
    fn next_chunk(&mut self, _w: u64) -> Chunk {
        if self.steps.is_empty() { return Chunk::Closed; }
        let (c, adv) = self.steps.remove(0);
        self.clock.set(self.clock.get() + adv);
        c
    }
}

#[test]
fn r3f_first_byte_ms_counts_from_request_start_not_from_first_body_read() {
    let lim = StreamLimits { idle_ms: 60_000, total_ms: 600_000 };
    let clock = Rc::new(Cell::new(0u128));
    // request sent at t=0; headers arrive at t=1500 (model thinking); first SSE chunk 300 ms after; closes 200 ms later
    clock.set(1500);
    let mut s = Delayed { steps: vec![(Chunk::Data(b"data: x\n\n".to_vec()), 300), (Chunk::Closed, 200)], clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream_since(&mut s, &lim, &move || c.get(), 200, 0).unwrap();
    assert_eq!(r.first_byte_ms, Some(1800), "first byte measured from request start");
    assert_eq!(r.total_ms, 2000);
    assert!(r.first_byte_ms.unwrap() > 0 && r.first_byte_ms.unwrap() <= r.total_ms);
}

#[test]
fn r3f_first_byte_ms_is_nonzero_even_when_first_chunk_is_immediate_after_late_headers() {
    let lim = StreamLimits { idle_ms: 60_000, total_ms: 600_000 };
    let clock = Rc::new(Cell::new(900u128)); // headers took 900 ms; first chunk instantly available
    let mut s = Delayed { steps: vec![(Chunk::Data(b"d".to_vec()), 0), (Chunk::Closed, 100)], clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream_since(&mut s, &lim, &move || c.get(), 200, 0).unwrap();
    assert_eq!(r.first_byte_ms, Some(900));
    assert!(r.first_byte_ms.unwrap() <= r.total_ms);
}

#[test]
fn r3f_drain_stream_without_request_start_keeps_old_behaviour() {
    let lim = StreamLimits { idle_ms: 60_000, total_ms: 600_000 };
    let clock = Rc::new(Cell::new(0u128));
    let mut s = Delayed { steps: vec![(Chunk::Data(b"d".to_vec()), 250), (Chunk::Closed, 750)], clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream(&mut s, &lim, &move || c.get(), 200).unwrap();
    assert_eq!((r.first_byte_ms, r.total_ms), (Some(250), 1000));
}
