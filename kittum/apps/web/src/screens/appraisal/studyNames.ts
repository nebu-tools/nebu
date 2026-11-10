// Studies by name ("López-Durán 2025"), not by DOI. The appraisal and extraction responses carry
// only a DOI or registry ID as the study's label; the corpus has the authors and the year. The
// corpus is the methods lead's, so for anyone else the map stays empty and screens fall back to
// the report's title.
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { run } from "../../data/workbench.ts";
import { studyLabel } from "../../lib/labels.ts";
import { useProject } from "../project.tsx";

/** Each report's study name by report ID, where the corpus names its authors. */
export function useStudyNames(): ReadonlyMap<string, string> {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, has } = useProject();
  const lead = has("lead");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!lead) return;
    let live = true;
    run(workbench.corpus({ projectId: project.id, as: me.actor_id })).then(
      (corpus) => {
        if (!live || !corpus) return;
        const out = new Map<string, string>();
        // Of a report's records, the one that spells the author as published: PubMed drops
        // accents ("Lopez-Duran"), the journal's own record keeps them ("López-Durán").
        const accents = (text: string) => text.normalize("NFD").length - text.length;
        for (const report of corpus.reports) {
          const named = report.records
            .filter((r) => r.authors?.length)
            .toSorted((a, b) => accents(b.authors?.[0] ?? "") - accents(a.authors?.[0] ?? ""));
          const best = named[0];
          const name = best ? studyLabel(best.authors, best.year) : null;
          if (name) out.set(report.report_id, name);
        }
        setNames(out);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, lead]);
  return names;
}

/** A journal's name without its subtitle: "Nicotine & tobacco research" for "Nicotine & tobacco
 * research : official journal of the Society for Research on Nicotine and Tobacco". */
export const journalName = (journal: string | null | undefined) =>
  journal ? journal.split(/\s+:\s+/)[0]!.trim() : "";

/** A study's name: the corpus name, else the report's title cut short. Never a DOI. */
export const studyName = (
  names: ReadonlyMap<string, string>,
  reportId: string,
  title: string,
  length = 48,
): string => {
  const known = names.get(reportId);
  if (known) return known;
  const plain = title.replace(/\s+/g, " ").trim();
  if (plain.length <= length) return plain;
  const cut = plain.slice(0, length + 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > 16 ? cut.slice(0, word) : plain.slice(0, length)).replace(/[\s,:;]+$/, "")}…`;
};
