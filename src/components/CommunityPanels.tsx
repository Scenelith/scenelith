"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Headphones,
  Inbox,
  Lightbulb,
  LoaderCircle,
  Megaphone,
  MessageSquareText,
  Plus,
  Search,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import type { BackgroundTaskRecord, FeatureRequestRecord, NotificationRecord, SupportTicketRecord, UserRecord, WorkspaceRecord } from "@/lib/types";
import { TeamPanel } from "./TeamPanel";

export type CommunityPanelKind = "support" | "features" | "admin" | "team";

type PanelFocus = { kind: CommunityPanelKind; id?: string; nonce: number } | null;

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function PanelShell({ eyebrow, title, description, onClose, children }: { eyebrow: string; title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  return <section className="community-library" aria-label={title}>
    <header className="hook-page-head community-library-head">
      <div className="hook-page-title"><p className="eyebrow">{eyebrow}</p><div><h1>{title}</h1><span>{description}</span></div></div>
      <button className="hook-page-close" type="button" onClick={onClose} title="Back to canvas" aria-label={`Close ${title}`}><X size={18} /></button>
    </header>
    <div className="community-library-body">{children}</div>
  </section>;
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="community-empty">{icon}<strong>{title}</strong><p>{body}</p></div>;
}

const featureStatusLabels: Record<FeatureRequestRecord["status"], string> = {
  pending: "In review",
  approved: "Open for voting",
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Completed",
  rejected: "Declined",
};

const featureStatusOptions: Array<CommunitySelectOption<FeatureRequestRecord["status"]>> = [
  { value: "pending", label: featureStatusLabels.pending },
  { value: "approved", label: featureStatusLabels.approved },
  { value: "planned", label: featureStatusLabels.planned },
  { value: "in_progress", label: featureStatusLabels.in_progress },
  { value: "shipped", label: featureStatusLabels.shipped },
  { value: "rejected", label: featureStatusLabels.rejected },
];

type CommunitySelectOption<T extends string> = { value: T; label: string };

function CommunitySelect<T extends string>({ value, options, ariaLabel, disabled = false, onChange }: { value: T; options: Array<CommunitySelectOption<T>>; ariaLabel: string; disabled?: boolean; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className={`community-select ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="community-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}><span>{selected?.label}</span><ChevronDown size={14} /></button>
    {open && <div className="community-select-menu" role="listbox" aria-label={ariaLabel}>{options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "is-selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <Check size={12} />}</button>)}</div>}
  </div>;
}

export function NotificationBell({ onNavigate }: { onNavigate: (kind: CommunityPanelKind, id?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await jsonRequest<{ notifications: NotificationRecord[]; unreadCount: number }>("/api/notifications");
      setItems(body.notifications);
      setUnreadCount(body.unreadCount);
    } catch {}
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("scenelith:notifications-changed", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("scenelith:notifications-changed", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const openNotification = async (notification: NotificationRecord) => {
    if (!notification.isRead) {
      try {
        const body = await jsonRequest<{ notifications: NotificationRecord[]; unreadCount: number }>(`/api/notifications/${notification.id}`, { method: "PATCH", body: "{}" });
        setItems(body.notifications);
        setUnreadCount(body.unreadCount);
      } catch {}
    }
    if (notification.actionType) onNavigate(notification.actionType, notification.actionId || undefined);
    setOpen(false);
  };

  const markAllRead = async () => {
    const body = await jsonRequest<{ notifications: NotificationRecord[]; unreadCount: number }>("/api/notifications", { method: "PATCH", body: "{}" });
    setItems(body.notifications);
    setUnreadCount(body.unreadCount);
  };

  return <div className={`notification-center ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="notification-trigger" aria-label={`${unreadCount} unread notifications`} onClick={() => { setOpen((value) => !value); if (!open) void refresh(); }}>
      <Bell size={16} />{unreadCount > 0 && <b>{unreadCount > 9 ? "9+" : unreadCount}</b>}
    </button>
    {open && <div className="notification-popover">
      <header><span><small>ACTIVITY</small><strong>Notifications</strong></span>{unreadCount > 0 && <button type="button" onClick={() => void markAllRead()}><CheckCheck size={12} />Mark all read</button>}</header>
      <div className="notification-list">
        {items.map((item) => <button type="button" key={item.id} className={item.isRead ? "is-read" : "is-unread"} onClick={() => void openNotification(item)}>
          <span className={`notification-kind is-${item.kind}`}>{item.kind === "announcement" ? <Megaphone size={13} /> : item.kind.startsWith("feature") ? <Lightbulb size={13} /> : <MessageSquareText size={13} />}</span>
          <span><strong>{item.title}</strong><p>{item.body}</p><small>{relativeTime(item.createdAt)}{item.recipientUserId ? " · for you" : " · everyone"}</small></span>
          {!item.isRead && <i />}
        </button>)}
        {!items.length && <EmptyState icon={<Bell size={22} />} title="Nothing new" body="Replies, roadmap updates and announcements will appear here." />}
      </div>
    </div>}
  </div>;
}

export function TaskCenter({ onNavigate }: { onNavigate: (task: BackgroundTaskRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BackgroundTaskRecord[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await jsonRequest<{ tasks: BackgroundTaskRecord[]; activeCount: number }>("/api/tasks");
      setItems(body.tasks);
      setActiveCount(body.activeCount);
      window.dispatchEvent(new CustomEvent("scenelith:tasks-updated", { detail: body }));
    } catch {}
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), activeCount > 0 ? 5_000 : 20_000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("scenelith:tasks-changed", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("scenelith:tasks-changed", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeCount, refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);

  const activeItems = items.filter((item) => item.status === "queued" || item.status === "running");
  const recentItems = items.filter((item) => item.status === "completed" || item.status === "failed").slice(0, 6);
  const visibleItems = [...activeItems, ...recentItems];
  const renderTask = (item: BackgroundTaskRecord) => {
    const active = item.status === "queued" || item.status === "running";
    const progress = Math.max(0, Math.min(100, item.progress));
    const detail = item.status === "failed" ? item.error || "This task stopped before it finished." : item.stageLabel;
    const stateLabel = item.status === "queued" ? "Queued" : item.status === "running" ? `${Math.round(progress)}%` : item.status === "completed" ? "Done" : "Failed";
    return <button type="button" key={`${item.kind}-${item.id}`} className={`task-row is-${item.status}`} onClick={() => { onNavigate(item); setOpen(false); }}>
      <span className="task-copy">
        <strong>{item.title}</strong>
        <span className="task-meta"><small>{item.projectName}</small><i aria-hidden="true" /><small>{relativeTime(item.updatedAt)}</small></span>
        <p className={item.status === "failed" ? "task-error" : undefined}>{detail}</p>
        {active && <span className="task-progress" role="progressbar" aria-label={`${Math.round(progress)}% complete`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{ transform: `scaleX(${progress / 100})` }} /></span>}
      </span>
      <span className={`task-state is-${item.status}`}><b>{stateLabel}</b></span>
    </button>;
  };

  return <div className={`task-center ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="task-trigger" aria-label={`${activeCount} active tasks`} aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) void refresh(); }}>
      <span>Tasks</span>{activeCount > 0 && <b>{activeCount > 9 ? "9+" : activeCount}</b>}
    </button>
    {open && <div className="task-popover">
      <header><strong>Tasks</strong><small>{activeCount > 0 ? `${activeCount} active` : `${recentItems.length} recent`}</small></header>
      <div className="task-list">
        {visibleItems.map(renderTask)}
        {!items.length && <div className="task-empty"><strong>No background tasks</strong><span>Generations and automations will appear here.</span></div>}
      </div>
    </div>}
  </div>;
}

function TicketThread({ ticket, user, admin, onBack, onChanged }: { ticket: SupportTicketRecord; user: UserRecord; admin?: boolean; onBack: () => void; onChanged: (ticket: SupportTicketRecord) => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sendingRef = useRef(false);
  const closed = ticket.status === "closed";

  const sendReply = async () => {
    if (!reply.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true); setError("");
    try {
      const body = await jsonRequest<{ ticket: SupportTicketRecord }>(`/api/support/${ticket.id}`, { method: "POST", body: JSON.stringify({ body: reply }) });
      setReply(""); onChanged(body.ticket);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reply failed"); }
    finally { sendingRef.current = false; setBusy(false); }
  };

  const updateTicket = async (changes: { status?: SupportTicketRecord["status"]; priority?: SupportTicketRecord["priority"] }) => {
    setBusy(true); setError("");
    try {
      const body = await jsonRequest<{ ticket: SupportTicketRecord }>(`/api/support/${ticket.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      onChanged(body.ticket);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Update failed"); }
    finally { setBusy(false); }
  };

  return <div className="ticket-thread">
    <div className="ticket-thread-nav"><button type="button" onClick={onBack}><ArrowLeft size={13} />Back</button><span className={`community-status is-${ticket.status}`}>{ticket.status.replace("_", " ")}</span></div>
    <div className="ticket-thread-title"><small>{ticket.category} · #{ticket.id.slice(0, 6)}</small><h3>{ticket.subject}</h3>{admin && <div className="ticket-account-context"><span><strong>{ticket.userName}</strong><small>{ticket.userEmail}</small></span><span><strong>{ticket.workspaceName || "Personal workspace"}</strong><small>Workspace</small></span><b className={`admin-plan is-${ticket.supportTier}`}>{ticket.supportTierName} support</b></div>}</div>
    {admin && <div className="ticket-admin-controls">
      <div><span>Status</span><CommunitySelect value={ticket.status} ariaLabel="Ticket status" options={[{ value: "open", label: "Open" }, { value: "in_progress", label: "In progress" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" }]} disabled={busy} onChange={(status) => void updateTicket({ status })} /></div>
      <div><span>Priority</span><CommunitySelect value={ticket.priority} ariaLabel="Ticket priority" options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }]} disabled={busy} onChange={(priority) => void updateTicket({ priority })} /></div>
    </div>}
    <div className="ticket-messages">
      {(ticket.messages || []).map((message) => <article key={message.id} className={`${message.authorUserId === user.id ? "is-own" : ""} ${message.isAdmin ? "is-staff" : ""}`}>
        <header><strong>{message.isAdmin ? "Scenelith support" : message.authorName}</strong><small>{relativeTime(message.createdAt)}</small></header><p>{message.body}</p>
      </article>)}
    </div>
    {error && <span className="community-error">{error}</span>}
    <div className="ticket-reply"><textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder={closed ? "This ticket is closed" : admin ? "Reply as Scenelith support…" : "Write a reply…"} disabled={busy || closed} maxLength={6000} /><button type="button" onClick={() => void sendReply()} disabled={!reply.trim() || busy || closed}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}</button></div>
  </div>;
}

export function SupportPanel({ user, workspaceId, focusId, focusNonce, onClose }: { user: UserRecord; workspaceId: string; focusId?: string; focusNonce?: number; onClose: () => void }) {
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([]);
  const [selected, setSelected] = useState<SupportTicketRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ subject: "", category: "bug", body: "" });

  const loadTickets = useCallback(async () => {
    setBusy(true); setError("");
    try { const body = await jsonRequest<{ tickets: SupportTicketRecord[] }>("/api/support"); setTickets(body.tickets); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load tickets"); }
    finally { setBusy(false); }
  }, []);

  const openTicket = useCallback(async (id: string, background = false) => {
    if (!background) setBusy(true);
    setError("");
    try { const body = await jsonRequest<{ ticket: SupportTicketRecord }>(`/api/support/${id}`); setSelected(body.ticket); setCreating(false); window.dispatchEvent(new Event("scenelith:notifications-changed")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load ticket"); }
    finally { if (!background) setBusy(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void loadTickets(), 0); return () => window.clearTimeout(timer); }, [loadTickets]);
  useEffect(() => { if (!focusId) return; const timer = window.setTimeout(() => void openTicket(focusId), 0); return () => window.clearTimeout(timer); }, [focusId, focusNonce, openTicket]);
  useEffect(() => {
    const ticketId = selected?.id;
    if (!ticketId) return;
    const refreshThread = () => { if (document.visibilityState === "visible") void openTicket(ticketId, true); };
    const timer = window.setInterval(refreshThread, 30_000);
    window.addEventListener("focus", refreshThread);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshThread); };
  }, [openTicket, selected?.id]);

  const createTicket = async () => {
    setBusy(true); setError("");
    try {
      const body = await jsonRequest<{ ticket: SupportTicketRecord }>("/api/support", { method: "POST", body: JSON.stringify({ ...form, workspaceId }) });
      setForm({ subject: "", category: "bug", body: "" }); setCreating(false); setSelected(body.ticket); await loadTickets();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create ticket"); setBusy(false); }
  };

  return <PanelShell eyebrow="SCENELITH / HELP DESK" title="Support" description="One thread for every issue · replies stay attached to the ticket" onClose={onClose}>
    {selected ? <TicketThread ticket={selected} user={user} onBack={() => { setSelected(null); void loadTickets(); }} onChanged={(ticket) => { setSelected(ticket); setTickets((current) => current.map((item) => item.id === ticket.id ? { ...item, ...ticket } : item)); }} /> : creating ? <div className="community-compose community-form-rail">
      <button type="button" className="community-back" onClick={() => setCreating(false)}><ArrowLeft size={13} />Tickets</button><h3>Start a support ticket</h3><p>Describe one issue at a time. You can continue the conversation after sending.</p>
      <label><span>Subject</span><input value={form.subject} onChange={(event) => setForm((value) => ({ ...value, subject: event.target.value }))} placeholder="What went wrong?" maxLength={140} /></label>
      <div className="community-field"><span>Area</span><CommunitySelect value={form.category as SupportTicketRecord["category"]} ariaLabel="Ticket area" options={[{ value: "bug", label: "Bug" }, { value: "generation", label: "Generation" }, { value: "account", label: "Account" }, { value: "other", label: "Other" }]} onChange={(category) => setForm((current) => ({ ...current, category }))} /></div>
      <label><span>Details</span><textarea value={form.body} onChange={(event) => setForm((value) => ({ ...value, body: event.target.value }))} placeholder="What happened, what did you expect, and how can we reproduce it?" maxLength={6000} /></label>
      {error && <span className="community-error">{error}</span>}<button type="button" className="community-primary" disabled={busy || form.subject.trim().length < 4 || form.body.trim().length < 10} onClick={() => void createTicket()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}Send ticket</button>
    </div> : <>
      <div className="community-toolbar"><span><Inbox size={13} />{tickets.length} ticket{tickets.length === 1 ? "" : "s"}</span><button type="button" onClick={() => setCreating(true)}><Plus size={13} />New ticket</button></div>
      <div className="community-list support-ticket-list">
        {busy && !tickets.length ? <div className="community-loading"><LoaderCircle className="spin" size={18} />Loading tickets</div> : tickets.map((ticket) => <button type="button" className="ticket-card" key={ticket.id} onClick={() => void openTicket(ticket.id)}>
          <span className={`ticket-priority is-${ticket.priority}`} /><span><small>{ticket.category} · {relativeTime(ticket.updatedAt)}</small><strong>{ticket.subject}</strong><p>{ticket.lastMessage}</p><em>{ticket.messageCount} message{ticket.messageCount === 1 ? "" : "s"}</em></span><b className={`community-status is-${ticket.status}`}>{ticket.status.replace("_", " ")}</b>
        </button>)}
        {!busy && !tickets.length && <EmptyState icon={<Headphones size={24} />} title="Your support inbox is clear" body="Create a ticket when you need help with an account, provider or generation issue." />}
      </div>{error && <span className="community-error is-list">{error}</span>}
    </>}
  </PanelShell>;
}

function FeatureCard({ feature, onVote, adminActions }: { feature: FeatureRequestRecord; onVote?: (feature: FeatureRequestRecord) => void; adminActions?: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (expanded || !detailRef.current) return;
    const detail = detailRef.current;
    const measure = () => setCanExpand(Array.from(detail.querySelectorAll<HTMLElement>("[data-feature-copy]"))
      .some((element) => element.scrollHeight > element.clientHeight + 1));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(detail);
    return () => observer.disconnect();
  }, [expanded, feature.description, feature.moderationNote]);

  return <article className={`feature-card is-${feature.status} ${feature.hidden ? "is-hidden" : ""} ${expanded ? "is-expanded" : ""}`}>
    <button type="button" className={`feature-vote ${feature.hasVoted ? "is-voted" : ""}`} onClick={() => onVote?.(feature)} disabled={!onVote || feature.status === "shipped" || feature.status === "pending" || feature.status === "rejected"}><ChevronUp size={15} /><strong>{feature.voteCount}</strong></button>
    <div><header><span className={`community-status is-${feature.status}`}>{featureStatusLabels[feature.status]}</span>{feature.hidden && <span className="community-status is-hidden"><EyeOff size={10} />Hidden</span>}<small>{relativeTime(feature.updatedAt)}</small></header><h3>{feature.title}</h3><div className="feature-detail" ref={detailRef}><p data-feature-copy>{feature.description}</p>{feature.moderationNote && <em data-feature-copy>{feature.moderationNote}</em>}</div>{(canExpand || expanded) && <button type="button" className="feature-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "View full request"}<ChevronDown size={12} /></button>}{adminActions}</div>
  </article>;
}

export function FeatureBoardPanel({ workspaceId, focusId, onClose }: { workspaceId: string; focusId?: string; onClose: () => void }) {
  const [features, setFeatures] = useState<FeatureRequestRecord[]>([]);
  const [filter, setFilter] = useState<"popular" | "roadmap" | "shipped" | "mine">("popular");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", description: "" });

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { const body = await jsonRequest<{ features: FeatureRequestRecord[] }>("/api/features"); setFeatures(body.features); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load feature board"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (focusId) window.setTimeout(() => document.querySelector(`[data-feature-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 200); }, [focusId, features]);

  const visible = useMemo(() => features.filter((feature) => filter === "popular"
    ? ["approved", "planned", "in_progress"].includes(feature.status)
    : filter === "roadmap" ? ["planned", "in_progress"].includes(feature.status)
      : filter === "shipped" ? feature.status === "shipped" : feature.isOwner), [features, filter]);

  const titleLength = form.title.trim().length;
  const descriptionLength = form.description.trim().length;
  const submissionReady = titleLength >= 5 && descriptionLength >= 30;
  const submissionHint = titleLength < 5
    ? `Add ${5 - titleLength} more character${5 - titleLength === 1 ? "" : "s"} to the title`
    : descriptionLength < 30
      ? `Add ${30 - descriptionLength} more character${30 - descriptionLength === 1 ? "" : "s"} so reviewers understand the request`
      : "Ready for review";

  const vote = async (feature: FeatureRequestRecord) => {
    try {
      const body = await jsonRequest<{ feature: FeatureRequestRecord }>(`/api/features/${feature.id}/vote`, { method: "POST", body: "{}" });
      setFeatures((current) => current.map((item) => item.id === feature.id ? body.feature : item).sort((a, b) => b.voteCount - a.voteCount));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Vote failed"); }
  };

  const submit = async () => {
    if (!submissionReady || busy) return;
    setBusy(true); setError("");
    try {
      const body = await jsonRequest<{ feature: FeatureRequestRecord }>("/api/features", { method: "POST", body: JSON.stringify({ ...form, workspaceId }) });
      setFeatures((current) => [body.feature, ...current]); setForm({ title: "", description: "" }); setCreating(false); setFilter("mine");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit feature"); }
    finally { setBusy(false); }
  };

  return <PanelShell eyebrow="SCENELITH / COMMUNITY ROADMAP" title="Feature board" description="Propose improvements · the most-needed ideas rise through community votes" onClose={onClose}>
    {creating ? <div className="community-compose community-form-rail"><button type="button" className="community-back" onClick={() => setCreating(false)}><ArrowLeft size={13} />Feature board</button><h3>Suggest a feature</h3><p>Explain the problem first, then the outcome you want. Every submission is reviewed before public voting.</p><label><span>Short title</span><input value={form.title} onChange={(event) => setForm((value) => ({ ...value, title: event.target.value }))} placeholder="Example: Shared canvas comments" minLength={5} maxLength={120} /><small className={`community-field-help ${form.title.length > 0 && titleLength < 5 ? "is-warning" : ""}`}><span>5–120 characters</span><b>{form.title.length}/120</b></small></label><label><span>Why it matters</span><textarea value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} placeholder="What are you trying to do, and how would this improve your workflow?" minLength={30} maxLength={5000} /><small className={`community-field-help ${form.description.length > 0 && descriptionLength < 30 ? "is-warning" : ""}`}><span>Describe the problem and the result you need · minimum 30</span><b>{form.description.length}/5000</b></small></label>{error && <span className="community-error">{error}</span>}<div className={`community-submit-state ${submissionReady ? "is-ready" : ""}`}><span>{submissionReady && <Check size={12} />}{submissionHint}</span><button type="button" className="community-primary" disabled={busy || !submissionReady} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}Submit for review</button></div></div> : <>
      <div className="feature-board-actions"><div><button className={filter === "popular" ? "is-active" : ""} onClick={() => setFilter("popular")}>Popular</button><button className={filter === "roadmap" ? "is-active" : ""} onClick={() => setFilter("roadmap")}>Roadmap</button><button className={filter === "shipped" ? "is-active" : ""} onClick={() => setFilter("shipped")}>Completed</button><button className={filter === "mine" ? "is-active" : ""} onClick={() => setFilter("mine")}>My requests</button></div><button type="button" onClick={() => setCreating(true)}><Plus size={13} />Suggest</button></div>
      <div className="community-list feature-list">{visible.map((feature) => <div key={feature.id} data-feature-id={feature.id}><FeatureCard feature={feature} onVote={(item) => void vote(item)} /></div>)}{!busy && !visible.length && <EmptyState icon={<Lightbulb size={24} />} title={filter === "mine" ? "No submitted ideas" : "No features here yet"} body={filter === "mine" ? "Your ideas and their current product status will appear here." : "Be the first to suggest an improvement for this part of the roadmap."} />}{busy && !features.length && <div className="community-loading"><LoaderCircle className="spin" size={18} />Loading the board</div>}</div>{error && <span className="community-error is-list">{error}</span>}
    </>}
  </PanelShell>;
}

export function AdminPanel({ user, focusId, focusNonce, onClose }: { user: UserRecord; focusId?: string; focusNonce?: number; onClose: () => void }) {
  const [tab, setTab] = useState<"tickets" | "features" | "announce">("tickets");
  const [ticketFilter, setTicketFilter] = useState<"attention" | "active" | "resolved" | "all">("attention");
  const [featureFilter, setFeatureFilter] = useState<"pending" | "voting" | "roadmap" | "completed" | "hidden" | "all">("pending");
  const [ticketSearch, setTicketSearch] = useState("");
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([]);
  const [features, setFeatures] = useState<FeatureRequestRecord[]>([]);
  const [counts, setCounts] = useState({ openTickets: 0, pendingFeatures: 0, totalVotes: 0 });
  const [selected, setSelected] = useState<SupportTicketRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState({ title: "", body: "", recipientEmail: "" });
  const [sent, setSent] = useState("");

  const visibleTickets = useMemo(() => {
    const query = ticketSearch.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const matchesFilter = ticketFilter === "all"
        || (ticketFilter === "attention" ? ticket.needsReply && ["open", "in_progress"].includes(ticket.status)
          : ticketFilter === "active" ? ["open", "in_progress"].includes(ticket.status)
            : ["resolved", "closed"].includes(ticket.status));
      const matchesSearch = !query || [ticket.subject, ticket.lastMessage, ticket.userName, ticket.userEmail, ticket.workspaceName, ticket.supportTierName, ticket.category]
        .some((value) => value?.toLowerCase().includes(query));
      return matchesFilter && matchesSearch;
    });
  }, [ticketFilter, ticketSearch, tickets]);

  const visibleFeatures = useMemo(() => features.filter((feature) => {
    if (featureFilter === "all") return true;
    if (featureFilter === "hidden") return feature.hidden;
    if (feature.hidden) return false;
    if (featureFilter === "pending") return feature.status === "pending";
    if (featureFilter === "voting") return feature.status === "approved";
    if (featureFilter === "roadmap") return feature.status === "planned" || feature.status === "in_progress";
    return feature.status === "shipped";
  }), [featureFilter, features]);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { const body = await jsonRequest<{ tickets: SupportTicketRecord[]; features: FeatureRequestRecord[]; counts: typeof counts }>("/api/admin/overview"); setTickets(body.tickets); setFeatures(body.features); setCounts(body.counts); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load admin queue"); }
    finally { setBusy(false); }
  }, []);
  const openTicket = useCallback(async (id: string, background = false) => {
    if (!background) setBusy(true);
    try { const body = await jsonRequest<{ ticket: SupportTicketRecord }>(`/api/support/${id}`); setSelected(body.ticket); setTab("tickets"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load ticket"); }
    finally { if (!background) setBusy(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!focusId) return;
    const timer = window.setTimeout(() => {
      if (focusId.startsWith("feature:")) {
        setTab("features");
        const featureId = focusId.slice("feature:".length);
        window.setTimeout(() => document.querySelector(`[data-admin-feature-id="${CSS.escape(featureId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
        return;
      }
      void openTicket(focusId.startsWith("ticket:") ? focusId.slice("ticket:".length) : focusId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, focusNonce, openTicket]);
  useEffect(() => {
    const ticketId = selected?.id;
    if (!ticketId || tab !== "tickets") return;
    const refreshThread = () => { if (document.visibilityState === "visible") void openTicket(ticketId, true); };
    const timer = window.setInterval(refreshThread, 30_000);
    window.addEventListener("focus", refreshThread);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshThread); };
  }, [openTicket, selected?.id, tab]);

  const updateFeature = async (feature: FeatureRequestRecord, changes: { status?: FeatureRequestRecord["status"]; hidden?: boolean }) => {
    setBusy(true); setError("");
    try {
      const body = await jsonRequest<{ feature: FeatureRequestRecord }>(`/api/features/${feature.id}`, { method: "PATCH", body: JSON.stringify({ ...changes, moderationNote: notes[feature.id] ?? feature.moderationNote }) });
      setFeatures((current) => current.map((item) => item.id === feature.id ? body.feature : item));
      setCounts((current) => ({
        ...current,
        pendingFeatures: features.filter((item) => {
          const updated = item.id === feature.id ? body.feature : item;
          return !updated.hidden && updated.status === "pending";
        }).length,
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Moderation failed"); setBusy(false); }
    finally { setBusy(false); }
  };

  const sendAnnouncement = async () => {
    setBusy(true); setError(""); setSent("");
    try {
      const body = await jsonRequest<{ audience: string }>("/api/admin/notifications", { method: "POST", body: JSON.stringify(announcement) });
      setSent(`Sent to ${body.audience}`); setAnnouncement({ title: "", body: "", recipientEmail: "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send notification"); }
    finally { setBusy(false); }
  };

  return <section className="admin-library" aria-label="Administration">
    <header className="hook-page-head admin-library-head">
      <div className="hook-page-title"><p className="eyebrow">SCENELITH / OPERATIONS</p><div><h1>Administration</h1><span>{counts.openTickets} active ticket{counts.openTickets === 1 ? "" : "s"} · {counts.pendingFeatures} awaiting review · {counts.totalVotes} community votes</span></div></div>
      <button className="hook-page-close" type="button" onClick={onClose} title="Back to canvas" aria-label="Back to canvas"><X size={18} /></button>
    </header>
    <div className="admin-library-tabs">
      <button className={tab === "tickets" ? "is-active" : ""} onClick={() => setTab("tickets")}><Headphones size={13} /><span>Support inbox</span>{counts.openTickets > 0 && <b>{counts.openTickets}</b>}</button>
      <button className={tab === "features" ? "is-active" : ""} onClick={() => setTab("features")}><Lightbulb size={13} /><span>Feature review</span>{counts.pendingFeatures > 0 && <b>{counts.pendingFeatures}</b>}</button>
      <button className={tab === "announce" ? "is-active" : ""} onClick={() => setTab("announce")}><Megaphone size={13} /><span>Notifications</span></button>
    </div>
    <div className="admin-library-body">
      {tab === "tickets" && <div className={`admin-ticket-workspace ${selected ? "is-detail-open" : ""}`}>
        <section className="admin-queue-pane">
          <div className="admin-queue-toolbar">
            <label><Search size={14} /><input value={ticketSearch} onChange={(event) => setTicketSearch(event.target.value)} placeholder="Search name, email, subject…" /></label>
            <div role="group" aria-label="Filter support queue">{([['attention', 'Needs reply'], ['active', 'Active'], ['resolved', 'Resolved'], ['all', 'All']] as const).map(([value, label]) => <button key={value} className={ticketFilter === value ? "is-active" : ""} onClick={() => setTicketFilter(value)}>{label}</button>)}</div>
          </div>
          <div className="admin-queue-caption"><span>{visibleTickets.length} shown</span><small>Support tier · priority · longest wait</small></div>
          <div className="admin-ticket-list">
            {visibleTickets.map((ticket) => <button type="button" className={`admin-ticket-row ${selected?.id === ticket.id ? "is-selected" : ""}`} key={ticket.id} onClick={() => void openTicket(ticket.id)}>
              <span className="admin-ticket-avatar">{ticket.userName.slice(0, 1).toUpperCase()}</span>
              <span className="admin-ticket-copy"><span><strong>{ticket.userName}</strong><b className={`admin-plan is-${ticket.supportTier}`}>{ticket.supportTierName}</b>{ticket.needsReply && <em>Needs reply</em>}</span><small>{ticket.userEmail}</small><h3>{ticket.subject}</h3><p>{ticket.lastMessage}</p></span>
              <span className="admin-ticket-meta"><small>{relativeTime(ticket.updatedAt)}</small><b className={`community-status is-${ticket.status}`}>{ticket.status.replace("_", " ")}</b><em>{ticket.category}</em></span>
            </button>)}
            {!busy && !visibleTickets.length && <div className="admin-queue-empty"><Check size={20} /><strong>{tickets.length ? "No tickets match this view" : "Support queue clear"}</strong><p>{tickets.length ? "Try another filter or search term." : "New tickets and user replies will appear here."}</p></div>}
            {busy && !tickets.length && <div className="community-loading"><LoaderCircle className="spin" size={18} />Loading support queue</div>}
          </div>
        </section>
        <section className="admin-detail-pane">
          {selected ? <TicketThread ticket={selected} user={user} admin onBack={() => { setSelected(null); void load(); }} onChanged={(ticket) => { setSelected(ticket); setTickets((current) => current.map((item) => item.id === ticket.id ? { ...item, ...ticket } : item)); }} /> : <div className="admin-detail-empty"><ShieldCheck size={24} /><strong>Select a conversation</strong><p>Open a ticket to see the account, support tier, full thread and moderation controls.</p></div>}
        </section>
      </div>}
      {tab === "features" && <><div className="admin-feature-toolbar"><span><Lightbulb size={13} />{visibleFeatures.length} of {features.length} idea{features.length === 1 ? "" : "s"}</span><div role="group" aria-label="Filter feature requests">{([['pending', 'Review'], ['voting', 'Voting'], ['roadmap', 'Roadmap'], ['completed', 'Completed'], ['hidden', 'Hidden'], ['all', 'All']] as const).map(([value, label]) => <button type="button" key={value} className={featureFilter === value ? "is-active" : ""} onClick={() => setFeatureFilter(value)}>{label}</button>)}</div></div><div className="community-list admin-feature-list">{visibleFeatures.map((feature) => <div key={feature.id} data-admin-feature-id={feature.id}><FeatureCard feature={feature} adminActions={<div className="feature-moderation"><textarea value={notes[feature.id] ?? feature.moderationNote} onChange={(event) => setNotes((current) => ({ ...current, [feature.id]: event.target.value }))} placeholder="Optional note shown to the author…" maxLength={1200} /><div className="feature-moderation-actions"><CommunitySelect value={feature.status} ariaLabel={`Status for ${feature.title}`} options={featureStatusOptions} disabled={busy} onChange={(status) => void updateFeature(feature, { status })} /><button type="button" className="feature-visibility" disabled={busy} onClick={() => void updateFeature(feature, { hidden: !feature.hidden })}>{feature.hidden ? <><Eye size={13} />Restore</> : <><EyeOff size={13} />Hide</>}</button></div></div>} /></div>)}{!busy && !visibleFeatures.length && <EmptyState icon={featureFilter === "hidden" ? <EyeOff size={24} /> : <Lightbulb size={24} />} title={featureFilter === "hidden" ? "Nothing hidden" : "No feature requests in this view"} body={featureFilter === "hidden" ? "Hidden ideas stay private and can be restored at any time." : "Change the filter to review another product stage."} />}{busy && !features.length && <div className="community-loading"><LoaderCircle className="spin" size={18} />Loading feature requests</div>}</div></>}
      {tab === "announce" && <div className="community-compose admin-announcement"><h3>Send a notification</h3><p>Leave the recipient empty for a global announcement. Enter an account email for a private notification.</p><label><span>Recipient email · optional</span><input type="email" value={announcement.recipientEmail} onChange={(event) => setAnnouncement((value) => ({ ...value, recipientEmail: event.target.value }))} placeholder="Everyone" /></label><label><span>Title</span><input value={announcement.title} onChange={(event) => setAnnouncement((value) => ({ ...value, title: event.target.value }))} placeholder="What changed?" maxLength={100} /></label><label><span>Message</span><textarea value={announcement.body} onChange={(event) => setAnnouncement((value) => ({ ...value, body: event.target.value }))} placeholder="Keep it useful and concise…" maxLength={1200} /></label>{sent && <span className="community-success"><Check size={12} />{sent}</span>}<button type="button" className="community-primary" disabled={busy || announcement.title.trim().length < 3 || announcement.body.trim().length < 3} onClick={() => void sendAnnouncement()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}Send notification</button></div>}
      {error && <span className="community-error admin-library-error">{error}</span>}
    </div>
  </section>;
}

export function CommunityPanelRouter({ focus, user, workspace, onOpenPricing, onClose }: { focus: PanelFocus; user: UserRecord; workspace: WorkspaceRecord; onOpenPricing: () => void; onClose: () => void }) {
  if (!focus) return null;
  if (focus.kind === "support") return <SupportPanel user={user} workspaceId={workspace.id} focusId={focus.id} focusNonce={focus.nonce} onClose={onClose} />;
  if (focus.kind === "features") return <FeatureBoardPanel workspaceId={workspace.id} focusId={focus.id} onClose={onClose} />;
  if (focus.kind === "team") return <TeamPanel user={user} workspace={workspace} onOpenPricing={onOpenPricing} onClose={onClose} />;
  return user.isAdmin ? <AdminPanel user={user} focusId={focus.id} focusNonce={focus.nonce} onClose={onClose} /> : null;
}

export const communityRailItems = [
  { kind: "support" as const, label: "Support", icon: Headphones },
  { kind: "features" as const, label: "Feature board", icon: Lightbulb },
];
