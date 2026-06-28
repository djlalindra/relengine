"use client";

import { useState, ReactNode } from "react";

type AccordionRowProps = {
  rank?: number;
  title: ReactNode;
  subtitle?: ReactNode;
  metaRow?: ReactNode;
  badge?: ReactNode;
  rightMeta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function AccordionRow({
  rank,
  title,
  subtitle,
  metaRow,
  badge,
  rightMeta,
  defaultOpen = false,
  children,
}: AccordionRowProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-[#1A1F2E] bg-[#0D111D]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {rank !== undefined && (
            <span className="flex-shrink-0 text-xs font-semibold text-[#8B93A7] w-4">{rank}</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-[#F5F7FA]">{title}</p>
              {badge}
            </div>
            {subtitle && (
              <p className="truncate text-xs text-[#8B93A7]">{subtitle}</p>
            )}
            {metaRow && <div className="mt-1">{metaRow}</div>}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          {rightMeta}
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 text-[#8B93A7] transition-transform ${
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
        </div>
      </button>
      {open && (
        <div className="border-t border-[#1A1F2E] px-4 py-4">{children}</div>
      )}
    </div>
  );
}
