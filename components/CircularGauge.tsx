"use client";

type GaugeProps = {
  value: number; // 0-100
  label: string;
  sublabel?: string;
};

export function CircularGauge({ value, label, sublabel }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 70;
  const stroke = 10;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const offset = circumference - (clamped / 100) * circumference;

  const color =
    clamped >= 75 ? "#6bcf6b" : clamped >= 45 ? "#e8c468" : "#ff6b6b";

  return (
    <div className="flex flex-col items-center">
      <svg height={radius * 2} width={radius * 2} className="-rotate-90">
        <circle
          stroke="#1f1f1f"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
        <circle
          stroke={color}
          fill="transparent"
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          style={{ strokeDashoffset: offset, transition: "stroke-dashoffset 0.5s ease" }}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
      </svg>
      <div className="-mt-[100px] flex flex-col items-center">
        <span className="text-3xl font-semibold text-[#e8e8e8]">{clamped}%</span>
        <span className="mt-1 text-xs font-medium text-[#999]">{label}</span>
        {sublabel && <span className="mt-0.5 text-xs text-[#666]">{sublabel}</span>}
      </div>
    </div>
  );
}
