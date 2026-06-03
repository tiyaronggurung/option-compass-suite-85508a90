import type { Signal } from "./signalHelpers";

export type TagId =
  | "Breakout"
  | "VWAP Reclaim"
  | "Volume Spike"
  | "RSI Momentum"
  | "High Risk"
  | "0DTE"
  | "Watchlist";

export const ALL_TAGS: TagId[] = [
  "Breakout",
  "VWAP Reclaim",
  "Volume Spike",
  "RSI Momentum",
  "High Risk",
  "0DTE",
  "Watchlist",
];

interface FlowMetrics { volume_ratio?: number; volume_oi_ratio?: number; }
interface TechMetrics { rsi?: number; above_vwap?: boolean; macd?: string; }

export function deriveTags(signal: Signal, watchlist: Set<string> = new Set()): TagId[] {
  const tags: TagId[] = [];
  const tm = (signal.technical_metrics as TechMetrics) || {};
  const fm = (signal.flow_metrics as FlowMetrics) || {};

  if (signal.confidence >= 80) tags.push("Breakout");
  if (tm.above_vwap === true) tags.push("VWAP Reclaim");
  const volRatio = fm.volume_ratio ?? fm.volume_oi_ratio ?? 0;
  if (volRatio >= 2) tags.push("Volume Spike");
  if (typeof tm.rsi === "number" && (tm.rsi >= 60 || tm.rsi <= 40)) tags.push("RSI Momentum");
  if (signal.risk_level === "HIGH") tags.push("High Risk");
  if (signal.dte === 0) tags.push("0DTE");
  if (watchlist.has(signal.ticker)) tags.push("Watchlist");

  return tags;
}
