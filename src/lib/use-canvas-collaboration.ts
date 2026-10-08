"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { CANVAS_CLIENT_VERSION } from "../../collaboration/client-version.mjs";
import { isLocalCanvasOrigin, patchGraphInYDoc, readGraphFromYDoc } from "./collaboration-document";
import type { ProjectGraph, UserRecord } from "./types";

export type CanvasCollaborationStatus = "connecting" | "synced" | "offline" | "error";
export type CanvasCollaborator = { clientId: number; userId: string; name: string; color: string };

function collaborationWebsocketUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_COLLABORATION_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, "");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/collaboration`;
}

type CollaborationSession = { projectId: string; token: string; documentEpoch: number };

async function fetchToken(projectId: string, signal?: AbortSignal): Promise<CollaborationSession> {
  const response = await fetch("/api/collaboration/token", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, clientVersion: CANVAS_CLIENT_VERSION }),
  });
  const body = await response.json().catch(() => ({})) as { token?: string; documentEpoch?: number; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error || "Could not authorize collaboration");
  return { projectId, token: body.token, documentEpoch: Math.max(1, Number(body.documentEpoch || 1)) };
}

function collaboratorColor(userId: string) {
  const colors = ["#6fdbb5", "#75a7ff", "#efb663", "#db8cff", "#ff7d8d", "#70cedb"];
  let hash = 0;
  for (const character of userId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

export function useCanvasCollaboration(input: {
  projectId: string;
  user: UserRecord;
  onRemoteGraph: (graph: ProjectGraph) => void;
}) {
  const [connection, setConnection] = useState<{ projectId: string; status: CanvasCollaborationStatus }>({
    projectId: input.projectId,
    status: "connecting",
  });
  const [syncedProjectId, setSyncedProjectId] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<CanvasCollaborator[]>([]);
  const [collaboratorsProjectId, setCollaboratorsProjectId] = useState<string | null>(null);
  const [peerConnection, setPeerConnection] = useState({ projectId: input.projectId, count: 0 });
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState<{ projectId: string; message: string } | null>(null);
  const retry = useCallback(() => {
    if (syncedProjectIdRef.current === input.projectId) return;
    setSession(null);
    setProblem(null);
    setConnection({ projectId: input.projectId, status: "connecting" });
    setAttempt(value => value + 1);
  }, [input.projectId]);
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const documentRef = useRef<Y.Doc | null>(null);
  const syncedProjectIdRef = useRef<string | null>(null);
  const remoteCallbackRef = useRef(input.onRemoteGraph);

  useEffect(() => {
    remoteCallbackRef.current = input.onRemoteGraph;
  }, [input.onRemoteGraph]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 15000);
    void fetchToken(input.projectId, controller.signal).then((next) => {
      if (!cancelled) setSession(next);
    }).catch(() => {
      if (!cancelled) {
        setConnection({ projectId: input.projectId, status: "error" });
        setProblem({ projectId: input.projectId, message: "Could not connect to this canvas. Your saved project is safe. Try again." });
      }
    }).finally(() => window.clearTimeout(deadline));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(deadline); };
  }, [input.projectId, attempt]);

  useEffect(() => {
    if (syncedProjectId === input.projectId) return;
    const timeout = window.setTimeout(() => setProblem({ projectId: input.projectId, message: "This canvas is taking longer to connect. Try again or open another section." }), 15000);
    return () => window.clearTimeout(timeout);
  }, [input.projectId, syncedProjectId, attempt]);

  useEffect(() => {
    if (!session || session.projectId !== input.projectId) return;
    const document = new Y.Doc();
    documentRef.current = document;
    let destroyed = false;
    let remoteScheduled = false;
    let initialSyncComplete = false;
    const applyRemote = () => {
      if (destroyed || remoteScheduled || !initialSyncComplete) return;
      remoteScheduled = true;
      queueMicrotask(() => {
        remoteScheduled = false;
        if (!destroyed) remoteCallbackRef.current(readGraphFromYDoc(document));
      });
    };
    let initialToken: string | null = session.token;
    const provider = new HocuspocusProvider({
      url: collaborationWebsocketUrl(),
      name: input.projectId,
      document,
      token: async () => {
        if (initialToken) {
          const token = initialToken;
          initialToken = null;
          return token;
        }
        const refreshed = await fetchToken(input.projectId);
        if (refreshed.documentEpoch !== session.documentEpoch) {
          if (!destroyed) setSession(refreshed);
          throw new Error("Canvas checkpoint changed");
        }
        return refreshed.token;
      },
      flushDelay: 60,
      onSynced: () => {
        if (destroyed) return;
        initialSyncComplete = true;
        setProblem(null);
        syncedProjectIdRef.current = input.projectId;
        setSyncedProjectId(input.projectId);
        setConnection({ projectId: input.projectId, status: "synced" });
        applyRemote();
      },
      onStatus: ({ status: nextStatus }) => {
        if (destroyed || nextStatus === "connected") return;
        setConnection({ projectId: input.projectId, status: nextStatus === "disconnected" ? "offline" : "connecting" });
      },
      onAuthenticationFailed: () => {
        if (!destroyed) { setConnection({ projectId: input.projectId, status: "error" }); setProblem({ projectId: input.projectId, message: "Canvas access could not be verified. Try again." }); }
      },
      onAwarenessChange: ({ states }) => {
        if (destroyed) return;
        setCollaboratorsProjectId(input.projectId);
        setPeerConnection({ projectId: input.projectId, count: states.filter((state) => Number(state.clientId) !== document.clientID).length });
        setCollaborators(states
          .map((state): { clientId: number; userId?: unknown; name?: unknown; color?: unknown } => ({ clientId: Number(state.clientId), ...(state.user as Record<string, unknown>) }))
          .filter((state) => state.userId && state.userId !== input.user.id)
          .map((state) => ({ clientId: state.clientId, userId: String(state.userId), name: String(state.name || "Teammate"), color: String(state.color || "#6fdbb5") })));
      },
    });
    providerRef.current = provider;
    provider.setAwarenessField("user", {
      userId: input.user.id,
      name: input.user.name || input.user.email.split("@")[0],
      color: collaboratorColor(input.user.id),
    });
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (!isLocalCanvasOrigin(origin)) applyRemote();
    };
    document.on("update", onUpdate);
    return () => {
      destroyed = true;
      document.off("update", onUpdate);
      provider.destroy();
      document.destroy();
      if (providerRef.current === provider) providerRef.current = null;
      if (documentRef.current === document) documentRef.current = null;
      if (syncedProjectIdRef.current === input.projectId) syncedProjectIdRef.current = null;
    };
  }, [input.projectId, input.user.email, input.user.id, input.user.name, session]);

  const mutate = useCallback((before: ProjectGraph, after: ProjectGraph) => {
    const document = documentRef.current;
    const provider = providerRef.current;
    if (!document || !provider || syncedProjectIdRef.current !== input.projectId) return false;
    patchGraphInYDoc(document, before, after);
    provider.flushPendingUpdates();
    return true;
  }, [input.projectId]);

  const flush = useCallback(async (waitForAck = false) => {
    const provider = providerRef.current;
    if (!provider || syncedProjectIdRef.current !== input.projectId) return false;
    const activeProvider = provider;
    activeProvider.flushPendingUpdates();
    if (!waitForAck || !activeProvider.hasUnsyncedChanges) return true;
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(done, 5000);
      function done() {
        window.clearTimeout(timeout);
        activeProvider.off("unsyncedChanges", onUnsynced);
        resolve();
      }
      function onUnsynced({ number }: { number: number }) { if (number === 0) done(); }
      activeProvider.on("unsyncedChanges", onUnsynced);
    });
    return !activeProvider.hasUnsyncedChanges;
  }, [input.projectId]);

  const ready = syncedProjectId === input.projectId;
  const status = connection.projectId === input.projectId ? connection.status : "connecting";
  return {
    status,
    ready,
    error: !ready && problem?.projectId === input.projectId ? problem.message : null,
    retry,
    collaborators: ready && collaboratorsProjectId === input.projectId ? collaborators : [],
    peerCount: ready && peerConnection.projectId === input.projectId ? peerConnection.count : 0,
    mutate,
    flush,
  };
}
