"""Bounded local renderer invoked with a private JSON job, never a shell command."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageOps
from tiktok_overlay import make_overlay

Image.MAX_IMAGE_PIXELS = 16_777_216
job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
with Image.open(job["input"]) as opened:
    if opened.width * opened.height > Image.MAX_IMAGE_PIXELS or getattr(opened, "n_frames", 1) != 1:
        raise ValueError("Use a still image up to 16 megapixels")
    profile = opened.info.get("icc_profile")
    base = ImageOps.exif_transpose(opened).convert("RGBA")
layer, info = make_overlay(base.size, job["text"], **job["options"])
Image.alpha_composite(base, layer).save(job["output"], format="PNG", icc_profile=profile)
if job.get("overlay"):
    layer.save(job["overlay"], format="PNG")
print(json.dumps({**info, "width": base.width, "height": base.height}, ensure_ascii=False))
