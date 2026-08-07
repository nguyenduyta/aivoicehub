//! Mixes two capture streams into one.
//!
//! Used for the "both" audio source: system audio carries the remote participants, the
//! microphone carries the local speaker, and a meeting transcript needs both. Since both
//! captures already emit the same format (PCM s16le, 16 kHz, mono — see `TARGET_SAMPLE_RATE`),
//! mixing is a straight per-sample sum; no resampling is involved.
//!
//! Sending the two streams to Soniox interleaved is not an option — the chunks would arrive as
//! alternating slices of two different conversations and transcribe as noise. They have to be
//! summed sample-for-sample into a single timeline.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::TARGET_SAMPLE_RATE;

/// One mixed frame = 100 ms. Matches the batching interval the forwarder already uses.
const FRAME_MS: u64 = 100;
const FRAME_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize) * (FRAME_MS as usize) / 1000;

/// How much un-mixed audio a source may hold before the oldest is dropped.
///
/// This is the knob that bounds latency. Output is paced to real time (see the loop), which
/// means a backlog built up by one burst would otherwise sit there forever — measured at a
/// standing ~220 ms on system audio while the mic sat near 20 ms. Trimming to 150 ms caps that
/// delay and keeps the two sources roughly aligned. Dropping a few ms of old audio now and
/// then is far cheaper than the alternative, see the pacing comment in `mix`.
const MAX_BACKLOG_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize) * 150 / 1000;

/// Spawns a mixing thread and returns the combined stream.
///
/// The thread exits when both inputs have disconnected and their backlogs are drained, or as
/// soon as the consumer drops the returned receiver.
pub fn mix(
    left: mpsc::Receiver<Vec<u8>>,
    right: mpsc::Receiver<Vec<u8>>,
) -> mpsc::Receiver<Vec<u8>> {
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut buf_left: VecDeque<i16> = VecDeque::new();
        let mut buf_right: VecDeque<i16> = VecDeque::new();
        let mut left_open = true;
        let mut right_open = true;

        let frame_period = Duration::from_millis(FRAME_MS);
        let mut next_tick = Instant::now() + frame_period;

        // Rolling counters. Each source should contribute ~16000 samples/s; a number far off
        // that (or a peak stuck at 0) says which side is broken without guessing.
        let mut got_left = 0usize;
        let mut got_right = 0usize;
        let mut peak_left = 0i16;
        let mut peak_right = 0i16;
        let mut frames_out = 0usize;
        let mut last_report = Instant::now();

        loop {
            if left_open {
                left_open = drain(&left, &mut buf_left, &mut got_left, &mut peak_left);
            }
            if right_open {
                right_open = drain(&right, &mut buf_right, &mut got_right, &mut peak_right);
            }

            if last_report.elapsed() >= Duration::from_secs(5) {
                let secs = last_report.elapsed().as_secs_f32();
                println!(
                    "[Mix] system: {:.0}/s peak={} backlog={} open={} | mic: {:.0}/s peak={} backlog={} open={} | frames_out={}",
                    got_left as f32 / secs, peak_left, buf_left.len(), left_open,
                    got_right as f32 / secs, peak_right, buf_right.len(), right_open,
                    frames_out,
                );
                got_left = 0;
                got_right = 0;
                peak_left = 0;
                peak_right = 0;
                frames_out = 0;
                last_report = Instant::now();
            }

            // Both captures stopped and nothing left to emit.
            if !left_open && !right_open && buf_left.is_empty() && buf_right.is_empty() {
                break;
            }

            // Pace output to real time — one frame per FRAME_MS — rather than emitting as fast
            // as samples arrive.
            //
            // Emitting on data availability looks tempting (it drains backlogs to zero) but
            // over-consumes: a burst on one source drains the *other* buffer early and the
            // shortfall gets padded with silence. Measured at 17_120 samples/s consumed against
            // ~15_970/s arriving — a 7% silence pad, landing as a ~7 ms gap at the end of every
            // 100 ms frame. That 10 Hz chop is audible and wrecked recognition outright.
            //
            // Real-time pacing consumes 16_000/s against ~15_970/s arriving: a 0.2% pad, which
            // is inaudible. Latency is bounded by MAX_BACKLOG_SAMPLES instead.
            let now = Instant::now();
            if now < next_tick {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            // Resync rather than burst-catching-up after a long stall (system sleep, say).
            next_tick = if now > next_tick + frame_period * 4 {
                now + frame_period
            } else {
                next_tick + frame_period
            };

            // Nothing usable from either side — don't push pure silence at the recogniser.
            if buf_left.len() < FRAME_SAMPLES && buf_right.len() < FRAME_SAMPLES {
                continue;
            }

            // A source with no samples this frame contributes silence, so "both" keeps working
            // when only one side is producing (nothing playing through the speakers, say).
            let mut frame = Vec::with_capacity(FRAME_SAMPLES * 2);
            for _ in 0..FRAME_SAMPLES {
                let l = buf_left.pop_front().unwrap_or(0) as i32;
                let r = buf_right.pop_front().unwrap_or(0) as i32;
                let mixed = (l + r).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                frame.extend_from_slice(&mixed.to_le_bytes());
            }

            if out_tx.send(frame).is_err() {
                break; // consumer dropped the receiver
            }
            frames_out += 1;
        }
    });

    out_rx
}

