// Keyboard handling. Each screen registers one handler; typing in a field, an open dialog, or an
// open menu never triggers screen keys.
import { useEffect, useEffectEvent } from "react";

// A checkbox or radio takes no typed text, so the screen's keys still work while one has focus
// (Space and Enter stay the control's own).
const typing = (target: EventTarget | null, key: string) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["TEXTAREA", "SELECT"].includes(target.tagName) ||
    (target instanceof HTMLInputElement &&
      !(["checkbox", "radio"].includes(target.type) && key !== " " && key !== "Enter")));

const blocked = (event: KeyboardEvent) =>
  event.defaultPrevented ||
  event.metaKey ||
  event.ctrlKey ||
  event.altKey ||
  typing(event.target, event.key) ||
  document.querySelector("[role=dialog][data-open], [role=menu], [data-popup-open]") !== null;

/**
 * Calls `handler` for keys on the page; returning true marks the key as handled. With `first`,
 * the handler runs before every screen's, and a key it handles never reaches them: the layout
 * uses this for the `g` chord, whose second key must not also act on the screen.
 */
export function useKeys(
  handler: (event: KeyboardEvent) => boolean | void,
  { first = false }: { first?: boolean } = {},
) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (blocked(event)) return;
    if (!handler(event)) return;
    event.preventDefault();
    if (first) event.stopPropagation();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey, { capture: first });
    return () => window.removeEventListener("keydown", onKey, { capture: first });
  }, [first]);
}
