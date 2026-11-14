#!/usr/bin/env python3
"""Dev-only check of the Quick Draw model against real Quick Draw drawings. Not part of the app.

Runs public/models/quickdraw_model.tflite in the reference LiteRT (TFLite) interpreter on real
samples from Google's numpy-bitmap dataset and reports top-1 / top-5 accuracy for both input
polarities:

  as-is     white strokes (1.0) on black (0.0) — what the app feeds the model (INVERT = false)
  inverted  black strokes (0.0) on white (1.0) — what the model card describes

It also writes e2e/fixtures/quickdraw-parity.json (one input + the interpreter's output), which
e2e/quickdraw.spec.ts replays through the browser implementation to check both runtimes agree.

Setup:  python3 -m venv .venv && .venv/bin/pip install -r scripts/quickdraw-verify/requirements.txt
Run:    .venv/bin/python scripts/quickdraw-verify/verify.py [--categories 30] [--samples 50]

Only the first few samples of each category are downloaded (HTTP range requests), not the
~100 MB files.
"""

import argparse
import json
import random
import struct
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "public" / "models" / "quickdraw_model.tflite"
LABELS = ROOT / "public" / "models" / "labels.txt"
FIXTURE = ROOT / "e2e" / "fixtures" / "quickdraw-parity.json"
DATASET = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/"
PARITY_LABEL = "apple"


def fetch_samples(label: str, n: int) -> np.ndarray:
    """First n bitmaps of a category as uint8 [n, 784] (white strokes on black)."""
    url = DATASET + urllib.parse.quote(label) + ".npy"
    req = urllib.request.Request(url, headers={"Range": f"bytes=0-{255 + 784 * n}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    assert raw[:6] == b"\x93NUMPY", f"{label}: not an .npy file"
    major = raw[6]
    if major == 1:
        (hlen,), start = struct.unpack("<H", raw[8:10]), 10
    else:
        (hlen,), start = struct.unpack("<I", raw[8:12]), 12
    header = raw[start:start + hlen].decode("latin1")
    assert "'|u1'" in header and "784" in header, f"{label}: unexpected header {header!r}"
    data = np.frombuffer(raw, dtype=np.uint8, offset=start + hlen)
    return data[: (len(data) // 784) * 784].reshape(-1, 784)[:n]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--categories", type=int, default=30, help="how many categories to sample (0 = all 345)")
    ap.add_argument("--samples", type=int, default=50, help="drawings per category")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    labels = [l for l in LABELS.read_text().splitlines() if l.strip()]
    assert len(labels) == 345, f"labels.txt has {len(labels)} lines"
    assert MODEL.stat().st_size > 1000, "quickdraw_model.tflite is a Git LFS pointer, not the model"

    interp = Interpreter(model_path=str(MODEL))
    inp, out = interp.get_input_details()[0], interp.get_output_details()[0]
    print(f"model: {MODEL.name}  input {inp['shape_signature'].tolist()} {inp['dtype'].__name__}"
          f"  output {out['shape_signature'].tolist()} {out['dtype'].__name__}")
    assert inp["dtype"] == np.float32, "only the float32-input model is supported"

    def run(batch: np.ndarray) -> np.ndarray:
        interp.resize_tensor_input(inp["index"], [len(batch), 28, 28, 1])
        interp.allocate_tensors()
        interp.set_tensor(inp["index"], batch.reshape(-1, 28, 28, 1).astype(np.float32))
        interp.invoke()
        return interp.get_tensor(out["index"]).copy()

    rng = random.Random(args.seed)
    chosen = labels if args.categories <= 0 else rng.sample(labels, min(args.categories, len(labels)))
    if PARITY_LABEL not in chosen:
        chosen.append(PARITY_LABEL)

    stats = {"as-is": [0, 0], "inverted": [0, 0]}  # [top-1 hits, top-5 hits]
    total = 0
    parity = None
    for label in sorted(chosen):
        x = fetch_samples(label, args.samples).astype(np.float32) / 255.0
        truth = labels.index(label)
        row = []
        for name, batch in (("as-is", x), ("inverted", 1.0 - x)):
            probs = run(batch)
            order = np.argsort(-probs, axis=1)
            top1 = int((order[:, 0] == truth).sum())
            top5 = int((order[:, :5] == truth).any(axis=1).sum())
            stats[name][0] += top1
            stats[name][1] += top5
            row.append(f"{name} {top1:3d}/{len(x)}")
        total += len(x)
        print(f"  {label:24s} {'   '.join(row)}")
        if label == PARITY_LABEL:
            parity = {"label": label, "input": [round(float(v), 6) for v in x[0]],
                      "probs": [float(v) for v in run(x[:1])[0]]}

    print(f"\n{total} drawings from {len(chosen)} categories")
    for name, (top1, top5) in stats.items():
        print(f"  {name:9s} top-1 {100 * top1 / total:5.1f}%   top-5 {100 * top5 / total:5.1f}%")

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(parity) + "\n")
    print(f"\nwrote {FIXTURE.relative_to(ROOT)} (one '{PARITY_LABEL}' drawing, as-is polarity)")


if __name__ == "__main__":
    main()
