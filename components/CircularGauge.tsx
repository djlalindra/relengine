"use client";

type GaugeProps = {
  value: number; // 0-100
  label: string;
  sublabel?: string;
};

export function CircularGauge({ value, label, sublabel }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 76;
  const stroke = 12;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const offset = circumference - (clamped / 100) * circumference;

  const color =
    clamped >= 75 ? "#14BA82" : clamped >= 45 ? "#E0A33C" : "#EE4542";
  const statusLabel =
    clamped >= 75 ? "OPTIMIZED" : clamped >= 45 ? "NEEDS WORK" : "AT RISK";

  return (
    <div className="flex flex-col items-center">
      <svg height={radius * 2} width={radius * 2} className="-rotate-90">
        <circle
          stroke="#1A1F2E"
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
      <div className="-mt-[108px] flex flex-col items-center">
        <span className="text-4xl font-bold text-[#F5F7FA]">{clamped}%</span>
        <span className="mt-1 text-xs font-bold tracking-wide" style={{ color }}>
          {statusLabel}
        </span>
      </div>
      <div className="mt-3 flex flex-col items-center">
        <span className="text-xs font-medium text-[#8B93A7]">{label}</span>
        {sublabel && <span className="mt-0.5 text-xs text-[#8B93A7]">{sublabel}</span>}
      </div>
    </div>
  );
}
