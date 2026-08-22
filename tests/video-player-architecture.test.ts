import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frameNode = readFileSync(new URL("../src/components/FrameNode.tsx", import.meta.url), "utf8");
const canvasPlayer = readFileSync(new URL("../src/components/CanvasVideoPlayer.tsx", import.meta.url), "utf8");
const masterPlayer = readFileSync(new URL("../src/components/VideoMasterPlayer.tsx", import.meta.url), "utf8");
const segmentedController = readFileSync(new URL("../src/lib/segmented-video-controller.ts", import.meta.url), "utf8");
const editorViewer = readFileSync(new URL("../src/components/VideoEditorViewer.tsx", import.meta.url), "utf8");
const sceneTimeline = readFileSync(new URL("../src/components/VideoSceneTimeline.tsx", import.meta.url), "utf8");
const playbackOwner = readFileSync(new URL("../src/lib/video-playback-owner.ts", import.meta.url), "utf8");
const canvasApp = readFileSync(new URL("../src/components/CanvasApp.tsx", import.meta.url), "utf8");
const assetRoute = readFileSync(new URL("../src/app/api/assets/[id]/route.ts", import.meta.url), "utf8");
const assetUploadRoute = readFileSync(new URL("../src/app/api/assets/route.ts", import.meta.url), "utf8");
const mediaProbe = readFileSync(new URL("../src/lib/media-probe.ts", import.meta.url), "utf8");
const assetExportRoute = readFileSync(new URL("../src/app/api/assets/export/route.ts", import.meta.url), "utf8");
const generateRoute = readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8");
const editorMedia = readFileSync(new URL("../src/lib/editor-media.ts", import.meta.url), "utf8");
const imageGeneration = readFileSync(new URL("../src/components/ui/ai-chat-image-generation-1.tsx", import.meta.url), "utf8");
const mediaViewer = readFileSync(new URL("../src/components/MediaViewer.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("manual scene changes seek and play on one stable media session", () => {
  assert.doesNotMatch(frameNode, /videoMasterPlayerSession|setVideoMasterPlayerSession/);
  assert.match(frameNode, /videoPlaybackManager\.play\(videoMasterPlaybackOwnerId, `\$\{clip\.id\}:\$\{lane\}`, \{[\s\S]*?relativeTime: safeRelativeTime/);
  assert.match(canvasPlayer, /shouldApplyVideoPlaybackRequest\(\{[\s\S]*?targetKey: effectivePlaybackRequest\.targetKey,[\s\S]*?currentKey: playbackKey/);
  assert.match(canvasPlayer, /Number\.isFinite\(effectivePlaybackRequest\.relativeTime\)[\s\S]*?position = safeClipStart/);
  assert.match(frameNode, /onSelect=\{\(clip, lane\) => selectClip\(clip, false, 0, lane, true\)\}/);
  assert.match(frameNode, /selectClip\(nextClip, playback === "manual", 0, videoMasterSelectedLane, playback === "manual", seamlessNext\)/);
  assert.doesNotMatch(editorViewer, /fullscreen-master-player-|setPlayerSession/);
  assert.match(editorViewer, /playbackKey=\{`\$\{selectedClip\.id\}:\$\{selectedLane\}`\}/);
  assert.match(editorViewer, /playbackOwnerId=\{playbackOwnerId\}/);
  assert.match(editorViewer, /onSelect=\{\(clip, lane\) => selectClip\(clip, lane, false, 0, true\)\}/);
  assert.match(editorViewer, /selectClip\(nextClip, selectedLane, sequencePlaying \|\| playback === "manual", 0, playback === "manual", seamlessNext\)/);
});

test("Master scrubbing pauses once and never restarts playback across scene boundaries", () => {
  assert.match(masterPlayer, /const beginScrub = \(event: ReactPointerEvent<HTMLInputElement>\) => \{[\s\S]*?pausePool\(\);[\s\S]*?videoPlaybackManager\.pause\(playbackOwnerId, playbackKey\)/);
  assert.match(masterPlayer, /const scrubAt = \(event: ReactPointerEvent<HTMLInputElement>\) => \{[\s\S]*?getBoundingClientRect\(\)[\s\S]*?setScrubTime\(time\);[\s\S]*?onExternalSeek\(time\)/);
  assert.doesNotMatch(masterPlayer, /const beginScrub = \(event: ReactPointerEvent<HTMLInputElement>\) => \{[\s\S]*?setScrubTime\(displayTime\)/);
  assert.match(masterPlayer, /onPointerDown=\{beginScrub\}[\s\S]*?onPointerMove=\{moveScrub\}[\s\S]*?onPointerCancel=\{finishScrub\}/);
  assert.match(frameNode, /const seekMasterTimeline = \(nextTime: number\) => \{[\s\S]*?setVideoMasterSequencePlaying\(false\);[\s\S]*?setVideoMasterPlayRequest\(null\)/);
  assert.match(frameNode, /selectClip\(targetClip, false, relativeTime, videoMasterSelectedLane\)/);
  assert.match(editorViewer, /const seekTimeline = \(nextTime: number\) => \{[\s\S]*?setSequencePlaying\(false\);[\s\S]*?setPlayRequest\(null\)/);
  assert.match(editorViewer, /selectClip\(target, selectedLane, false, targetRelativeTime\)/);
  assert.doesNotMatch(editorViewer, /if \(sequencePlaying\) videoPlaybackManager\.play\(playbackOwnerId, `\$\{target\.id\}:\$\{selectedLane\}`/);
});

test("Master playhead scene crossings cannot repair a compatible model in a loop", () => {
  assert.match(frameNode, /if \(currentModelSupportsReference \|\| masterPortModel\.id === currentModel\?\.id \|\| !modelSupportsVideoReference\(masterPortModel\)\) return/);
  assert.doesNotMatch(frameNode, /currentModelSupportsReference \? currentModel!\.id : masterPortModel\.id/);
  assert.match(frameNode, /playheadSeekFrameRef\.current = window\.requestAnimationFrame/);
  assert.match(frameNode, /dragPreviewTime \?\? currentTime/);
  assert.match(frameNode, /setDragPreviewTime\(nextTime\);[\s\S]*?onSeek\(nextTime\)/);
  assert.match(frameNode, /requestAnimationFrame\(\(\) => setDragPreviewTime\(null\)\)/);
  assert.match(frameNode, /video-master-timeline-canvas video-scene-timeline-canvas[\s\S]*?onPointerDown=[\s\S]*?beginPlayheadDrag\(event\)[\s\S]*?onPointerMove=\{movePlayhead\}/);
  assert.match(frameNode, /video-master-lane-clip,\.video-master-lane-label,\.video-master-playhead/);
});

test("selected canvas Video Master owns the Space play and pause shortcut after scrubbing", () => {
  assert.match(frameNode, /<VideoMasterPlayer[\s\S]*?active=\{Boolean\(selected && !previewOwnsPlayback\)\}[\s\S]*?keyboardActive=\{Boolean\(selected && !previewOwnsPlayback\)\}/);
  assert.match(masterPlayer, /if \(!keyboardActive\) return;[\s\S]*?event\.code !== "Space"[\s\S]*?focusedInput\.classList\.contains\("video-scene-position-slider"\)[\s\S]*?videoPlaybackManager\.pause\(playbackOwnerId, playbackKey\)[\s\S]*?videoPlaybackManager\.play\(playbackOwnerId, playbackKey/);
});

test("every Video Master play entry replays a completed clip from its beginning", () => {
  assert.match(masterPlayer, /videoPlaybackReplayTime\(Math\.max\(0, Number\(video\?\.currentTime \|\| start\) - start\), duration\)/);
  assert.match(frameNode, /const replayTime = videoPlaybackReplayTime\(videoMasterTransportRelativeTime, selectedPlaybackMedia\.duration\)/);
  assert.match(frameNode, /videoPlaybackManager\.play\(videoMasterPlaybackOwnerId, targetKey, \{ relativeTime: replayTime \}\)/);
});

test("canvas scene selection changes the live playback source before persistence", () => {
  assert.match(frameNode, /const \[videoMasterSelectedClipId, setVideoMasterSelectedClipId\] = useState/);
  assert.match(frameNode, /const selectedClip = clips\.find\(\(clip\) => clip\.id === videoMasterSelectedClipId\)/);
  const selectClip = frameNode.slice(frameNode.indexOf("const selectClip ="), frameNode.indexOf("const seekMasterTimeline ="));
  const localSelection = selectClip.indexOf("setVideoMasterSelectedClipId(clip.id)");
  const persistedSelection = selectClip.indexOf("generator.updateNode(id");
  assert.ok(localSelection >= 0, "the live selection must change synchronously");
  assert.ok(persistedSelection > localSelection, "persistence must follow the live transport selection");
  assert.match(frameNode, /videoMasterLiveSelectionOwnedRef[\s\S]*?if \(videoMasterLiveSelectionOwnedRef\.current\) return/);
  assert.match(selectClip, /videoMasterLiveSelectionOwnedRef\.current = true;[\s\S]*?setVideoMasterSelectedClipId\(clip\.id\)/);
});

test("each selected clip owns an isolated media event session", () => {
  assert.match(canvasPlayer, /const sessionKey = `\$\{playbackKey \|\| "media"\}\|\$\{src\}\|/);
  assert.match(canvasPlayer, /desiredKeyRef\.current = sessionKey/);
  assert.match(canvasPlayer, /snapshot\.key !== desiredKeyRef\.current/);
  assert.match(segmentedController, /private commandId = 0/);
  assert.match(segmentedController, /operation === this\.commandId/);
});

test("source loading is owned by the transport and each deck loads a source only once", () => {
  assert.doesNotMatch(canvasPlayer, /\.load\(\)/);
  assert.match(segmentedController, /if \(this\.deckSources\[index\]\.src === src\) \{[\s\S]*?if \(!deck\.error && deck\.networkState !== NETWORK_NO_SOURCE\) return true/);
  assert.match(segmentedController, /deck\.src = src;\s+deck\.load\(\)/);
  assert.match(canvasPlayer, /<video ref=\{deckARef\} className="inline-video-deck"/);
  assert.match(canvasPlayer, /<video ref=\{deckBRef\} className="inline-video-deck"/);
  assert.match(canvasPlayer, /controller\.preload\(directPreloadSource, preloadStart\)/);
  assert.doesNotMatch(segmentedController, /transportReloadReason|stalled-assigned-source/);
  assert.match(segmentedController, /if \(!command\.play && !await this\.waitForCurrentData/);
});

test("an explicit scene click cannot cancel its own pending transport", () => {
  assert.match(canvasPlayer, /const pendingPlaybackRequestRef = useRef/);
  assert.match(canvasPlayer, /if \(requestToken === undefined[\s\S]*?pendingExplicitRequest[\s\S]*?return false;/);
  assert.match(canvasPlayer, /if \(requestAlreadyPending\) return/);
  assert.match(canvasPlayer, /pendingPlaybackRequestRef\.current = \{ token: requestToken, targetKey: playbackKey \}/);
});

test("the first post-reload click survives controller mount and cold media preparation", () => {
  const syncTransport = canvasPlayer.slice(canvasPlayer.indexOf("const syncTransport ="), canvasPlayer.indexOf("const stopPlayback ="));
  assert.match(syncTransport, /if \(!controller \|\| !config\.source \|\| !transportAttachedRef\.current\) return false/);
  assert.match(syncTransport, /pendingPlaybackRequestRef\.current = \{ token: requestToken, targetKey: playbackKey \}/);
  assert.ok(syncTransport.indexOf("if (!controller || !config.source || !transportAttachedRef.current) return false") < syncTransport.indexOf("pendingPlaybackRequestRef.current = { token: requestToken"), "a command may only become pending after the controller and its foreground lease exist");
  assert.match(syncTransport, /transportRetryTimerRef\.current = window\.setTimeout[\s\S]*?current\.id !== retryToken[\s\S]*?syncTransport\(retryPosition, retryToken\)/);
  assert.match(syncTransport, /if \(!applied \|\| desiredKeyRef\.current !== config\.key\)[\s\S]*?transportRetryRef\.current\.attempts < 4[\s\S]*?syncTransport\(position, requestToken\)/);
  const requestEffect = canvasPlayer.slice(canvasPlayer.indexOf("const requestAlreadyPending"), canvasPlayer.indexOf("useEffect(() => {\n    if (managerCommand.action"));
  assert.doesNotMatch(requestEffect, /pendingPlaybackRequestRef\.current =/);
});

test("the first imported source scene uses the same durable player as Video Master", () => {
  assert.match(sceneTimeline, /<VideoMasterPlayer[\s\S]*?playbackOwnerId=\{playbackOwnerId\}[\s\S]*?playbackKey=\{selectedSegment\.id\}/);
  assert.match(sceneTimeline, /setPlayRequest\(\{ token: command\.id, targetKey, relativeTime: safeRelativeTime \}\)/);
  assert.match(sceneTimeline, /<VideoMasterPlayer[\s\S]*?playRequestToken=\{playRequest\?\.targetKey === selectedSegment\.id \? playRequest\.token : undefined\}[\s\S]*?playRequestRelativeTime=\{playRequest\?\.targetKey === selectedSegment\.id \? playRequest\.relativeTime : undefined\}/);
  assert.doesNotMatch(sceneTimeline, /SegmentedVideoController|runPlaybackCommand|transportRetryTimerRef/);
  assert.match(masterPlayer, /if \(commandRef\.current !== command\.id\) runCommand\(command\.id, Number\(command\.relativeTime \|\| 0\)\)/);
  assert.match(masterPlayer, /retryTimerRef\.current = window\.setTimeout\(\(\) => runCommand\(commandId, relativeTime, attempt \+ 1\)/);
});

test("a completed uploaded scene relinquishes manual and hover playback before React advances", () => {
  assert.match(canvasPlayer, /onEnded: \(intent, playbackSessionKey\) => \{[\s\S]*?manualPlaybackRef\.current = false;[\s\S]*?hoverSuppressedRef\.current = true;/);
  assert.match(canvasPlayer, /callbacksRef\.current\.onClipEnded\?\.\(intent, playbackSessionKey\)/);
});

test("a completed last scene rests on its real final frame until the next play command", () => {
  assert.match(canvasPlayer, /const completedPlaybackRef = useRef/);
  assert.match(canvasPlayer, /completedPlaybackRef\.current = \{[\s\S]*?key: playbackSessionKey,[\s\S]*?Math\.min\(configRef\.current\.end/);
  assert.match(canvasPlayer, /completedPlayback\?\.key === sessionKey[\s\S]*?position = completedPlayback\.position/);
  assert.match(canvasPlayer, /completedPlaybackRef\.current = null;[\s\S]*?manualPlaybackRef\.current = effectivePlaybackRequest\.playing/);
  assert.match(frameNode, /videoPlaybackManager\.complete\(videoMasterPlaybackOwnerId, `\$\{selectedClip\.id\}:\$\{videoMasterSelectedLane\}`\)/);
});

test("late play events cannot reclaim playback after another node takes ownership", () => {
  assert.match(segmentedController, /this\.commandAbort\?\.abort\(\)/);
  assert.match(segmentedController, /if \(!this\.isCurrent\(operation\)\) \{[\s\S]*?if \(this\.deckCommandIds\[deckIndex\] === operation\) deck\.pause\(\)/);
  assert.match(canvasPlayer, /videoPlaybackManager\.claim\(playbackOwnerIdRef\.current, playbackKeyRef\.current, managerCommandIdRef\.current, deck\)/);
  assert.match(sceneTimeline, /<VideoMasterPlayer/);
  assert.match(masterPlayer, /videoPlaybackManager\.claim\(playbackOwnerId, commandKey, commandId, video\)/);
  assert.match(playbackOwner, /current\.id === commandId[\s\S]*?current\.ownerId === ownerId[\s\S]*?current\.targetKey === targetKey/);
  assert.match(canvasPlayer, /if \(!requestedPlayback && \(managerCommand\.action === "stop" \|\| managerCommand\.ownerId !== ownerId\)\) \{[\s\S]*?stopPlayback\(true, true\);[\s\S]*?return;/);
  assert.match(canvasPlayer, /if \(current\.action === "play" && current\.ownerId === ownerId && current\.targetKey === \(playbackKey \|\| null\)\) managerCommandId = current\.id;[\s\S]*?else return;/);
});

test("canvas focus cannot revoke a newer nested playback command", () => {
  const selection = canvasApp.slice(canvasApp.indexOf("function selectCanvasNode"), canvasApp.indexOf("function focusMasterClipSource"));
  assert.match(selection, /const selectedNodes = nodesRef\.current\.filter\(\(node\) => node\.selected\)/);
  assert.match(selection, /setSelectedId\(nodeId\);[\s\S]*?if \(alreadyExclusivelySelected\) return;/);
  assert.match(selection, /const next = selectGraphNode\(nodesRef\.current, nodeId\);[\s\S]*?nodesRef\.current = next;[\s\S]*?setNodes\(next\);/);
  assert.doesNotMatch(selection, /stopAllVideoPlayback/);
  assert.match(canvasApp, /onPaneClick=\{\(\) => \{\s*stopAllVideoPlayback\(\);\s*setSelectedId\(null\)/);
});

test("selecting a node never starts media without an explicit transport gesture", () => {
  assert.match(playbackOwner, /private readonly lastTargets = new Map/);
  assert.match(playbackOwner, /getLastTarget\(ownerId: string\)/);
  assert.doesNotMatch(frameNode, /videoMasterWasNodeSelectedRef|resumeMasterPlaybackFromNode|videoMasterNodePlaybackIssuedRef/);
  assert.match(frameNode, /onActivate=\{\(\) => generator\?\.selectNode\(id\)\}/);
  assert.match(sceneTimeline, /videoPlaybackManager\.play\(playbackOwnerId, targetKey/);
  assert.match(sceneTimeline, /<VideoMasterPlayer[\s\S]*?active=\{selected\}/);
  assert.doesNotMatch(sceneTimeline, /\.play\(\)/);
  assert.doesNotMatch(sceneTimeline, /if \(!selected\) stopTransport\(\)/);
  assert.doesNotMatch(sceneTimeline, /if \(!selected[\s\S]{0,80}playbackCommand\.action !== "play"/);
  assert.doesNotMatch(sceneTimeline, /if \(!selected\) stopPlayback\(\)/);
  assert.match(frameNode, /if \(previewOwnsPlayback\) \{[\s\S]*?videoMasterLiveSelectionOwnedRef\.current = false;[\s\S]*?setVideoMasterSelectedClipId/);
});

test("TikTok import atomically transfers the paused media lease to its new editor", () => {
  const importFlow = canvasApp.slice(canvasApp.indexOf("async function importSource"), canvasApp.indexOf("async function createProject"));
  assert.match(importFlow, /const focusedImportedNode = videoTimelineNode \|\| sceneNodes\[0\] \|\| sourceNode/);
  assert.match(importFlow, /stopAllVideoPlayback\(\);[\s\S]*?setSelectedId\(focusedImportedNode\.id\);[\s\S]*?commitGraph\(selectGraphNode\([\s\S]*?focusedImportedNode\.id\)/);
  assert.match(sceneTimeline, /setSelectedSegmentId\(currentSegment\.id\);[\s\S]*?play\(true, 0, currentSegment\.id\)/);
  assert.match(masterPlayer, /shouldAttachVideoTransport\(\{ selected: active, ownerId: playbackOwnerId, command \}\)/);
});

test("realtime graph hydration preserves local node selection without persisting it", () => {
  assert.match(canvasApp, /const \[selectedId, setSelectedIdState\] = useState<string \| null>\(null\);[\s\S]*?const selectedIdRef = useRef<string \| null>\(null\);/);
  assert.match(canvasApp, /const setSelectedId = useCallback\(\(nodeId: string \| null\) => \{[\s\S]*?selectedIdRef\.current = nodeId;[\s\S]*?setSelectedIdState\(nodeId\)/);
  const hydrationStart = canvasApp.indexOf("const applyCollaborativeGraph");
  const hydration = canvasApp.slice(hydrationStart, canvasApp.indexOf("useCanvasCollaboration", hydrationStart));
  assert.match(hydration, /const localSelectedId = selectedIdRef\.current/);
  assert.match(hydration, /const viewNodes = selectedNodeStillExists && localSelectedId[\s\S]*?selectGraphNode\(hydratedNodes, localSelectedId\)/);
  assert.match(hydration, /nodesRef\.current = viewNodes;[\s\S]*?localNodesStateRef\.current = viewNodes;[\s\S]*?setNodesState\(viewNodes\)/);
  assert.match(hydration, /graph: \{ \.\.\.graph, nodes: stableNodes, edges: normalizedEdges \}/);
  assert.doesNotMatch(hydration, /graph: \{ \.\.\.graph, nodes: viewNodes/);
});

test("fresh TikTok Play remains pending in the shared player until its first decoded frame is ready", () => {
  assert.match(sceneTimeline, /videoPlaybackManager\.play\(playbackOwnerId, targetKey/);
  assert.match(masterPlayer, /if \(video\.readyState >= HTMLMediaElement\.HAVE_METADATA && !video\.error\) void execute\(\)/);
  assert.match(masterPlayer, /video\.addEventListener\("loadedmetadata"[\s\S]*?void execute\(\)/);
  assert.match(masterPlayer, /await video\.play\(\);[\s\S]*?videoPlaybackManager\.claim/);
});

test("timeline playback explicitly starts every next physical clip", () => {
  assert.match(frameNode, /if \(nextClip\) selectClip\(nextClip, playback === "manual", 0, videoMasterSelectedLane, playback === "manual", seamlessNext\)/);
  assert.match(editorViewer, /selectClip\(nextClip, selectedLane, sequencePlaying \|\| playback === "manual", 0, playback === "manual", seamlessNext\)/);
});

test("source timeline reuses the editor-owned Video Master player on direct object storage ranges", () => {
  assert.match(sceneTimeline, /<VideoMasterPlayer[\s\S]*?src=\{src\}[\s\S]*?clipStart=\{selectedSegment\.start\}[\s\S]*?clipEnd=\{selectedSegment\.end\}/);
  assert.doesNotMatch(sceneTimeline, /SegmentedVideoController|className="inline-video-deck"|controllerRef/);
  assert.doesNotMatch(sceneTimeline, /\.load\(\)|\.play\(\)|setAttribute\("src"|removeAttribute\("src"/);
  assert.doesNotMatch(sceneTimeline, /src=\{directAssetUrl\(src\)\}/);
  assert.doesNotMatch(sceneTimeline, /function streamAssetUrl/);
  assert.match(editorMedia, /export function editorPlaybackUrl[\s\S]*?searchParams\.set\("delivery", "direct"\)/);
});

test("Video Master lets object storage own cold byte ranges and refreshes failed signed media", () => {
  assert.match(canvasPlayer, /searchParams\.set\("delivery", "direct"\)/);
  const playbackUrlHelper = canvasPlayer.slice(canvasPlayer.indexOf("export function assetPlaybackUrl"), canvasPlayer.indexOf("function assetThumbnailUrl"));
  assert.doesNotMatch(playbackUrlHelper, /delivery", "stream"/);
  const masterPlaybackUrlHelper = editorMedia.slice(editorMedia.indexOf("export function editorPlaybackUrl"), editorMedia.indexOf("export function editorSourcePlaybackUrl"));
  assert.match(masterPlaybackUrlHelper, /searchParams\.set\("delivery", "direct"\)/);
  assert.doesNotMatch(masterPlaybackUrlHelper, /searchParams\.delete\("delivery"\)/);
  assert.match(segmentedController, /deck\.networkState !== NETWORK_NO_SOURCE/);
  assert.match(segmentedController, /deck\.removeAttribute\("src"\);\s+deck\.load\(\)/);
});

test("direct object-storage redirects are browser-private and bounded-cacheable", () => {
  assert.match(assetRoute, /const DIRECT_REDIRECT_CACHE_CONTROL = "private, max-age=300"/);
  assert.match(assetRoute, /"cache-control": DIRECT_REDIRECT_CACHE_CONTROL/);
  assert.doesNotMatch(assetRoute, /"cache-control": "private, no-store"/);
});

test("timeline filmstrips never allocate video decoders", () => {
  assert.doesNotMatch(frameNode, /video-master-clip-filmstrip[^\n]*<video/);
  assert.doesNotMatch(frameNode, /video-master-lane-clip[^\n]*<video/);
});

test("passive canvas previews never allocate media transports", () => {
  assert.doesNotMatch(frameNode, /GeneratorReferencePreview[\s\S]*?<video[^>]+preload="metadata"/);
  assert.doesNotMatch(frameNode, /generator-history-grid[\s\S]{0,900}<video/);
  assert.doesNotMatch(canvasApp, /inspector-screen[^\n]*<video/);
});

test("the shared player keeps a real poster frame above its passive blur", () => {
  assert.match(masterPlayer, /backdropUrl && <span className="inline-video-backdrop"/);
  assert.match(masterPlayer, /!transportAttached && backdropUrl && <img className="inline-video-deck inline-video-poster"[\s\S]*?src=\{backdropUrl\}/);
  assert.match(masterPlayer, /src=\{transportAttached && source === playbackSource \? source : undefined\}/);
});

test("the canvas minimap cannot intercept editor timeline clicks", () => {
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(canvasApp, /<MiniMap[\s\S]*?pannable=\{false\}[\s\S]*?zoomable=\{false\}/);
  assert.match(styles, /\.react-flow__minimap\s*\{[^}]*pointer-events\s*:\s*none\s*!important/);
  assert.match(styles, /\.react-flow__minimap \*\s*\{[^}]*pointer-events\s*:\s*none\s*!important/);
});

test("blur layers are static imagery and cannot compete with foreground playback", () => {
  assert.doesNotMatch(frameNode, /inline-video-backdrop-video/);
  assert.doesNotMatch(sceneTimeline, /video-scene-backdrop-video/);
  assert.doesNotMatch(editorViewer, /video-editor-viewer-ambient[^\n]*<video/);
});

test("generation progress stays compositor-only and does not duplicate full-size images", () => {
  assert.match(imageGeneration, /usePageInView\(\)/);
  assert.match(imageGeneration, /useReducedMotion\(\)/);
  assert.match(imageGeneration, /transform: \["translate3d\(/);
  assert.doesNotMatch(imageGeneration, /backgroundPosition|image-generation-blur/);
  assert.doesNotMatch(globalStyles, /\.image-generation-(?:scrim|shimmer)[^{]*\{[^}]*backdrop-filter/);
  assert.match(globalStyles, /\.generator-generation-progress \.image-generation-frame \{ background:transparent; \}/);
  assert.match(imageGeneration, /data-label=\{visibleLabel\}/);
  assert.match(mediaViewer, /className="media-viewer-background" src=\{assetThumbnailUrl\(displayUrl\)\}/);
  assert.doesNotMatch(mediaViewer, /<ImageGeneration[^>]*>[\s\S]{0,300}<img src=\{displayUrl\}/);
  assert.match(frameNode, /const showCanvasGenerationProgress = activeGeneration && !previewOwnsPlayback/);
});

test("selecting a source scene issues one stable seek-and-play command", () => {
  assert.match(sceneTimeline, /<VideoMasterPlayer/);
  assert.match(sceneTimeline, /const playSelectedSourceSegment = \(segment: VideoSceneSegment\) => \{[\s\S]*?play\(true, 0, currentSegment\.id\);/);
  assert.equal((sceneTimeline.match(/\.play\(\)/g) || []).length, 0, "the component never starts a physical media deck directly");
  assert.equal((sceneTimeline.match(/\.load\(\)/g) || []).length, 0, "the component never reloads a physical media deck directly");
  assert.doesNotMatch(sceneTimeline, /setAttribute\("src"|removeAttribute\("src"|\.src\s*=/);
  assert.match(sceneTimeline, /handledSegmentClickRef\.current === segment\.id[\s\S]*?playSelectedSourceSegment\(segment\)/);
  const segmentClickHandler = sceneTimeline.slice(sceneTimeline.indexOf("data-video-segment-id={segment.id}"), sceneTimeline.indexOf("video-scene-boundary"));
  assert.doesNotMatch(segmentClickHandler, /\.load\(\)|\.play\(\)|\.src\s*=/);
  assert.match(sceneTimeline, /setSelectedSegmentId\(currentSegment\.id\);[\s\S]*?play\(true, 0, currentSegment\.id\)/);
  assert.match(sceneTimeline, /const seek = \(time: number\) => \{[\s\S]*?setSeekRequest\([\s\S]*?relativeTime: Math\.max\(0, next - active\.start\)/);
  assert.match(sceneTimeline, /const play = \(manual:[\s\S]*?videoPlaybackManager\.play\(playbackOwnerId, targetKey/);
});

test("a source scene press matches Master selection and cannot turn into a hold-only limbo", () => {
  const pointerTransaction = sceneTimeline.slice(
    sceneTimeline.indexOf("const beginSegmentDrag ="),
    sceneTimeline.indexOf("const commit ="),
  );
  const beforeFinish = pointerTransaction.slice(0, pointerTransaction.indexOf("const finish ="));
  assert.doesNotMatch(beforeFinish, /controllerRef\.current\?\.pause\(\)|seek\(currentSegment\.start\)/);
  assert.match(beforeFinish, /playSelectedSourceSegment\(currentSegment\)/);
  assert.doesNotMatch(pointerTransaction, /SEGMENT_HOLD_MS|holdTimer|else if \(!drag\.activated\) playSelectedSourceSegment/);
  assert.match(pointerTransaction, /distance >= SEGMENT_DRAG_ACTIVATION_PX/);
  assert.match(sceneTimeline, /playSelectedSourceSegment\(currentSegment\)/);
});

test("source and Master transports share one clip-relative clock contract", () => {
  assert.match(sceneTimeline, /clipStart=\{selectedSegment\.start\}/);
  assert.match(sceneTimeline, /clipEnd=\{selectedSegment\.end\}/);
  assert.match(sceneTimeline, /play\(true, 0, currentSegment\.id\)/);
  assert.match(sceneTimeline, /currentTime - targetSegment\.start/);
  assert.doesNotMatch(sceneTimeline, /relativeTime: Number\.isFinite\(position\)[\s\S]*?video\?\.currentTime/);
});

test("TikTok import publishes selection before collaborative graph hydration", () => {
  const importTransaction = canvasApp.slice(
    canvasApp.indexOf("const focusedImportedNode = videoTimelineNode"),
    canvasApp.indexOf("setProject((current)", canvasApp.indexOf("const focusedImportedNode = videoTimelineNode")),
  );
  assert.ok(importTransaction.indexOf("setSelectedId(focusedImportedNode.id)") < importTransaction.indexOf("commitGraph(selectGraphNode"));
});

test("all foreground video players participate in exclusive playback ownership", () => {
  assert.match(canvasPlayer, /videoPlaybackManager\.register\(ownerId, deckA\)/);
  assert.match(canvasPlayer, /videoPlaybackManager\.register\(ownerId, deckB\)/);
  assert.match(sceneTimeline, /playbackOwnerId=\{playbackOwnerId\}/);
  assert.match(masterPlayer, /videoPlaybackManager\.register\(playbackOwnerId, video\)/);
  assert.match(playbackOwner, /registered\.media !== media\) registered\.media\.pause\(\)/);
});

test("Video Master playhead follows the central transport clock", () => {
  assert.match(playbackOwner, /reportProgress\(ownerId: string, targetKey: string/);
  assert.match(canvasPlayer, /videoPlaybackManager\.reportProgress\(playbackOwnerIdRef\.current, playbackKeyRef\.current, \{[\s\S]*?relativeTime: snapshot\.relativeTime/);
  assert.match(frameNode, /const videoMasterProgress = useSyncExternalStore/);
  assert.match(frameNode, /videoMasterProgress\.targetKey === videoMasterCurrentTargetKey[\s\S]*?videoMasterProgress\.relativeTime/);
  assert.doesNotMatch(segmentedController, /requestVideoFrameCallback/);
  assert.match(segmentedController, /this\.progressTimer = setInterval\(\(\) => \{[\s\S]*?this\.emitProgress\(this\.activeDeckIndex\)/);
});

test("fullscreen editors are manual and canvas hover playback has an immediate local fallback", () => {
  assert.match(canvasPlayer, /hoverFallback: hoverSession !== undefined/);
  assert.match(frameNode, /title="Open Video Master editor" onClick=/);
  assert.match(frameNode, /title="Open source editor" aria-label="Open source editor" onClick=/);
  assert.match(sceneTimeline, /if \(!hoverPlayback\) return;/);
  assert.match(editorViewer, /clickToToggle\s+keyboardActive/);
});

test("an open fullscreen editor owns playback and suppresses its canvas player", () => {
  assert.match(frameNode, /const previewOwnsPlayback = generator\?\.activePreviewNodeId === id;/);
  assert.match(frameNode, /playbackOwnerId=\{videoMasterPlaybackOwnerId\}/);
  assert.match(editorViewer, /const playbackOwnerId = `video-master:\$\{node\.id\}`/);
  assert.match(frameNode, /active=\{Boolean\(selected && !previewOwnsPlayback\)\}/);
  assert.doesNotMatch(frameNode, /key=\{`\$\{selectedClip\.id\}:\$\{videoMasterSelectedLane\}`\}/);
  assert.match(canvasApp, /activePreviewNodeId: previewNode\?\.id \|\| null/);
  assert.match(canvasApp, /openPreview:[\s\S]*?stopAllVideoPlayback\(\);[\s\S]*?setPreviewNode\(node\)/);
});

test("canvas video stages pause and resume from a direct click", () => {
  assert.match(frameNode, /!masterBusy && selectedClip && clipMediaUrl && <button type="button" className="video-master-stage-toggle"[\s\S]*?toggleMasterPlaybackFromStage\(\)/);
  assert.match(frameNode, /const activeCommand = videoPlaybackManager\.getSnapshot\(\)[\s\S]*?const pausing = activeCommand\.action === "play"/);
  assert.match(frameNode, /if \(pausing\) \{[\s\S]*?videoPlaybackManager\.pause\(videoMasterPlaybackOwnerId, targetKey\);[\s\S]*?\} else \{[\s\S]*?videoPlaybackManager\.play\(videoMasterPlaybackOwnerId, targetKey/);
  assert.match(masterPlayer, /videoPlaybackManager\.pause\(playbackOwnerId, playbackKey\)/);
  assert.match(masterPlayer, /videoPlaybackManager\.play\(playbackOwnerId, playbackKey, \{ relativeTime:/);
  assert.doesNotMatch(frameNode, /videoMasterClickPaused|videoMasterHovered/);
  assert.match(masterPlayer, /if \(!clickToToggle \|\| \(event\.target as HTMLElement\)\.closest/);
  assert.doesNotMatch(frameNode, /!wasSelected && selected[\s\S]*?setVideoMasterPlayerSession/);
  assert.match(sceneTimeline, /className="video-scene-stage-toggle"[\s\S]*?togglePlayback\(\)/);
  assert.match(sceneTimeline, /const togglePlayback = \(\) => \{[\s\S]*?if \(!playing\) \{[\s\S]*?currentTime - targetSegment\.start[\s\S]*?play\(true, resumeTime, targetKey\);[\s\S]*?return;[\s\S]*?\}/);
  assert.doesNotMatch(sceneTimeline, /const togglePlayback = \(\) => \{[\s\S]{0,180}?if \(video\.paused\)/);
  assert.match(sceneTimeline, /hoverSuppressedRef\.current \|\| playing/);
  assert.match(sceneTimeline, /onMouseLeave=\{\(\) => \{[\s\S]*?if \(manualPlaybackRef\.current\) return;[\s\S]*?videoPlaybackManager\.pause\(playbackOwnerId/);
  assert.match(sceneTimeline, /manualPlaybackRef\.current = false;[\s\S]*?hoverSuppressedRef\.current = true;[\s\S]*?videoPlaybackManager\.pause\(playbackOwnerId/);
});

test("Video Master assistant and generation overlays cannot leak clicks into playback", () => {
  assert.match(frameNode, /closeAssistantOutside[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?setAssistantOpen\(false\)/);
  assert.match(frameNode, /target\.closest\("button, input, textarea, select, \[role='slider'\], \.generator-prompt-assistant, \.generator-overlay, \.generator-generation-progress, \.video-master-generation-error"\)/);
  assert.match(frameNode, /<span>SCENE PROMPT ASSISTANT<\/span>/);
  assert.doesNotMatch(frameNode, /SCENE PROMPT ASSISTANT · \{selectedClip\.title/);
  assert.match(frameNode, /video-master-generation-progress[\s\S]*?Preparing source video…[\s\S]*?Submitting generation…[\s\S]*?Generation submitted\. Waiting for provider…[\s\S]*?Creating video\. This may take a moment\./);
  assert.match(frameNode, /generator-generation-preview video-master-generation-preview" aria-hidden="true" \/>/);
  assert.doesNotMatch(frameNode, /video-master-generation-preview">[\s\S]{0,180}?videoMasterClipThumbnail/);
  assert.match(frameNode, /preparingMasterClipIds\[id\][\s\S]*?masterHasActiveGeneration/);
  assert.match(frameNode, /masterFailed && <div className="video-master-generation-error" role="alert"/);
  assert.match(frameNode, /runDisabled=\{!selectedClip\.prompt\.trim\(\) \|\| masterHasActiveGeneration/);
  assert.match(canvasApp, /latestNode\.data\.kind === "videoMaster" && !\(await save\(true, true\)\)/);
  assert.match(canvasApp, /targetClipId: generatorNode\.data\.kind === "videoMaster" \? generatorNode\.data\.videoMasterGeneratingClipId : undefined/);
  assert.match(canvasApp, /targetSourceAssetId: preparedMasterSource\?\.assetId \|\| masterSourceTarget\?\.sourceAssetId/);
  assert.match(canvasApp, /materializeVideoSegmentForGeneration\(clip\.sourceNodeId, clip\.sourceSegmentId, Number\(duration\)\)/);
  assert.match(canvasApp, /body: JSON\.stringify\(\{ projectId: project\.id, assetId: sourceAssetId, start: segment\.start, end, segmentId \}\)/);
  assert.match(canvasApp, /model\?\.durationSource === "reference-video" \? \{\} : \{ duration: generatorNode\.data\.duration \|\| "5" \}/);
  assert.match(canvasApp, /generationClipAssetId: generationSourceAsset\?\.id \|\| sourceSegment\.clipAssetId/);
  assert.match(generateRoute, /duration: z\.string\(\)\.regex\(\/\^\\d\+\(\?:\\\.\\d\+\)\?\$\//);
  assert.match(frameNode, /SCENE SOURCE/);
  assert.match(frameNode, /masterOriginalAssistantReference && <button type="button"/);
  assert.match(frameNode, /insertMasterAssistantMention\(masterOriginalAssistantReference\)/);
});

test("Video Master keeps a persistent lazy media pool with exactly one active decoder", () => {
  assert.equal((masterPlayer.match(/<video\b/g) || []).length, 1);
  assert.match(masterPlayer, /const mediaRefs = useRef\(new Map<string, HTMLVideoElement>\(\)\)/);
  assert.match(masterPlayer, /mediaSources\.map\(\(source\) => <video/);
  assert.match(masterPlayer, /data-active-deck=\{transportAttached && source === playbackSource \? "true" : "false"\}/);
  assert.match(masterPlayer, /pausePool\(video\)/);
  assert.match(masterPlayer, /key=\{playbackKey\}|data-playback-key=\{playbackKey\}/);
  assert.match(frameNode, /selectedClip \? <VideoMasterPlayer/);
  assert.match(frameNode, /active=\{Boolean\(selected && !previewOwnsPlayback\)\}/);
  assert.match(frameNode, /preloadSources=\{masterPlaybackSources\}/);
  assert.match(editorViewer, /preloadSources=\{masterPlaybackSources\}/);
  assert.doesNotMatch(frameNode, /<VideoMasterPlayer[\s\S]{0,120}?key=/);
  assert.doesNotMatch(editorViewer, /<VideoMasterPlayer[\s\S]{0,120}?key=/);
  assert.match(masterPlayer, /import \{ editorPlaybackUrl \} from "@\/lib\/editor-media"/);
  assert.match(masterPlayer, /mediaSources = useMemo\(\(\) => Array\.from\(new Set\([\s\S]*?map\(editorPlaybackUrl\)/);
  assert.match(masterPlayer, /src=\{transportAttached && source === playbackSource \? source : undefined\}/);
  assert.match(masterPlayer, /if \(source === playbackSource\) return;[\s\S]*?video\.removeAttribute\("src"\);[\s\S]*?video\.load\(\);[\s\S]*?transportPhase = "released"/);
  assert.match(masterPlayer, /video\.networkState === HTMLMediaElement\.NETWORK_EMPTY[\s\S]*?HTMLMediaElement\.NETWORK_NO_SOURCE[\s\S]*?video\.error\) video\.load\(\)/);
  assert.match(masterPlayer, /preload=\{transportAttached && source === playbackSource \? "metadata" : "none"\}/);
  assert.match(masterPlayer, /const recoverCurrentCommand = \(video: HTMLVideoElement\) =>/);
  assert.match(masterPlayer, /video\.load\(\);\s+runCommand\(live\.id, Number\(live\.relativeTime \|\| 0\)/);
  assert.match(masterPlayer, /onError=\{\(event\) => \{[\s\S]*?recoverCurrentCommand\(event\.currentTarget\)/);
});

test("a Master scene click is consumed by its already mounted media source", () => {
  assert.match(masterPlayer, /const issued = live\.action === "play"[\s\S]*?videoPlaybackManager\.play\(playbackOwnerId, playbackKey, \{ relativeTime \}\)/);
  assert.match(masterPlayer, /if \(commandRef\.current !== issued\.id\) runCommand\(issued\.id, relativeTime\)/);
  assert.match(frameNode, /queueVideoMasterPlay\(clip\.id, lane, safeRelativeTime\)/);
  assert.match(frameNode, /playRequestToken=\{videoMasterPlayRequest\?\.clipId === selectedClip\.id/);
  assert.match(editorViewer, /queuePlay\(clip\.id, lane, safeTime\)/);
  assert.match(editorViewer, /playRequestToken=\{playRequest\?\.clipId === selectedClip\.id/);
  assert.match(frameNode, /if \(playbackSessionKey !== videoMasterPlaybackTargetRef\.current\) return/);
  assert.match(editorViewer, /if \(playbackSessionKey !== playbackTargetRef\.current\) return/);
});

test("one Master boundary advances exactly one scene", () => {
  assert.match(masterPlayer, /const completedCommandRef = useRef<number \| null>\(null\)/);
  assert.match(masterPlayer, /const startedCommandRef = useRef\(0\)/);
  assert.match(masterPlayer, /if \(!video\.paused\) video\.pause\(\)/);
  assert.match(masterPlayer, /startedCommandRef\.current = live\.id/);
  assert.match(masterPlayer, /startedCommandRef\.current !== commandId/);
  assert.match(masterPlayer, /liveCommand\.targetKey !== playbackKeyRef\.current/);
  assert.match(masterPlayer, /if \(completedCommandRef\.current === commandId\) return false/);
  assert.match(masterPlayer, /completedCommandRef\.current = commandId;[\s\S]*?videoPlaybackManager\.complete\(playbackOwnerId, playbackKeyRef\.current\);[\s\S]*?onClipEnded/);
});

test("Master transport follows presented video frames instead of coarse native time updates", () => {
  assert.match(masterPlayer, /const visualClockRef = useRef</);
  assert.match(masterPlayer, /video\.requestVideoFrameCallback\(\(_now, metadata\) => \{/);
  assert.match(masterPlayer, /synchronizeVisualTime\(video, metadata\.mediaTime, commandId\)/);
  assert.match(masterPlayer, /clock\.video\.cancelVideoFrameCallback\(clock\.videoFrame\)/);
  assert.match(masterPlayer, /clock\.animationFrame = requestAnimationFrame/);
  assert.match(masterPlayer, /onTimeUpdate=[\s\S]*?synchronizeVisualTime\(video, video\.currentTime, liveCommand\.id\)/);
});

test("contiguous Master scenes keep one uninterrupted physical media clock", () => {
  assert.match(frameNode, /editorPlaybackUrl\(nextPlaybackMedia\.url\) === editorPlaybackUrl\(selectedPlaybackMedia\.url\)/);
  assert.match(frameNode, /Math\.abs\(selectedPlaybackMedia\.end - nextPlaybackMedia\.start\) <= \.04/);
  assert.match(frameNode, /seamlessNext=\{seamlessNext\}/);
  assert.match(editorViewer, /seamlessNext=\{seamlessNext\}/);
  assert.match(playbackOwner, /continuous\?: boolean/);
  assert.match(frameNode, /continuous: continuousPlayback/);
  assert.match(editorViewer, /continuous: continuousPlayback/);
  assert.match(frameNode, /selectClip\(nextClip, playback === "manual", 0, videoMasterSelectedLane, playback === "manual", seamlessNext\)/);
  assert.match(editorViewer, /selectClip\(nextClip, selectedLane, sequencePlaying \|\| playback === "manual", 0, playback === "manual", seamlessNext\)/);
  assert.match(masterPlayer, /const canContinueCurrentDecoder = liveCommand\.id === commandId[\s\S]*?liveCommand\.continuous === true[\s\S]*?!video\.paused/);
  assert.match(masterPlayer, /if \(canContinueCurrentDecoder\) \{[\s\S]*?startedCommandRef\.current = commandId;[\s\S]*?return;/);
  assert.match(masterPlayer, /if \(!seamlessNext\) \{[\s\S]*?video\.pause\(\);[\s\S]*?videoPlaybackManager\.complete/);
});

test("the Master playhead cannot create a transient scrollbar at the final frame", () => {
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.video-master-playhead-surface \{[^}]*overflow:clip/);
  assert.match(styles, /\.video-master-playhead-surface \{[^}]*top:3px/);
  assert.match(styles, /\.video-master-playhead::before \{[^}]*width:1px[^}]*top:1px/);
  assert.match(styles, /\.video-master-playhead::after \{[^}]*width:6px[^}]*height:6px/);
  assert.match(styles, /\.video-editor-viewer-master-workbench \.video-master-playhead-surface \{ top:6px; \}/);
});

test("source scene boundaries remain draggable without looking like the playhead", () => {
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../src/components/VideoSceneTimeline.tsx", import.meta.url), "utf8");
  assert.match(styles, /\.video-scene-boundary::before \{[^}]*width:2px[^}]*background:rgba\(244,245,241,\.86\)/);
  assert.match(styles, /\.video-scene-boundary::after \{ content:none; \}/);
  assert.match(styles, /\.video-scene-boundary > span \{[^}]*width:16px[^}]*height:22px[^}]*border:0[^}]*background:rgba\(15,16,16,\.9\)/);
  assert.match(timeline, /<ChevronsLeftRight size=\{10\} strokeWidth=\{2\.4\}/);
  assert.match(styles, /\.video-scene-playhead::before \{[^}]*width:6px[^}]*height:6px/);
  assert.doesNotMatch(timeline, /<span>\{String\(Number\(segment\.sequenceIndex \?\? index\) \+ 1\)\.padStart\(2, "0"\)\}<\/span>/);
});

test("source timelines can restore the immutable detected scene cuts", () => {
  assert.match(canvasApp, /videoDetectedSegments: videoSegments\.length \? videoSegments\.map\(\(segment\) => \(\{ \.\.\.segment \}\)\)/);
  assert.match(frameNode, /segments=\{data\.videoSegments\}[\s\S]*?detectedSegments=\{data\.videoDetectedSegments\}/);
  assert.match(sceneTimeline, /restoreDetectedVideoSegments\(localSegments, duration, detectedSegments\)/);
  assert.match(sceneTimeline, /!resetSegments\.some\(\(segment\) => segment\.id === outputSelection\)\) onOutputSelectionChange\("full"\)/);
  assert.match(sceneTimeline, /title="Restore automatically detected scenes"[\s\S]*?Reset cuts/);
});

test("a cold fullscreen scene explicitly wakes its target deck", () => {
  assert.match(masterPlayer, /video\.networkState === HTMLMediaElement\.NETWORK_EMPTY[\s\S]*?video\.load\(\)/);
});

test("a completed Master deck seeks before replaying another scene", () => {
  assert.match(masterPlayer, /video\.currentTime = seekTarget;[\s\S]*?video\.addEventListener\("seeked", finish/);
  assert.match(masterPlayer, /await new Promise<void>[\s\S]*?if \(!stillCurrent\(\)\) return;[\s\S]*?await video\.play\(\)/);
});

test("Video Master export uses complete click activation", () => {
  assert.match(frameNode, /aria-label="Export Video Master"[^>]*?onPointerDown=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}\}[^>]*?onClick=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); toggleMasterDownload\(\); \}\}/);
  assert.match(frameNode, /className="video-master-export-submit"[^>]*?onPointerDown=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}\}[^>]*?onClick=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); void downloadMaster\(\); \}\}/);
  assert.doesNotMatch(frameNode, /videoMasterExportPointerRef|activateMasterExport|completeMasterExportClick/);
  assert.match(frameNode, /className="generator-node-toolbar video-master-node-toolbar nodrag nopan" onDoubleClick=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}\}/);
  assert.match(frameNode, /className=\{`video-master-download-control[\s\S]*?onDoubleClick=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}\}/);
});

test("Video Master export authorizes referenced assets instead of requiring current-canvas ownership", () => {
  assert.match(assetExportRoute, /userCanAccessAsset\(auth\.user\.id, row\.id\)/);
  assert.doesNotMatch(assetExportRoute, /WHERE id = \? AND project_id = \?/);
});

test("leaving Master keeps the selected scene visible on its timeline", () => {
  assert.match(frameNode, /selectedClipId=\{selectedClip\?\.id\}/);
  assert.doesNotMatch(frameNode, /selectedClipId=\{selected \? selectedClip\?\.id : undefined\}/);
  assert.match(frameNode, /selectedClip \? <VideoMasterPlayer/);
  assert.doesNotMatch(frameNode, /selectedClip && selected && !previewOwnsPlayback \? <VideoMasterPlayer/);
});

test("a draggable Master clip selects on the first pointer press", () => {
  const clipButton = frameNode.slice(frameNode.indexOf("const clipButton ="), frameNode.indexOf("return <div className=\"video-master-timeline"));
  assert.doesNotMatch(clipButton, /onPointerDownCapture/);
  assert.match(clipButton, /onPointerDown=\{\(event\) => \{[\s\S]*?event\.button !== 0[\s\S]*?event\.preventDefault\(\);[\s\S]*?onSelect\(clip, lane\)/);
  assert.match(clipButton, /onClick=\{\(event\) => \{[\s\S]*?if \(event\.detail === 0\) onSelect\(clip, lane\)/);
});

test("source playback has exactly one media clock follower across rapid scene switches", () => {
  assert.match(sceneTimeline, /<VideoMasterPlayer/);
  assert.doesNotMatch(sceneTimeline, /SegmentedVideoController|onProgress: \(snapshot\)/);
  assert.match(masterPlayer, /videoPlaybackManager\.reportProgress\(playbackOwnerId, playbackKeyRef\.current/);
  assert.doesNotMatch(sceneTimeline, /requestVideoFrameCallback/);
  assert.match(masterPlayer, /requestVideoFrameCallback/);
});

test("uploaded master clips persist a thumbnail and video assets can generate one", () => {
  assert.match(canvasApp, /thumbnailUrl: assetThumbnailUrl\(asset\.url\)/);
  assert.match(assetRoute, /createVideoAssetThumbnailFromStorage/);
});

test("Video Master assistant reuses the selected timeline thumbnail in a compact ratio-aware tile", () => {
  assert.match(canvasApp, /const authoritativeSegmentId = ownsSelectedMasterSource \? masterClip\?\.sourceSegmentId : edge\.data\?\.sourceSegmentId/);
  assert.match(canvasApp, /const sourceSegment = authoritativeSegmentId[\s\S]*?node\.data\.videoSegments\?\.find/);
  assert.match(canvasApp, /const ownsSelectedMasterSource = Boolean\(masterClip/);
  assert.match(canvasApp, /sourceSegment\?\.clipUrl \|\| masterClip\?\.sourceClipUrl \|\| sourceMediaUrl/);
  assert.match(canvasApp, /const timelineThumbnailUrl = ownsSelectedMasterSource\s*\? videoMasterClipThumbnail\(masterClip, "original"\)/);
  assert.match(canvasApp, /thumbnailUrl: timelineThumbnailUrl/);
  assert.match(canvasApp, /thumbnailUrl: videoMasterClipThumbnail\(masterClip, "original"\)/);
  assert.doesNotMatch(canvasApp, /representativeTime/);
  assert.match(assetRoute, /videoAssetThumbnailAtTime\(row, requestedThumbnailTime\)/);
  assert.match(frameNode, /generator-assistant-reference-strip is-compact/);
  assert.match(frameNode, /loading="eager"/);
  assert.match(frameNode, /document\.addEventListener\("keydown", closeAssistantWithEscape\)/);
  assert.match(frameNode, /document\.addEventListener\("pointerdown", closeAssistantOutside, true\)/);
  assert.match(frameNode, /<GeneratorReferencePreview reference=\{reference\} compact \/>/);
  assert.match(frameNode, /style=\{\{ aspectRatio: ratio \} as CSSProperties\}/);
  const compactPreview = frameNode.slice(frameNode.indexOf("if (compact)"), frameNode.indexOf("if (reference.role === \"reference-video\""));
  assert.doesNotMatch(compactPreview, /<Video/);
});

test("uploaded master clips use measured media duration and repair legacy provisional durations", () => {
  assert.match(assetUploadRoute, /probeVideoMetadata\(bytes, extension\)/);
  assert.match(assetUploadRoute, /durationSeconds/);
  assert.match(mediaProbe, /stream=width,height/);
  assert.match(canvasApp, /const duration = Math\.max\(\.1, Number\(asset\.durationSeconds/);
  assert.match(canvasApp, /sourceAspectRatio/);
  assert.match(canvasPlayer, /callbacksRef\.current\.onMediaDuration\?\.\(duration\)/);
  assert.match(frameNode, /reconciledVideoMasterClipDuration\(selectedClip, selectedPlaybackMedia, duration\)/);
  assert.match(frameNode, /generator\.saveNow\(id, \{[\s\S]*?duration: String\(reconciledDuration\)/);
  assert.match(canvasApp, /const save = useCallback\(async \(quiet = false, force = false\)/);
  assert.match(canvasApp, /if \(!force && savedProjectSignatures\.current\[project\.id\] === signature\) return true/);
  assert.match(canvasApp, /saveNow: \(nodeId, data\) => \{[\s\S]*?nodesRef\.current = next;[\s\S]*?window\.setTimeout\(\(\) => void save\(true, true\), 0\);/);
  assert.match(canvasApp, /function updateNode[\s\S]*?const next = nodesRef\.current\.map[\s\S]*?nodesRef\.current = next;[\s\S]*?setNodes\(next\);/);
  assert.match(editorViewer, /reconciledVideoMasterClipDuration\(selectedClip, selectedMedia, duration\)/);
});

test("generated Video Master clips follow their physical provider duration", () => {
  const generationState = readFileSync(new URL("../src/lib/generation-state.ts", import.meta.url), "utf8");
  assert.match(generationState, /optimizeMp4ForStreaming\(bytes\)/);
  assert.match(frameNode, /reconciledVideoMasterGeneratedDuration\(selectedClip, selectedPlaybackMedia, duration\)/);
  assert.match(frameNode, /generatedDuration: reconciledGeneratedDuration/);
  assert.match(editorViewer, /reconciledVideoMasterGeneratedDuration\(selectedClip, selectedMedia, duration\)/);
  assert.match(canvasApp, /pollBody\.generation\.durationSeconds/);
});

test("Video Master exposes saved outputs per scene and across the whole node", () => {
  assert.match(frameNode, /masterOutputEntries = clips\.flatMap[\s\S]*?videoMasterGeneratedOutputs\(clip\)/);
  assert.match(frameNode, /sourceLane === "output" && targetLane === "output"[\s\S]*?onCopyOutput\(sourceClip, targetClipId\)/);
  assert.match(frameNode, /onCopyOutput=\{\(sourceClip, targetClipId\) => \{[\s\S]*?applyMasterOutput\(targetClipId, output\)/);
  assert.match(frameNode, /videoMasterOutputFilter === "all"[\s\S]*?masterOutputEntries[\s\S]*?entry\.clip\.id === selectedClip\?\.id/);
  assert.match(frameNode, /MASTER OUTPUTS/);
  assert.match(frameNode, />ALL<b>\{masterOutputEntries\.length\}<\/b>/);
  assert.match(frameNode, /applyMasterOutput\(targetClip\.id, output\)/);
  assert.match(frameNode, /generator\.saveNow\(id, \{[\s\S]*?videoMasterClips: nextClips/);
});

test("image generators run independently and preserve every saved output", () => {
  assert.doesNotMatch(canvasApp, /!generatorNode \|\| !effectivePrompt \|\| generating \|\| activeGenerationNodeIds/);
  assert.match(canvasApp, /!generatorNode \|\| !effectivePrompt \|\| activeGenerationNodeIds\.includes\(generatorNode\.id\)/);
  assert.match(canvasApp, /completedOutputsByNode/);
  assert.match(canvasApp, /const activeOutputIndex = outputHistory\.findIndex\(\(item\) => item\.url === output\.url\)/);
  assert.match(canvasApp, /generatedOutputs: outputHistory,[\s\S]*?activeGeneratedOutputIndex: activeOutputIndex >= 0 \? activeOutputIndex : outputHistory\.length - 1/);
  assert.doesNotMatch(canvasApp, /node\.id === generatorNode\.id[\s\S]{0,260}?generatedOutputs: \[\]/);
  assert.match(frameNode, /generatedOutputs\.length > 0 && <div className=\{`generator-output-history/);
});

test("the fullscreen Video Master keeps node actions, scene references and output switching", () => {
  assert.match(editorViewer, /video-editor-viewer-node-toolbar/);
  assert.match(editorViewer, /onGenerateClip\?\.\(selectedClip\.id\)/);
  assert.match(editorViewer, /referencesForClip\(selectedClip\.id\)/);
  assert.match(editorViewer, /generator-reference-menu video-editor-viewer-reference-menu/);
  assert.match(editorViewer, /<label>INPUTS<\/label>/);
  assert.match(editorViewer, /masterClipOriginalReference\(selectedClip\)/);
  assert.match(editorViewer, /const displayReferences = originalSceneReference \? selectedReferences\.filter/);
  assert.match(editorViewer, /\[\{ \.\.\.originalSceneReference, mediaType: "video", removable: false \}, \.\.\.displayReferences\]/);
  assert.match(editorViewer, /Scene source/);
  assert.match(editorViewer, /Video reference/);
  assert.match(editorViewer, /IDENTITY LIBRARY/);
  assert.match(editorViewer, /referenceMenuPortId/);
  assert.match(editorViewer, /videoMasterGeneratedOutputs\(clip\)/);
  assert.match(editorViewer, /outputScope === "all"/);
  assert.match(editorViewer, /applyVideoMasterGeneratedOutput\(clips, targetClipId, output\)/);
  assert.match(canvasApp, /masterReferences=\{\(clipId\) => nodeReferencePreviews\(previewNode\.id, clipId\)/);
  assert.match(canvasApp, /masterReferenceLibrary=\{videoEditorReferenceLibrary\}/);
  assert.match(canvasApp, /personas=\{personas\}/);
});

test("saved image outputs hydrate quietly without replaying the generation overlay", () => {
  assert.match(frameNode, /const activeGeneration = busy \|\| queued/);
  assert.match(frameNode, /className="generator-output-image"[^>]+loading="eager"[^>]+fetchPriority=\{selected \? "high" : "auto"\}/);
  assert.match(frameNode, /onLoad=\{outputIsLoaded \? undefined : markOutputLoaded\}/);
  assert.doesNotMatch(frameNode, /generator-output-preload/);
  assert.doesNotMatch(frameNode, /generatingLabel="Loading final image…"/);
  assert.doesNotMatch(frameNode, /outputIsLoaded[^\n]+"is-generating"/);
});

test("image generation lifecycle always dismisses stale prompt focus", () => {
  assert.match(frameNode, /const promptGenerationActive = data\.kind === "prompt"[\s\S]*?data\.status === "queued"[\s\S]*?data\.status === "working"/);
  assert.match(frameNode, /const completedWithNewOutput = data\.kind === "prompt"[\s\S]*?data\.status === "ready"[\s\S]*?previousPromptGenerationResultKeyRef\.current !== promptGenerationResultKey/);
  assert.match(frameNode, /if \(!promptGenerationActive && !completedWithNewOutput\) return;[\s\S]*?setPromptFocused\(false\);[\s\S]*?setReferenceMention\(null\);/);
});

test("Video Master node and fullscreen editor share the same generation controls", () => {
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(frameNode, /export function VideoMasterGenerationControls/);
  assert.match(frameNode, /<VideoMasterGenerationControls clipId=\{selectedClip\.id\}/);
  assert.match(editorViewer, /<VideoMasterGenerationControls/);
  assert.doesNotMatch(editorViewer, /video-editor-viewer-generator-controls/);
  assert.doesNotMatch(editorViewer, /<select aria-label="Video model"/);
  assert.doesNotMatch(styles, /\.video-editor-viewer-generator-controls/);
});

test("generator menus use native scrolling without cancelling passive wheel events", () => {
  const imageEditPicker = readFileSync(new URL("../src/components/ImageEditReferencePicker.tsx", import.meta.url), "utf8");
  assert.match(frameNode, /generator-select-scroll nowheel[^>]+onWheelCapture=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.doesNotMatch(frameNode, /generator-select-scroll[^\n]+preventDefault/);
  assert.doesNotMatch(frameNode, /generator-reference-scroll[^\n]+preventDefault/);
  assert.doesNotMatch(editorViewer, /generator-reference-scroll[^\n]+preventDefault/);
  assert.doesNotMatch(imageEditPicker, /media-edit-reference-body[^\n]+preventDefault/);
});

test("switching generator models preserves the selected format when it is supported", () => {
  assert.match(frameNode, /export function generatorSettingsForModel/);
  assert.match(frameNode, /compatibleResolution = resolutions\.find[\s\S]*?includes\(currentRatio\)/);
  assert.match(frameNode, /aspectRatio = currentRatio && ratios\.includes\(currentRatio\)/);
  assert.match(frameNode, /const next = generatorSettingsForModel\(model, \{ aspectRatio: data\.aspectRatio/);
  assert.match(canvasApp, /const next = generatorSettingsForModel\(nextModel, \{ aspectRatio: selectedNode\.data\.aspectRatio/);
  assert.doesNotMatch(frameNode, /onChange=\{\(value\) => \{ const model = generator\.models[\s\S]{0,260}?aspectRatio: \(model\?\.defaultRatio/);
});

test("legacy source videos keep a poster, blur and filmstrip preview without saved scene thumbnails", () => {
  assert.match(sceneTimeline, /const sourcePosterUrl = src\.startsWith\("\/api\/assets\/"\) \? thumbnailAssetUrl\(src\) : ""/);
  assert.match(sceneTimeline, /selectedSegment\?\.thumbnailUrl \|\| segments\[0\]\?\.thumbnailUrl \|\| sourcePosterUrl/);
  assert.match(sceneTimeline, /const previewUrl = sample\?\.url \|\| sourcePosterUrl/);
  assert.match(sceneTimeline, /backdropUrl=\{stageBackdrop \? thumbnailAssetUrl\(stageBackdrop\) : undefined\}/);
});

test("dense timeline sprites stay readable at overview zoom and reveal detail progressively", () => {
  assert.match(sceneTimeline, /const overviewFilmstripFrameCount = Math\.max\(12, Math\.min\(30, Math\.ceil\(duration \* 1\.5\)\)\)/);
  assert.match(sceneTimeline, /Math\.min\(Math\.max\(1, timelineSprite\.frameCount\), Math\.max\(1, Math\.ceil\(overviewFilmstripFrameCount \* timelineZoom\)\)\)/);
  assert.match(sceneTimeline, /Math\.round\(index \/ \(filmstripFrameCount - 1\) \* \(sourceFrameCount - 1\)\)/);
  assert.doesNotMatch(sceneTimeline, /const filmstripFrameCount = timelineSprite \? Math\.max\(1, timelineSprite\.frameCount\)/);
});

test("source editor captures a durable still instead of exposing redundant scene actions", () => {
  const frameRoute = readFileSync(new URL("../src/app/api/assets/frame/route.ts", import.meta.url), "utf8");
  assert.match(sceneTimeline, /aria-busy=\{capturingFrame\}[\s\S]*?<Camera size=\{12\} \/>Screenshot<\/button>/);
  assert.doesNotMatch(sceneTimeline, /Saving…/);
  assert.match(sceneTimeline, /await onCaptureFrame\(time\)/);
  assert.doesNotMatch(sceneTimeline, />Merge<\/button>/);
  assert.match(sceneTimeline, /aria-label="Choose Video Master input"/);
  assert.match(sceneTimeline, /\{ value: "full", label: "Full video", detail: preciseTime\(duration\) \}/);
  assert.match(sceneTimeline, /onOutputSelectionChange\(option\.value\); setOutputMenuOpen\(false\)/);
  assert.match(canvasApp, /const clips: VideoMasterClip\[\] = sourceSegments\.map/);
  assert.match(canvasApp, /const focusedSegmentId = requestedSegment\?\.id/);
  assert.doesNotMatch(canvasApp, /\[requestedSegment\] : sourceSegments/);
  assert.match(frameNode, /segment: outputSegment, intent: "video-master"/);
  assert.doesNotMatch(sceneTimeline, />Replace scene<\/button>/);
  assert.match(canvasApp, /fetch\("\/api\/assets\/frame"/);
  assert.match(canvasApp, /canvasMediaOrigin: "capture"/);
  assert.match(canvasApp, /y: sourceNode\.position\.y \+ sourceHeight \+ 64/);
  assert.match(frameNode, /closest\("button,input,\[role=slider\]"\)\) return;\s*generator\?\.selectNode\(id\)/);
  assert.match(frameRoute, /await readStorageObject\(source\.storage_path\)/);
  assert.match(frameRoute, /"-frames:v", "1"/);
  assert.match(frameRoute, /await saveBytes\(/);
  assert.match(frameRoute, /'video_frame', 'reference'/);
  assert.match(frameRoute, /userCanAccessAsset\(auth\.user\.id, source\.id\)/);
  assert.match(frameRoute, /`workspaces\/\$\{workspaceId\}\/projects\/\$\{projectId\}\/video-frames`/);
  assert.doesNotMatch(frameRoute, /WHERE id = \? AND project_id = \?/);
});
