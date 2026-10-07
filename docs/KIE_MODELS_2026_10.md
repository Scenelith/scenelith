# Kie model refresh: Nano Banana 2.1 and Seedance 2.5

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

## Seedance 2.5 contract refresh

Rechecked on 2026-10-07 against the live official
[Seedance 2.5 API schema](https://docs.kie.ai/market/bytedance/seedance-2-5)
and [model playground and pricing](https://kie.ai/seedance-2-5).
The existing Scenelith ID `seedance-2-5` and provider ID
`bytedance/seedance-2-5` remain unchanged.

- The API schema explicitly allows `480p`, `720p` and `1080p` without a
  video-only condition. The playground also publishes a 1080p price without
  video input, so the old 1080p video-input restriction has been removed.
- 1080p is now quoted at 158 Kie credits per output second without video;
  with video it is 95 credits per second of input plus output. The old
  68.5-credit input-video rate is obsolete. Lower-resolution rates are unchanged.
- The API schema sets `prompt` to at most 20,480 characters. The playground
  still shows 30,000; transport validation follows the narrower API limit.
- Marketing mentions 4K, but the actual API enum and playground offer only
  480p, 720p and 1080p. This refresh does not expose unsupported 4K output.

The audio field description says enabling generated audio raises cost, while
published prices do not provide separate audio rates. No unverified audio
surcharge or discount is invented. Prices remain provider-aligned estimates,
not measured task charges. No paid generation was made for this verification.
