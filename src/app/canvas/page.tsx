import { redirect } from "next/navigation";
import { CanvasApp } from "@/components/CanvasApp";
import { getCurrentUser } from "@/lib/auth";
import {
  db, ensureDefaultWorkspace, ensureStarterProject,
  listAccessibleProjectRows, listAccessibleWorkspaceRows, rowToProject, rowToProjectListItem, rowToWorkspace,
  usageWorkspaceForUserWorkspace,
} from "@/lib/postgres-db";
import { usageSummary } from "@/modules/usage";
import { generationProvider } from "@/platform/providers/registry";

export const runtime = "nodejs";

export default async function CanvasPage({ searchParams }: { searchParams: Promise<{ workspace?: string; project?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const requested = await searchParams;
  const requestedWorkspaceId = requested.workspace;
  let [workspaceRows, projectRows] = await Promise.all([
    listAccessibleWorkspaceRows(user.id),
    listAccessibleProjectRows(user.id),
  ]);
  const fallbackWorkspace = workspaceRows.length ? rowToWorkspace(workspaceRows[0]) : await ensureDefaultWorkspace(user.id);
  if (!workspaceRows.length && fallbackWorkspace) {
    [workspaceRows, projectRows] = await Promise.all([
      listAccessibleWorkspaceRows(user.id),
      listAccessibleProjectRows(user.id),
    ]);
  }
  if (!fallbackWorkspace || !workspaceRows.length) redirect("/login");
  const workspaces = workspaceRows.map(rowToWorkspace);
  const requestedProjectRow = requested.project
    ? projectRows.find((row) => String(row.id) === requested.project)
    : undefined;
  const requestedProjectWorkspaceId = requestedProjectRow ? String(requestedProjectRow.workspace_id) : "";
  const initialWorkspace = workspaces.find((workspace) => workspace.id === requestedProjectWorkspaceId)
    || workspaces.find((workspace) => workspace.id === requestedWorkspaceId)
    || workspaces.find((workspace) => workspace.id === fallbackWorkspace.id)
    || workspaces[0];

  let initialProjectRow = requestedProjectRow && requestedProjectWorkspaceId === initialWorkspace.id
    ? requestedProjectRow
    : projectRows.find((row) => String(row.workspace_id) === initialWorkspace.id);
  if (!initialProjectRow && initialWorkspace.memberRole === "owner") {
    const starter = await ensureStarterProject(initialWorkspace.id);
    initialProjectRow = await db.prepare("SELECT * FROM projects WHERE id = ?").get(starter.id) as Record<string, unknown>;
    projectRows = await listAccessibleProjectRows(user.id);
  }
  if (!initialProjectRow) redirect("/login");
  const [initialProject, usageWorkspaceId] = await Promise.all([
    rowToProject(initialProjectRow),
    usageWorkspaceForUserWorkspace(user.id, initialWorkspace.id),
  ]);
  const projects = projectRows.map((row) => String(row.id) === initialProject.id ? initialProject : rowToProjectListItem(row));
  if (!usageWorkspaceId) redirect("/login");
  const creditUsage = await usageSummary(usageWorkspaceId);
  return <CanvasApp initialProject={initialProject} projects={projects} initialWorkspace={initialWorkspace} workspaces={workspaces} user={user} creditUsage={creditUsage} initialModels={generationProvider().models} />;
}
