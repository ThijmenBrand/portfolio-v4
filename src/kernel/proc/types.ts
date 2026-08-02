export type FaultSite =
  | "main"
  | "window"
  | "interval"
  | "timeout"
  | "signal"
  | "event";

export interface FaultInfo {
  site: FaultSite;
  code?: string;
  message: string;
  at: number;
}
