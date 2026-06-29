"use client";

import { C } from "@/lib/console/theme";
import { fmtKor } from "@/lib/console/format";

/* SVG chart helpers ported from the "수익 콘솔" HTML inline SVG. */

function pathFrom(xs: number[], ys: number[]): string {
  return "M" + xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" L");
}

/** Hero revenue sparkline (area + line + end dot). */
export function Sparkline({ values, color = C.violet }: { values: number[]; color?: string }) {
  const W = 300,
    H = 130;
  const max = Math.max(...values) * 1.05,
    min = Math.min(...values) * 0.9;
  const span = max - min || 1;
  const xs = values.map((_, i) => 6 + (i * 288) / (values.length - 1));
  const ys = values.map((v) => 118 - ((v - min) / span) * 100);
  const line = pathFrom(xs, ys);
  const area = `M${xs[0].toFixed(1)} 130 L${xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" L")} L${xs[xs.length - 1].toFixed(1)} 130 Z`;
  return (
    <svg viewBox="0 0 300 130" style={{ width: "100%", height: "100%", overflow: "visible" }}>
      <path d={area} fill={color} opacity={0.06} />
      <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={4} fill={color} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={8} fill={color} opacity={0.16} />
    </svg>
  );
}

/** Channel-detail subscriber growth line with per-point value + month labels. */
export function GrowthLine({ values, months, color = C.violet }: { values: number[]; months: string[]; color?: string }) {
  const W = 520,
    H = 150,
    pT = 20,
    pB = 22,
    pL = 22,
    pR = 22;
  const max = Math.max(...values) * 1.04,
    min = Math.min(...values) * 0.94;
  const span = max - min || 1;
  const xs = values.map((_, i) => pL + (i * (W - pL - pR)) / (values.length - 1));
  const ys = values.map((v) => H - pB - ((v - min) / span) * (H - pB - pT));
  const line = pathFrom(xs, ys);
  const area = `M${xs[0].toFixed(1)} ${H - pB} L${xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" L")} L${xs[xs.length - 1].toFixed(1)} ${H - pB} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <path d={area} fill={color} opacity={0.07} />
      <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      {values.map((v, i) => (
        <g key={i}>
          <circle cx={xs[i]} cy={ys[i]} r={3} fill={color} />
          <text x={xs[i]} y={ys[i] - 9} textAnchor="middle" fontSize={9} fontWeight={700} fill={color}>
            {fmtKor(v)}
          </text>
          <text x={xs[i]} y={H - 6} textAnchor="middle" fontSize={8.5} fill={C.faint}>
            {months[i]}
          </text>
        </g>
      ))}
    </svg>
  );
}
