import { createFileRoute } from "@tanstack/react-router";

import { TitleAbstractQueue } from "../../../../screens/screening/TitleAbstract.tsx";

export const Route = createFileRoute("/p/$projectId/screening/title-abstract")({
  // `after`: the queue starts behind this assignment, so a record opened from the table comes
  // first. The queue's own order does not change.
  validateSearch: (search: Record<string, unknown>): { after?: string } =>
    typeof search["after"] === "string" ? { after: search["after"] } : {},
  component: TitleAbstractQueue,
});
