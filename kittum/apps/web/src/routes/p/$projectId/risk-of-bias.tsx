import { createFileRoute } from "@tanstack/react-router";

import { RiskOfBiasScreen } from "../../../screens/appraisal/RiskOfBias.tsx";

export const Route = createFileRoute("/p/$projectId/risk-of-bias")({
  component: RiskOfBiasScreen,
});
