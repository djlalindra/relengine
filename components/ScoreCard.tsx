"use client";

type ScoreCardProps = {
  value: string | number;
  label: string;
  accent?: "neutral" | "warning" | "good" | "danger" | "purple" | "info";
};

const ACCENT_COLORS: Record<string, string> = {
  neutral: "#F5F7FA",
  good: "#14BA82",
  warning: "#E0A33C",
  danger: "#EE4542",
  purple: "#7C6FE0",
  info: "#5B8DEF",
};

export function ScoreCard({ value, label, accent = "neutral" }: ScoreCardProps) {
  const color = ACCENT_COLORS[accent];

  return (
    <div className="rounded-xl border border-[#1A1F2E] bg-[#0D111D] px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      </div>
      <p className="text-3xl font-bold" style={{ color: accent === "neutral" ? "#F5F7FA" : color }}>
        {value}
      </p>
      <p className="mt-1 text-xs text-[#8B93A7]">{label}</p>
    </div>
  );
}
