# Kling 4.0 integration (2026-10-22)

Official contracts: [Reference to Video](https://docs.kie.ai/market/kling/v4-reference-to-video), [Keyframe to Video](https://docs.kie.ai/market/kling/v4-keyframe-to-video), [model and pricing](https://kie.ai/kling-4-0). Read the rendered API schemas; the documentation requires client rendering and was not indexed at launch.

Two catalogue entries use the standard createTask and task-detail/callback lifecycle:

| Scenelith ID | Provider model | Inputs |
| --- | --- | --- |
| `kling-4-reference` | `kling-4.0/reference-to-video` | Up to 10 reference images, 5 reference videos (2–30s each), 3 voice references; total at most 15 |
| `kling-4-keyframe` | `kling-4.0/keyframe-to-video` | Optional start frame, up to 8 chronological middle keyframes, optional end frame; any subset or text alone |

Both accept 1–10,000 prompt characters, integer output duration 3–30s, 720P/1080P (provider lowercase), auto/16:9/9:16/1:1/21:9. New Canvas nodes retain the existing Nano Banana 2.1 / WAN 3 defaults and 9:16. Native sound is generated, so no unsupported sound-off toggle is exposed. References use `keep_original_sound: false`, generating new audio rather than preserving input audio.

Keyframes use at most `min(10, duration + 1)` total frames, including first/last. Middle images retain submitted order. With frames, the provider follows the first provided frame's aspect ratio; Scenelith offers Auto and omits `aspect_ratio` in the provider payload. An end frame without a start frame is explicitly supported.

Canvas aliases are translated to `@image_N`, `@video_N`, `@voice_N`, or `@first_frame`, `@keyframe_N`, `@last_frame`. Every mention must identify a submitted asset; invalid or ambiguous aliases are rejected before reservation. The adapter emits no binding header containing undeclared aliases because KIE rejects every undeclared `@` mention.

The shared image pipeline accepts JPEG/PNG/WebP. Kling media uploads are limited to 10 MiB per image/video, as in the KIE playground. Reference images require sides of 300–65536 pixels and ratio 0.4–2.5. Stored images are measured; video duration is verified through the existing media pipeline before quoting/admission. Voice inputs are named objects in `voices`, not arbitrary audio effects; KIE requires detectable speech. Optional grouped `elements` (multi-view subjects with per-subject voice bindings) are not exposed in this first integration; connected identities use the ordinary image references.

Provider-credit-aligned quotes, rounded up once to whole Scenelith units:

| Mode | 720P | 1080P | Billed seconds |
| --- | --- | --- | --- |
| Keyframes; References without video | 28.5/s | 42.5/s | Output duration |
| References with video | 17/s | 25.5/s | `max(sum(input video durations) + output duration, 2 * output duration)` |

Images and voices alone do not select the video-input rate. A 10s output with a 5s reference costs 340/510 units; with a 15s reference, 425/638. No 4K option is advertised or sent. Contract tests mock provider calls; browser tests exercise the actual node controls and aliases without paid generation.
