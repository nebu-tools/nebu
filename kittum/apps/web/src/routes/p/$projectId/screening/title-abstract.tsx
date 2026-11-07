import { createFileRoute } from "@tanstack/react-router";

import { TitleAbstractQueue } from "../../../../screens/screening/TitleAbstract.tsx";

export const Route = createFileRoute("/p/$projectId/screening/title-abstract")({
  // From the table: `scope` picks the reviewer's stage, and the queue starts behind `after`, so
  // the record opened comes first. The queue's own order does not change.
  validateSearch: (search: Record<string, unknown>): { scope?: string; after?: string } => ({
    ...(typeof search["scope"] === "string" ? { scope: search["scope"] } : {}),
    ...(typeof search["after"] === "string" ? { after: search["after"] } : {}),
  }),
  component: Queue,
});

/** A new scope or start is a new queue: nothing of the one before carries over. */
function Queue() {
  const { scope, after } = Route.useSearch();
  return <TitleAbstractQueue key={`${scope ?? ""}|${after ?? ""}`} />;
}
