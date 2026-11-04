#!/usr/bin/env python3
"""Parse the CloudyAudio stdout frame protocol and report signal stats.

Protocol: repeat [uint32 LE byteLength][int16 LE samples...]
"""
import array
import statistics
import struct
import sys

SAMPLE_RATE = 16000


def parse(path):
    data = open(path, "rb").read()
    frames = []
    off = 0
    problems = []
    while off + 4 <= len(data):
        (byte_len,) = struct.unpack_from("<I", data, off)
        off += 4
        if byte_len % 2 != 0:
            problems.append(f"odd byteLength {byte_len} at frame {len(frames)}")
            break
        if byte_len >= 1024 * 1024:
            problems.append(f"byteLength {byte_len} >= 1MiB at frame {len(frames)}")
            break
        if byte_len == 0:
            problems.append(f"zero-length frame at {len(frames)}")
            break
        if off + byte_len > len(data):
            problems.append("truncated trailing frame (expected on kill)")
            break
        chunk = array.array("h")
        chunk.frombytes(data[off:off + byte_len])
        if sys.byteorder != "little":
            chunk.byteswap()
        frames.append(chunk)
        off += byte_len
    return frames, problems, len(data) - off


def rms(samples):
    if not samples:
        return 0.0
    return (sum(s * s for s in samples) / len(samples)) ** 0.5


def stats(label, samples):
    peak = max((abs(s) for s in samples), default=0)
    print(f"{label}: n={len(samples)} ({len(samples)/SAMPLE_RATE:.2f}s) "
          f"peak={peak} rms={rms(samples):.1f}")
    return peak, rms(samples)


def main():
    path = sys.argv[1]
    skip_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    frames, problems, trailing = parse(path)

    lengths = [len(f) for f in frames]
    all_samples = [s for f in frames for s in f]

    print(f"file={path} bytes={sum(4 + 2*len(f) for f in frames)}")
    print(f"frame count = {len(frames)}")
    if lengths:
        print(f"frame sample sizes: min={min(lengths)} max={max(lengths)} "
              f"mean={statistics.mean(lengths):.1f}")
    print(f"total samples = {len(all_samples)} "
          f"({len(all_samples)/SAMPLE_RATE:.2f}s @ {SAMPLE_RATE} Hz mono)")
    print(f"protocol problems = {problems if problems else 'none'} "
          f"(trailing unparsed bytes: {trailing})")

    stats("whole capture", all_samples)
    if skip_seconds > 0:
        start = int(skip_seconds * SAMPLE_RATE)
        stats(f"after {skip_seconds:.1f}s skip", all_samples[start:])

    # energy over 0.5s windows, to show the speech actually arrives
    win = SAMPLE_RATE // 2
    print("0.5s-window RMS:", " ".join(
        f"{rms(all_samples[i:i+win]):.0f}"
        for i in range(0, max(1, len(all_samples) - win + 1), win)
    ))


if __name__ == "__main__":
    main()
