import { describe, expect, test } from "vite-plus/test";

import { studyLabel } from "./labels.ts";

describe("studyLabel", () => {
  test("names a study by its first author's surname and the year, whatever the author format", () => {
    expect(studyLabel(["Free C, Knight R"], 2011)).toBe("Free 2011");
    expect(studyLabel(["Free, Caroline"], 2011)).toBe("Free 2011");
    expect(studyLabel(["van der Berg JM"], 2025)).toBe("van der Berg 2025");
    expect(studyLabel(["López-Durán A"], 2025)).toBe("López-Durán 2025");
    expect(studyLabel(["Bricker JB, et al."], 2020)).toBe("Bricker 2020");
    expect(studyLabel([], 2020)).toBe("2020");
    expect(studyLabel(null, null)).toBeNull();
  });
});
