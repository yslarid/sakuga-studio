"""Common file handling for Sakuga Studio's optional command-line tools."""
import argparse
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import tempfile


def input_file(value):
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"no such file: {value}")
    return path


def seconds(value):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise argparse.ArgumentTypeError("expected finite, nonnegative seconds")
    return value


def source_stamp(path):
    st = Path(path).stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "name": Path(path).name}


def cached(path, **fields):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return isinstance(data, dict) and all(data.get(key) == value for key, value in fields.items())
    except (OSError, ValueError, UnicodeError):
        return False


@contextmanager
def atomic_output(path):
    """Keep the last successful output if decoding, inference or encoding fails."""
    path = Path(path)
    with tempfile.TemporaryDirectory(dir=path.parent) as folder:
        draft = Path(folder) / path.name
        yield draft
        os.replace(draft, path)


def write_json(path, payload):
    with atomic_output(path) as draft:
        draft.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
