"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  CartesianGrid,
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
    <div style={{ width: "100%", height: Math.max(220, data.length * 28) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke="#1A1F2E" />
          <XAxis
            type="number"
            tick={{ fill: "#8B93A7", fontSize: 11 }}
            axisLine={{ stroke: "#1A1F2E" }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={150}
            tick={{ fill: "#8B93A7", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#0D111D",
              border: "1px solid #1A1F2E",
              borderRadius: 8,
              fontSize: 12,
              color: "#F5F7FA",
            }}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ""}
            formatter={(value) => [String(value), "mentions"]}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.covered ? "#14BA82" : "#EE4542"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
