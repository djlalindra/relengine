"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

type CoverageBarItem = {
  name: string;
  value: number;
  covered: boolean;
};

export function CoverageBarChart({ items }: { items: CoverageBarItem[] }) {
  const data = items.slice(0, 15).map((i) => ({
    name: i.name.length > 22 ? i.name.slice(0, 20) + "…" : i.name,
    fullName: i.name,
    value: i.value,
    covered: i.covered,
  }));

  return (
    <div style={{ width: "100%", height: Math.max(200, data.length * 28) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={150}
            tick={{ fill: "#aaa", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#161616",
              border: "1px solid #2a2a2a",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ""}
            formatter={(value) => [String(value), "mentions"]}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.covered ? "#6bcf6b" : "#ff6b6b"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
