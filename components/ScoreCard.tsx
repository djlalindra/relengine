"use client";

type ScoreCardProps = {
  value: string | number;
  label: string;
  accent?: "neutral" | "warning" | "good";
};

export function ScoreCard({ value, label, accent = "neutral" }: ScoreCardProps) {
  const valueColor =
    accent === "good" ? "text-[#6bcf6b]" : accent === "warning" ? "text-[#ff6b6b]" : "text-[#e8e8e8]";

  return (
    <div className="rounded-md border border-[#1f1f1f] bg-[#121212] px-4 py-3">
      <p className={`text-2xl font-semibold ${valueColor}`}>{value}</p>
      <p className="mt-0.5 text-xs text-[#888]">{label}</p>
    </div>
  );
}
