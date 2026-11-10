// Each screener's own queue in a review's open stages, for the home page and Setup. Every count
// is asked as its screener, so nothing comes back that the screener would not see on their own
// screen.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectSummary, ScopeStatus, StageInfo } from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import type { Workbench } from "../../data/workbench.ts";

export interface Queue {
  readonly actorId: string;
  readonly name: string;
  readonly stage: StageInfo["stage"];
  readonly remaining: number;
  readonly screened: number;
}

export const SCREEN_PATH = {
  title_abstract: "/p/$projectId/screening/title-abstract",
  full_text: "/p/$projectId/screening/full-text",
} as const;

/** One queue per person and stage kind, summed over the questions they screen; null while the
 * counts load. `again` asks anew when it changes. */
export function useQueues(workbench: Workbench, project: ProjectSummary, again = 0) {
  const [queues, setQueues] = useState<ReadonlyArray<Queue> | null>(null);
  useEffect(() => {
    const asks = project.stages.flatMap((s) =>
      s.screeners.map((actorId) => ({ stage: s, actorId })),
    );
    if (asks.length === 0) return;
    let live = true;
    Promise.all(
      asks.map(({ stage, actorId }) =>
        run(
          workbench.status({
            projectId: project.id,
            as: actorId,
            scopeId: stage.scope_id,
            stage: stage.stage,
          }),
        ).then((status: ScopeStatus) => ({ stage, actorId, status })),
      ),
    ).then(
      (all) => {
        if (!live) return;
        const byKey = new Map<string, Queue>();
        for (const { stage, actorId, status } of all) {
          const key = `${actorId}|${stage.stage}`;
          const before = byKey.get(key);
          byKey.set(key, {
            actorId,
            name: project.members.find((m) => m.actor_id === actorId)?.display_name ?? "Someone",
            stage: stage.stage,
            remaining: (before?.remaining ?? 0) + status.remaining,
            screened: (before?.screened ?? 0) + status.screened,
          });
        }
        setQueues([...byKey.values()]);
      },
      () => live && setQueues([]),
    );
    return () => {
      live = false;
    };
  }, [workbench, project, again]);
  return project.stages.length === 0 ? [] : queues;
}

/** One row per screener: name, a bar of what they decided, the count, and an action. */
export function QueueRows({
  queues,
  action,
  caption,
}: {
  queues: ReadonlyArray<Queue>;
  action?: (queue: Queue) => ReactNode;
  caption: string;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {queues.map((q) => {
          const total = q.screened + q.remaining;
          const share = total ? q.screened / total : 0;
          return (
            <tr key={`${q.actorId}-${q.stage}`} className="border-t border-rule first:border-t-0">
              <td className="w-[11rem] py-2 pr-4 font-medium">{q.name}</td>
              {/* Before the first decision, one plain statement instead of an empty bar. */}
              {q.screened ? (
                <>
                  <td className="py-2 pr-4">
                    <span
                      className="block h-1.5 min-w-[120px] overflow-hidden rounded-full bg-sheet-2 shadow-[inset_0_0_0_1px_var(--rule)]"
                      role="img"
                      aria-label={`${Math.round(share * 100)}% decided`}
                    >
                      <span
                        className="block h-full rounded-full bg-ink-2"
                        style={{ width: `${share * 100}%` }}
                      />
                    </span>
                  </td>
                  <td className="w-[10rem] py-2 pr-4 text-ink-2 tabular-nums">
                    {q.screened} of {total} decided
                  </td>
                </>
              ) : (
                <td colSpan={2} className="py-2 pr-4 text-ink-2 tabular-nums">
                  {total
                    ? `${total} ${total === 1 ? "record" : "records"} assigned, not started`
                    : "Nothing assigned yet"}
                </td>
              )}
              {action ? (
                <td className="w-[1%] py-2 text-right whitespace-nowrap">{action(q)}</td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
