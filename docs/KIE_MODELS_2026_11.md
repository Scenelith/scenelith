# Kie generation models, November 2026

Contracts and provider prices were checked on 12 November 2026.

| Scenelith model | Provider routes | Generation controls |
| --- | --- | --- |
| MiniMax H3 Image | `minimax-h3/text-to-image`, `minimax-h3/image-edit` | 1K, 2K, 4K. Up to 16 images. PNG/JPEG, prompt expansion and seed. |
| Seedream 5.5 | `seedream/5-5-text-to-image`, `seedream/5-5-image-to-image` | 1K, 1.5K, 2K through `size`. Up to 10 images. Automatic ratio requires an input image. |
| GPT Image 2.6 Flare / Sunburst | `gpt-image-2-6/{variant}-text-to-image`, `gpt-image-2-6/{variant}-image-to-image` | 1K, 2K, 4K. Up to 16 images. Raster output at medium quality. |
| GPT Image 2.6 Economy | `gpt-image-2-6/economy-text-to-image`, `gpt-image-2-6/economy-image-to-image` | 1K, PNG and the documented subset of image ratios. |
| Kling 4.0 Flash References | `kling-4.0/flash-reference-to-video` | 720p, 3–20 seconds, up to 10 images and 5 videos. Videos total at most 20 seconds. Native audio. |
| Kling 4.0 Flash First frame | `kling-4.0/flash-keyframe-to-video` | 720p, 3–20 seconds, one optional first frame. Output follows its ratio. Native audio. |
| Gemini Omni 1.2 Flash | `google/gemini-omni-flash-1-2` | 360p–4K, 3–15 seconds, 6 images or 5 images plus one video. First/last frames limit output to 10 seconds. Video edits send a URL array and omit duration. |

All models reuse `https://api.kie.ai/api/v1/jobs/createTask`, the existing
`recordInfo` polling endpoint, verified callbacks and the configured Kie file
upload connection. The integration adds no outbound destinations.

## Provider consumption and reservations

MiniMax output costs 1.8 credits at 1K/2K or 5.5 at 4K, plus 0.5 per input
image. Seedream output costs 3.6 at 1K/1.5K or 6.3 at 2K, plus 1.44 per input.
Economy costs 5 credits per image.

Kling Flash costs 17 credits per output second without video input, or 11.3
per billed second with video input. Billed video seconds are the greater of
input plus output or twice the output. Omni 1.2 costs 4/9/10/22 credits per
second at 360p/720p/1080p/4K. Video edits bill the measured input duration.

Flare and Sunburst have token billing. Kie's per-million-token rates are 900
for uncached text input, 1440 for uncached image input and 5400 for image
output. Cached usage can cost less. `creditsConsumed` from a completed task
is the authority for the actual provider charge.

The displayed reservation is a budget derived from those rates and estimated
token allowances of 32,000 text tokens, 8,192 tokens per reference, and
4,096/8,192/16,384 output tokens at 1K/2K/4K. Those allowances are estimates.
They are not measured consumption or provider guarantees. Cloud applies its
existing provider-cost conversion to the measured charge and limits the final
charge to the approved reservation. Unused credits return to their original
balance buckets, subject to subscription expiry. Missing usage remains pending
and is retried independently of the already saved image. Self-hosted operators
pay Kie directly.

The image generator exposes text generation and raster editing. Layer
decomposition and GIF/SVG authoring require separate output workflows.

## Sources

- https://docs.kie.ai/market/minimax-h3/image-edit
- https://docs.kie.ai/market/seedream/5-5-text-to-image
- https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-text-to-image
- https://docs.kie.ai/market/kling/v4-flash-reference-to-video
- https://docs.kie.ai/market/google/gemini-omni-flash-1-2
- https://docs.kie.ai/market/common/get-task-detail
- https://kie.ai/pricing
- https://kie.ai/gemini-omni-1-2-flash
