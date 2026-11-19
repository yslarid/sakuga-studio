"""Local CLI tests. Fixtures are generated in a temporary directory; optional models stay unloaded."""
import argparse
import contextlib
import io
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import beats
import hdr2sdr
import media_io
import onsetcheck
import shots
import stems
import transcribe

try:
    import numpy as np
except ImportError:
    np = None


class FileTests(unittest.TestCase):
    def test_spans_validate_before_model_import(self):
        self.assertEqual(stems.parse_span("0:1.25"), ("0:1.25", 0, 1.25))
        for bad in ("1:1", "5:2", "-1:1", "nan:1", "0:inf", "1:2:3"):
            with self.subTest(bad=bad), self.assertRaises(argparse.ArgumentTypeError):
                stems.parse_span(bad)

    def test_beat_map_uses_median_and_no_fictitious_tempo(self):
        self.assertEqual(beats.beat_map([0.0, 0.5, 1, 2.25], [0])["bpm"], 120)
        self.assertIsNone(beats.beat_map([3.0], [])["bpm"])

    def test_failed_write_keeps_previous_result_and_cache_checks_settings(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "result.json"
            media_io.write_json(out, {"language": "en", "separated": False})
            with self.assertRaises(ValueError):
                with media_io.atomic_output(out) as pending:
                    pending.write_text("invalid")
                    raise ValueError
            self.assertTrue(media_io.cached(out, language="en", separated=False))
            self.assertFalse(media_io.cached(out, language="ja", separated=False))
            self.assertFalse(media_io.cached(out, language="en", separated=True))

    def test_shot_list_reads_index_without_inference(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.mkv"
            source.touch()
            index = {"scenes": [{"i": 0, "start": 0, "end": 1, "motion": 0.1, "dir": 0, "lum": 0.5}]}
            media_io.write_json(source.with_suffix(".shots.json"), index)
            with contextlib.redirect_stdout(io.StringIO()) as log:
                shots.cmd_list(argparse.Namespace(footage=source, sort="motion"))
            self.assertIn("scene   0", log.getvalue())


@unittest.skipIf(np is None, "requires NumPy")
class SignalTests(unittest.TestCase):
    def test_stem_margins_fades_and_source_start(self):
        samples = np.ones(1000, dtype=np.float32)
        voice = stems.trim_voice(samples, 1000, 0, 0.3, 0)
        self.assertEqual(len(voice), 600)
        self.assertEqual((voice[0], voice[-1], voice[40]), (0, 0, 1))
        with self.assertRaises(ValueError):
            stems.trim_voice(samples, 1000, 5, 6, 0)

    def test_dialogue_word_boundaries_and_loop_filter(self):
        def segment(text, time):
            return {"start": time, "end": time + 1, "text": text,
                    "words": [{"word": text, "start": time + 0.1, "end": time + 0.8}]}
        segments = [segment("Listen", 0), segment("Again", 1), segment("Again", 2),
                    segment("Again", 3), segment("[music]", 4)]
        lines = transcribe.dialogue_lines({"segments": segments, "language": "en"}, np.ones((5 * 16000, 2)))
        self.assertEqual(len(lines), 1)
        self.assertEqual((lines[0]["original"], lines[0]["start"], lines[0]["end"]), ("Listen", 0.1, 0.88))
        self.assertEqual(lines[0]["loud"], 1)
        self.assertEqual(lines[0]["words"][0], ["Listen", 0.1, 0.8])

    def test_alignment_prefers_zero_when_tied(self):
        onsets = np.array([0.2, 0.7, 1.2])
        report = onsetcheck.alignment(onsets, onsets)
        self.assertEqual((report["aligned"], report["best_shift_seconds"]), (3, 0))
        self.assertEqual(onsetcheck.alignment([], [1.0])["aligned_at_best_shift"], 0)

    def test_pq_grayscale_preserves_order_and_neutrality(self):
        code_values = np.tile(np.linspace(0, 1, 100)[:, None], (1, 3))
        mapped = hdr2sdr.tone_map(code_values, 203)
        self.assertTrue(np.all(np.diff(mapped, axis=0) >= 0))
        self.assertTrue(np.isfinite(mapped).all())
        self.assertAlmostEqual(mapped[0, 0], 0)
        self.assertAlmostEqual(mapped[-1, 0], 1)
        self.assertLess(np.max(np.ptp(mapped, axis=1)), 0.001)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class DecoderTests(unittest.TestCase):
    def test_detection_on_real_synthetic_video(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root) / "cuts.mkv"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                            "color=black:s=64x48:r=10:d=1", "-f", "lavfi", "-i",
                            "color=white:s=64x48:r=10:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
                            "-c:v", "ffv1", video], check=True)
            self.assertEqual(shots.scenes_of(str(video), 2, "ffmpeg"), [(0, 1), (1, 2)])
            media_io.write_json(video.with_suffix(".cuts.json"), [0.5])
            self.assertEqual(len(shots.scenes_of(str(video), 2, "ffmpeg")), 3)

    def test_timing_fixture_mixes_recorded_words_and_truth_grid(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            words = root / "words"
            words.mkdir()
            source = root / "music.wav"
            token = words / "hello.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.15", token], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=5", source], check=True)
            lyrics = root / "phrases.txt"
            lyrics.write_text("hello hello", encoding="utf-8")
            subprocess.run([sys.executable, str(TOOLS / "timing_song.py"), str(root / "out"),
                            "--recorded-words", str(words), "--music", str(source), "--lyrics", str(lyrics)],
                           check=True, stdout=subprocess.DEVNULL)
            rows = json.loads((root / "out/timing-song.truth.json").read_text())
            self.assertEqual([row["start"] for row in rows], [1.0, 1.25])
            self.assertEqual([row["end"] for row in rows], [1.15, 1.4])
            self.assertGreater((root / "out/timing-song.m4a").stat().st_size, 0)

    @unittest.skipIf(np is None, "requires NumPy")
    def test_raw_decode_uses_16_khz_stereo(self):
        with tempfile.TemporaryDirectory() as root:
            wav = Path(root) / "tone.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.25", wav],
                           check=True)
            self.assertEqual(transcribe.load_pcm(wav, stereo=True).shape, (4000, 2))

    @unittest.skipIf(np is None, "requires NumPy")
    def test_dialogue_cli_options_and_cache_with_stub_transcriber(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "voice.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", source],
                           check=True)
            segment = {"start": 0.1, "end": 0.8, "text": "hello"}
            model = ModuleType("mlx_whisper")
            languages = []

            def infer(audio, **options):
                self.assertEqual(audio.shape, (16000,))
                self.assertTrue(options["word_timestamps"])
                languages.append(options["language"])
                return {"language": options["language"], "segments": [segment]}

            model.transcribe = infer
            with patch.dict(sys.modules, {"mlx_whisper": model}), contextlib.redirect_stdout(io.StringIO()):
                for language in ("en", "en", "fr"):
                    with patch.object(sys, "argv", ["transcribe.py", str(source), "--raw", "--lang", language]):
                        transcribe.main()
            data = json.loads(source.with_suffix(".dialogue.json").read_text())
            self.assertEqual(languages, ["en", "fr"])
            self.assertEqual((data["lines"][0]["lang"], data["separated"]), ("fr", False))

    @unittest.skipIf(np is None, "requires NumPy")
    def test_beat_cli_decodes_audio_and_reuses_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "music.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", source],
                           check=True)
            calls = []

            def factory(checkpoint_path, device, dbn):
                self.assertEqual((checkpoint_path, device, dbn), ("final0", "cpu", False))

                def track(pcm, rate):
                    calls.append((len(pcm), rate))
                    return [0.0, 0.5], [0.0]
                return track

            fake = {"beat_this": ModuleType("beat_this"), "beat_this.inference": SimpleNamespace(Audio2Beats=factory),
                    "torch": SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)))}
            with patch.dict(sys.modules, fake), patch.object(sys, "argv", ["beats.py", str(source)]):
                with contextlib.redirect_stdout(io.StringIO()):
                    beats.main()
                    beats.main()
            self.assertEqual(calls, [(22050, 22050)])
            self.assertEqual(json.loads(source.with_suffix(".beats.json").read_text())["bpm"], 120)

    @unittest.skipIf(np is None, "requires NumPy")
    def test_stem_cli_writes_48khz_wav_with_stub_separator(self):
        try:
            import soundfile as sf
        except ImportError:
            self.skipTest("requires SoundFile")
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "voices.wav"
            destination = Path(folder) / "stems"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=2", source],
                           check=True)

            class Separator:
                samplerate = 44100

                def separate_audio_file(self, decoded):
                    audio, rate = sf.read(decoded, dtype="float32", always_2d=True)
                    if rate != self.samplerate:
                        raise ValueError("incorrect decode rate")
                    data = SimpleNamespace(numpy=lambda: audio.T)
                    return None, {"vocals": SimpleNamespace(detach=lambda: SimpleNamespace(cpu=lambda: data))}

            argv = ["stems.py", str(source), str(destination), "0.10:0.60"]
            with patch.object(stems, "open_separator", return_value=Separator()) as model, patch.object(sys, "argv", argv):
                with contextlib.redirect_stdout(io.StringIO()) as log:
                    stems.main()
                with contextlib.redirect_stdout(io.StringIO()):
                    stems.main()
            model.assert_called_once()
            out = sf.info(json.loads(log.getvalue())["0.10:0.60"])
            self.assertEqual((out.samplerate, out.channels, out.subtype), (48000, 1, "PCM_16"))
            self.assertAlmostEqual(out.duration, 0.9, places=3)


if __name__ == "__main__":
    unittest.main()
