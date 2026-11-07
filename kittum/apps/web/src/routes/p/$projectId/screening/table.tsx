import { createFileRoute } from "@tanstack/react-router";

import { ScreeningTableScreen } from "../../../../screens/screening/ScreeningTable.tsx";

export const Route = createFileRoute("/p/$projectId/screening/table")({
  component: ScreeningTableScreen,
});
