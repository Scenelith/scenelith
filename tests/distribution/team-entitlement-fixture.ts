export async function configureTeamEntitlement(
  _db: typeof import("../postgres-test-db")["db"],
  _input: { ownerUserId: string; workspaceId: string },
) {
  return { seatLimit: Math.max(1, Number(process.env.SELFHOST_TEAM_SEATS || 100)) };
}
