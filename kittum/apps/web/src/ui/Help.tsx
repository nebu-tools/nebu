// An explanation a person reads once, kept off the page until asked: a dotted underline on the
// words it explains, or, where there are no words to mark, a small "i" in a circle. Never "?":
// in Kittum a question mark means unclear. Pointing at it or focusing it with the
// keyboard shows the text; screen readers read it as the mark's name or the words' description.
import { useId } from "react";
import type { ReactNode } from "react";

const TIP =
  "pointer-events-none invisible absolute top-full left-0 z-40 mt-1 w-max max-w-[320px] rounded-[4px] bg-ink px-2.5 py-1.5 text-left text-xs leading-[17px] font-normal tracking-normal whitespace-normal normal-case text-paper shadow-[0_6px_16px_rgb(0_0_0/0.18)] group-hover/help:visible group-focus-visible/help:visible";

export function Help({ text, children }: { text: string; children?: ReactNode }) {
  const id = useId();
  if (children) {
    return (
      <span
        tabIndex={0}
        aria-describedby={id}
        className="group/help relative cursor-help underline decoration-ink-3 decoration-dotted underline-offset-2 outline-offset-2"
      >
        {children}
        <span role="tooltip" id={id} className={TIP}>
          {text}
        </span>
      </span>
    );
  }
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      className="group/help relative inline-flex h-4 w-4 flex-none cursor-help items-center justify-center rounded-full align-[1px] font-serif text-[11px] leading-none font-semibold text-ink-2 italic shadow-[inset_0_0_0_1.25px_var(--ink-3)] outline-offset-2"
    >
      i
      <span aria-hidden="true" className={TIP}>
        {text}
      </span>
    </span>
  );
}
