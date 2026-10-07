# Nano Banana 2.1 integration

Contract and provider prices verified on 2026-10-07 using the live official
[Kie model page](https://kie.ai/nano-banana-2-1) and its embedded
[API documentation](https://docs.kie.ai/market/google/nanobanana-2-1).

The additive Scenelith model ID and Kie provider ID are `nano-banana-2-1`.
Text generation and editing use `POST /api/v1/jobs/createTask` with the same
model ID. Existing Nano Banana 2 selections and prices remain unchanged.
Canvas, image editing, automation and MCP discover it through the shared
provider catalogue; no separate provider implementation is needed.

## Request contract

- `prompt`: required, up to 20,000 characters.
- `image_input`: image URL array, up to 14 items; JPEG, PNG and WebP, at most
  30 MB each. No reference videos, audio files or keyframe ports.
- `resolution`: `1K`, `2K`, `4K`; default `1K`.
- `aspect_ratio`: `auto`, `1:1`, `2:3`, `3:2`, `1:4`, `4:1`, `3:4`, `4:3`,
  `4:5`, `5:4`, `1:8`, `8:1`, `9:16`, `16:9`, `21:9`; default `auto`.
  The documented schema does not restrict these ratios by resolution.
- `output_format`: `png` or `jpg`. Scenelith requests `png`.

The prose description for `image_input` still says ten images, while the formal
schema says `<= 14 items`, the playground permits fourteen, and the model guide
explicitly describes fourteen. This integration follows the formal schema and
playground. It does not inherit Nano Banana 2's older high-resolution ratio
restrictions.

The verified API does not expose a transparency, mask, search or thinking-level
parameter. PNG is an output format, not a guarantee of transparent output.
Unsupported parameters are not sent.

## Provider quote

| Output | Kie credits per image | Published USD equivalent |
| --- | ---: | ---: |
| 1K | 4 | $0.02 |
| 2K | 6 | $0.03 |
| 4K | 9 | $0.045 |

These are provider-aligned quotes before edition pricing policy. They are not
measurements of a paid task or guarantees of a generation result. This change
was validated with mocked dispatch and local contract tests, without a paid
generation.
