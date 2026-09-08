import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { GenerationOutline } from "../../../src/components/ui/GenerationOutline";
import { ImageGeneration } from "../../../src/components/ui/ai-chat-image-generation-1";
import { VideoMasterPlayer } from "../../../src/components/VideoMasterPlayer";
import { videoPlaybackManager } from "../../../src/lib/video-playback-owner";

function Fixture() {
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const command = useSyncExternalStore(videoPlaybackManager.subscribe, videoPlaybackManager.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(0);
  return <>
    <button onClick={() => setBusy((value) => !value)}>Toggle generation</button>
    <button onClick={() => videoPlaybackManager.play("other-node", "other-scene")}>Play other node</button>
    <output aria-label="Playback owner">{command.ownerId}:{command.action}</output>
    <div className={`stage ${busy ? "is-generating" : ""}`}>
      <VideoMasterPlayer controlsPortal={controlsHost} src="https://fixture.test/playback.mp4" active suspended={busy} playbackOwnerId="master" playbackKey="scene:output" clipEnd={8} externalCurrentTime={time} externalDuration={8} onExternalSeek={() => {}} onTimeChange={setTime} />
      <GenerationOutline radius={2} />
      <ImageGeneration><div className="generator-generation-preview" /></ImageGeneration>
    </div>
    <div ref={setControlsHost} />
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
