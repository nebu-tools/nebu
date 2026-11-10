import { createFileRoute } from "@tanstack/react-router";

import { AuditScreen } from "../../../screens/audit/Audit.tsx";

export const Route = createFileRoute("/p/$projectId/audit")({
  // From Progress: `count` opens that PRISMA count's records (a key of the flow's members), in
  // `scope` when the review has several.
  validateSearch: (search: Record<string, unknown>): { count?: string; scope?: string } => ({
    ...(typeof search["count"] === "string" ? { count: search["count"] } : {}),
    ...(typeof search["scope"] === "string" ? { scope: search["scope"] } : {}),
  }),
  component: AuditScreen,
});
