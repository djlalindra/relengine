"use client";

import { useState, ReactNode } from "react";

type AccordionRowProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function AccordionRow({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  children,
}: AccordionRowProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-md border border-[#1f1f1f] bg-[#121212]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 text-[#666] transition-transform ${
              open ? "rotate-90" : ""
            }`}
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M4 2L8 6L4 10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[#e8e8e8]">{title}</p>
            {subtitle && (
              <p className="truncate text-xs text-[#666]">{subtitle}</p>
            )}
          </div>
        </div>
        {badge && <div className="flex-shrink-0">{badge}</div>}
      </button>
      {open && (
        <div className="border-t border-[#1f1f1f] px-4 py-4">{children}</div>
      )}
    </div>
  );
}
