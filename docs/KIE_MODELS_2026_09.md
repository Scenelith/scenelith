# Kie media models added September 2026

Contracts and public credit tables checked on 2026-09-12. Canvas, Video Master and MCP use the same catalogue. The public core owns these shared provider integrations.

| Scenelith model | Kie route | Supported media inputs | Output/settings |
| --- | --- | --- | --- |
| GPT Image 2.5 Flare / Sunburst | `gpt-image-2-5-{flare,sunburst}-{text-to-image,image-to-image}` | 0–16 images, automatic text/edit selection | Image, 1K/2K/4K. 27:16, 16:27, 9:8, 8:9 only at 1K |
| WAN 3.0 / Prime | `wan/3-0-video[-prime]` | Start/end frames **or** up to 10 images, 5 videos, 5 audio clips | Video, 480P/720P/1080P, 2–30s, optional audio |
| PixVerse V6 Text | `pixverse-v6/text-to-video` | Text | Video, 360p/540p/720p/1080p, 1–15s, optional audio |
| PixVerse V6 Image | `pixverse-v6/image-to-video` | 1–2 images | Video; ratio follows images |
| PixVerse V6 Transition | `pixverse-v6/transition` | Required first **and** last frame | Video; ratio follows frames |
| PixVerse V6 Extend | `pixverse-v6/extend` | Required video URL | Video extension; ratio follows input |
| PixVerse V6 References | `pixverse-v6/reference-to-video` | 1–7 subject images with unique `ref_name` bindings | Video; selectable ratio |
| Gemini Omni | `gemini-omni-video` | Up to 7 images; one video consumes 2 of these slots | Video with native audio; 720p/1080p/4k; 4/6/8/10s without video |
| Gemini Omni 1.1 Flash | `google/gemini-omni-flash-1-1` | Same references, or separate start/end frame mode | Same outputs, plus 360p |

WAN timed references are individually 1–15s and total at most 15s per media kind. Input video plus requested output must not exceed 30s. Standard WAN 3 requires a visual reference together with audio. Prime permits audio-only media input; its documentation recommends a visual reference but does not require one. WAN rejects transparent images and enforces documented size/dimension/format limits. Missing stored media metadata is measured before usage reservation.

Omni accepts source videos up to 30s at the provider, but only a selected range of at most 10s may be submitted. Canvas submits the complete, explicitly selected clip (`start: 0`, `ends: measured duration`) and requires the user to trim longer references before running. It never silently takes the first 10s. With video, Omni chooses output duration and ignores the required duration field; the UI shows “Auto duration”, the source is not trimmed to that field, and billing is fixed per task. Generated asset metadata remains the authority for actual output length.

Reference bindings preserve canvas order and labels: WAN uses per-kind `Image1`, `Video1`, `Audio1`; PixVerse fusion uses unique `@image1` names. Incompatible explicit roles are rejected before normalization/charging. Connecting frame versus reference mode reconciles incompatible inputs using the existing visible connection behavior, preserving original timeline media.

## Scope of exposed controls

Only supported media ports are advertised. Omni `audio_ids` and `character_ids` are handles created by separate voice/character APIs, not uploaded audio assets. Those auxiliary workflows are not exposed as generation models. WAN document/webpage references, provider seeds, PixVerse effect templates, fusion background typing, and GPT transparency controls remain optional provider features outside the current canvas controls. Defaults are used; no undocumented parameters are sent. WAN auto duration (`-1`) is not offered because admission needs an explicit output duration for its quote.

## Pricing evidence

Public Kie model pages include `pageData.groupData[].pricingDesc` in their server-rendered page data. Recorded rates use provider **credits**, without prepaid-account bonuses:

- [GPT Image 2.5](https://kie.ai/gpt-image-2-5): both variants, text/edit: 6 / 10 / 16 credits for 1K / 2K / 4K. The English credit table was used; its Chinese translation has a contradictory 1K number.
- [WAN 3.0](https://kie.ai/wan3.0-video): 8 / 16 / 32 credits/s for 480P / 720P / 1080P, multiplied by input plus output seconds.
- [WAN 3.0 Prime](https://kie.ai/wan3.0-video-prime): 12.2 / 25.2 / 50.4 credits/s, same duration rule. The page's 480P dollar equivalent is slightly inconsistent; the explicit **12.2 credit** rate is used.
- [PixVerse V6](https://kie.ai/pixverse-v6): text/image/transition/extend, silent 4 / 5.6 / 7.2 / 14.4 credits/s; audio 5.6 / 7.2 / 9.6 / 18.4. Reference/fusion: silent 4.5 / 6.3 / 8.1 / 16.2; audio 6.3 / 8.1 / 10.8 / 20.7.
- [Omni](https://kie.ai/gemini-omni) and [Omni Flash](https://kie.ai/gemini-omni-1-1-flash): without video, 63 / 84 / 105 / 126 credits for 4 / 6 / 8 / 10 seconds at non-4K resolutions; add 84 credits for 4K. With video: 168 credits, or 252 at 4K.

Quotes round up to whole credits and are estimates, not provider invoice reconciliation.

## API sources

- [Flare text](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image), [Flare edit](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-image-to-image), [Sunburst text](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-text-to-image), [Sunburst edit](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-image-to-image)
- [WAN 3](https://docs.kie.ai/market/wan/3-0-video), [WAN 3 Prime](https://docs.kie.ai/market/wan/3-0-video-prime)
- [PixVerse text](https://docs.kie.ai/market/pixverse/text-to-video), [image](https://docs.kie.ai/market/pixverse/image-to-video), [transition](https://docs.kie.ai/market/pixverse/transition), [extend](https://docs.kie.ai/market/pixverse/extend), [references](https://docs.kie.ai/market/pixverse/reference-to-video)
- [Omni video](https://docs.kie.ai/market/gemini-omni-video), [Flash](https://docs.kie.ai/market/google/gemini-omni-flash-1-1), [voice IDs](https://docs.kie.ai/market/gemini-omni-audio), [character IDs](https://docs.kie.ai/market/gemini-omni-character)

Documentation inconsistencies: WAN's OpenAPI URL property schemas sometimes say “object” although its field descriptions and request examples use URL strings; the adapter follows the examples. An Omni example uses a 20s range despite the explicit maximum of 10s; this integration follows the stated 10s limit.
