#!/usr/bin/env python3
"""Compare cut timestamps to spectral-flux onsets and a seeded random-offset baseline."""
import argparse
import json
import subprocess

from media_io import input_file, seconds


def flux_trace(samples, rate):
    import numpy as np
    from scipy.signal import stft
    if len(samples) < 2048:
        return np.array([]), np.array([])
    hop = 441
    _, times, spectrum = stft(samples, rate, nperseg=2048, noverlap=2048 - hop)
    flux = np.maximum(np.diff(np.log1p(np.abs(spectrum) * 100), axis=1), 0).sum(0)
    peak = flux.max(initial=0)
    return times[1:], flux / peak if peak > 0 else flux


def alignment(onsets, cuts, tolerance=0.04):
    """Find nearest onsets without allocating a cuts-by-onsets distance matrix."""
    import numpy as np
    onsets = np.sort(onsets)
    cuts = np.asarray(cuts, dtype=float)

    def score(shift):
        if not len(onsets):
            return 0
        shifted = cuts + shift
        i = np.searchsorted(onsets, shifted)
        before = onsets[np.clip(i - 1, 0, len(onsets) - 1)]
        after = onsets[np.clip(i, 0, len(onsets) - 1)]
        return int((np.minimum(abs(shifted - before), abs(shifted - after)) <= tolerance).sum())

    # Prefer a smaller correction when two offsets score equally well.
    best = max(range(-12, 13), key=lambda centisec: (score(centisec / 100), -abs(centisec)))
    rng = np.random.default_rng(1)
    baseline = [score(shift) for shift in rng.uniform(-0.5, 0.5, 400)]
    return {"onsets": len(onsets), "cuts": len(cuts), "aligned": score(0),
            "best_shift_seconds": best / 100, "aligned_at_best_shift": score(best / 100),
            "random_mean": round(float(np.mean(baseline)), 2), "random_stddev": round(float(np.std(baseline)), 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=input_file)
    parser.add_argument("cuts", type=seconds, nargs="+", metavar="SECONDS")
    args = parser.parse_args()
    import numpy as np
    from scipy.signal import find_peaks
    rate = 44100
    pcm = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", args.audio, "-vn", "-ac", "1",
                          "-ar", str(rate), "-f", "f32le", "-"], stdout=subprocess.PIPE, check=True).stdout
    times, flux = flux_trace(np.frombuffer(pcm, dtype="<f4"), rate)
    reports = []
    for threshold in (0.35, 0.25, 0.18):
        peak_idx, _ = find_peaks(flux, height=threshold, distance=8)
        reports.append({"min_strength": threshold, **alignment(times[peak_idx], args.cuts)})
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
