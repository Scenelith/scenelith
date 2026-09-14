# Local text overlay

Add **Text overlay** between **Image Generator** and **Add slideshow to canvas**. It draws exact lettering locally; no generation provider is called and no extra generation credits are charged. The source image and its generation history remain intact. A new image asset is passed to the next node.

## Prepare clean backgrounds

Use **Prepare slideshow image requests, version 2**, and choose **Local Text overlay node** under **Who draws the text?**. This keeps each slide's caption in `presentation.overlayText`, removes its approved typography instruction from the image prompt, and asks for a clean background. The rewrite and review nodes still decide the wording.

Connect: checked plans → Prepare slideshow image requests v2 → Image Generator → Text overlay → Add slideshow to canvas. Existing workflows retain their pinned node versions. Replace the old preparation node with version 2 from the node picker and reconnect the same plans, source and optional references when adopting this path.

To let the image model render lettering instead, choose **Image model** and connect Image Generator directly to Add slideshow to canvas. Turning **Apply text overlay** off also passes images through unchanged. Local rendering cannot erase lettering already baked into an image.

## Inputs and outputs

- **Images**: the canonical `generated-assets` output of Image Generator. Images are loaded by authorized asset ID, never by an arbitrary supplied URL.
- **Rewritten slide text**, optional: a string applied to every image, or `{ "slides": [{ "index": 1, "overlayText": "First caption" }] }`. This connects directly to structured rewrite output with that shape. Objects may retain other review/evidence fields. Indexes must be unique and match the successful images exactly; use the embedded per-image captions for partially successful generation batches.
- **Same text on every image**, optional: manual text used if no connected text is supplied. Leave blank to use each image's own caption.
- **Images with text**: the same `generated-assets` contract, order, slide indexes, references and original generation charges, with new image asset IDs and URLs. Empty captions pass their original image through.
- **Transparent text layers**: `{ "items": [{ "index": 1, "requestKey": "1", "assetId": "…", "url": "/api/assets/…" }] }` when enabled. An empty list otherwise. Layer IDs are also included in each result's `metadata.textOverlay` alongside the original image ID and exact layout.

## Settings

Position is the center of the visible text block in percent: Y 30 near the top, 50 centered, 70 lower. X defaults to 50. Font size uses output pixels; 0 scales automatically with image width. The size multiplier, maximum line width, line spacing and black outline thickness are editable. Text is white, using the included TikTok Sans-derived font distributed under OFL. Manual newlines and literal `\n` are supported, with automatic wrapping of long lines.

Text that cannot fit fails explicitly rather than being cropped. Move the block or reduce its font size/width. Supported inputs are still images up to 16 megapixels and 32 MB; text is bounded to 2000 characters per slide. The output is PNG at the source's oriented dimensions. Transparent layers are optional. Derived assets count toward workflow asset limits and workspace storage quotas. Repeating the same node input in the same run reuses the saved result.

## Runtime dependency

The production image includes Python 3 and Pillow. For development, install Pillow into the Python selected by `SCENELITH_PYTHON` (default `python3`). On Debian/Ubuntu use `python3-pil`. The supplied rendering algorithm, font, preset and OFL license are bundled under `src/lib/text-overlay/`; rendering does not download a font or make a network call.
