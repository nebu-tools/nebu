// Buttons. An action is a real button; its keyboard key, if it has one, is a small suffix.
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Key } from "./Key.tsx";

type Kind = "primary" | "secondary" | "quiet" | "danger";

const KINDS: Record<Kind, string> = {
  primary: "bg-petrol text-petrol-ink hover:brightness-110 border border-petrol",
  secondary: "bg-sheet text-ink border border-rule-strong hover:border-ink-3 hover:bg-sheet-2",
  quiet: "text-petrol hover:bg-petrol-wash border border-transparent",
  danger: "bg-sheet text-exclude border border-exclude/60 hover:bg-exclude-wash",
};

export function Button({
  kind = "secondary",
  keys,
  size = "md",
  children,
  className,
  type = "button",
  ...rest
}: {
  kind?: Kind;
  /** The key or key sequence that does the same, shown after the label. */
  keys?: ReadonlyArray<string>;
  size?: "sm" | "md";
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-2 rounded-[4px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm"
      } ${KINDS[kind]} ${className ?? ""}`}
      {...rest}
    >
      <span>{children}</span>
      {keys?.length ? (
        <span className="inline-flex items-center gap-0.5 opacity-80" aria-hidden="true">
          {keys.map((k, i) => (
            <Key key={`${k}-${i}`} k={k} className="key-on-button" />
          ))}
        </span>
      ) : null}
    </button>
  );
}