/// Moves every pending chunk into `buf`. Returns `false` once the sender is gone.
/// `received` and `peak` accumulate for the diagnostic line in `mix`.
fn drain(
    rx: &mpsc::Receiver<Vec<u8>>,
    buf: &mut VecDeque<i16>,
    received: &mut usize,
    peak: &mut i16,
) -> bool {
    loop {
        match rx.try_recv() {
            Ok(bytes) => {
                for pair in bytes.chunks_exact(2) {
                    let s = i16::from_le_bytes([pair[0], pair[1]]);
                    *peak = (*peak).max(s.saturating_abs());
                    buf.push_back(s);
                }
                *received += bytes.len() / 2;
                if buf.len() > MAX_BACKLOG_SAMPLES {
                    let excess = buf.len() - MAX_BACKLOG_SAMPLES;
                    buf.drain(..excess);
                }
            }
            Err(mpsc::TryRecvError::Empty) => return true,
            Err(mpsc::TryRecvError::Disconnected) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn read_i16(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|p| i16::from_le_bytes([p[0], p[1]]))
            .collect()
    }

    #[test]
    fn sums_both_sources_sample_for_sample() {
        let (tx_l, rx_l) = mpsc::channel();
        let (tx_r, rx_r) = mpsc::channel();

        tx_l.send(pcm(&vec![100i16; FRAME_SAMPLES])).unwrap();
        tx_r.send(pcm(&vec![50i16; FRAME_SAMPLES])).unwrap();
        drop(tx_l);
        drop(tx_r);

        let out = mix(rx_l, rx_r);
        let frame = out.recv_timeout(Duration::from_secs(2)).unwrap();
        let samples = read_i16(&frame);

        assert_eq!(samples.len(), FRAME_SAMPLES);
        assert!(samples.iter().all(|&s| s == 150));
    }

    #[test]
    fn one_silent_source_passes_the_other_through() {
        let (tx_l, rx_l) = mpsc::channel();
        let (_tx_r, rx_r) = mpsc::channel::<Vec<u8>>();

        tx_l.send(pcm(&vec![-200i16; FRAME_SAMPLES])).unwrap();
        drop(tx_l);

        let out = mix(rx_l, rx_r);
        let frame = out.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(read_i16(&frame).iter().all(|&s| s == -200));
    }

    /// A burst must not be emitted faster than real time.
    ///
    /// Emitting on data availability instead of on a clock drains the *other* source's buffer
    /// early and silence-pads the shortfall — a 7% pad measured in practice, landing as a 10 Hz
    /// chop that destroyed recognition. One second of audio dumped at once must still take
    /// about a second to come out.
    #[test]
    fn paces_a_burst_to_real_time_instead_of_dumping_it() {
        let (tx_l, rx_l) = mpsc::channel();
        let (_tx_r, rx_r) = mpsc::channel::<Vec<u8>>();

        // 1 second of audio, handed over in a single burst.
        tx_l.send(pcm(&vec![1000i16; TARGET_SAMPLE_RATE as usize])).unwrap();

        let out = mix(rx_l, rx_r);

        // Real-time pacing yields ~1000/FRAME_MS frames per second, so 400 ms buys ~4.
        std::thread::sleep(Duration::from_millis(400));
        let burst: Vec<_> = std::iter::from_fn(|| out.try_recv().ok()).collect();

        let max_realtime = (400 / FRAME_MS as usize) + 2; // +2 slack for scheduling jitter
        assert!(
            burst.len() <= max_realtime,
            "emitted {} frames in 400ms, real time allows ~{max_realtime}",
            burst.len()
        );
        assert!(!burst.is_empty(), "nothing emitted at all");
    }

    #[test]
    fn clamps_instead_of_wrapping_on_loud_overlap() {
        let (tx_l, rx_l) = mpsc::channel();
        let (tx_r, rx_r) = mpsc::channel();

        tx_l.send(pcm(&vec![30000i16; FRAME_SAMPLES])).unwrap();
        tx_r.send(pcm(&vec![30000i16; FRAME_SAMPLES])).unwrap();
        drop(tx_l);
        drop(tx_r);

        let out = mix(rx_l, rx_r);
        let frame = out.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(read_i16(&frame).iter().all(|&s| s == i16::MAX));
    }
}
