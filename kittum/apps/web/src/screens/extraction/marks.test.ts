import { describe, expect, test } from "vite-plus/test";

import type { ReviewField } from "../../data/schema.ts";
import { estimateFacts } from "./marks.tsx";

const field = (value: string, quote: string) =>
  ({
    key: { endpoint: "abstinence", arm: "", timepoint: "m6" },
    labels: { endpoint: "Abstinence" },
    spec: { quantity: "odds_ratio", description: "Odds ratio" },
    proposals: [{ value, quote, anchor_ids: [] }],
  }) as unknown as ReviewField;

const intervalOf = (value: string, quote: string) => {
  const f = field(value, quote);
  return estimateFacts({ field: f, fields: [f], anchors: new Map(), valueOf: () => value })
    .interval;
};

describe("estimateFacts", () => {
  test("reads the interval right after the whole value, never after a number ending in it", () => {
    expect(intervalOf("1.8", "OR 1.8 (1.2-2.6)")).toBe("Interval 1.2 to 2.6");
    expect(intervalOf("5", "n=5, OR 0.5 (0.3-0.7)")).toBeNull();
    expect(intervalOf("12", "112 (60-180) days")).toBeNull();
  });
});
