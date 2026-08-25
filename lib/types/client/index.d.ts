/**
 * dsh-peak-gate — browser half types.
 */

/** Wall-clock window of one peak billing period (start/end "HH:mm", Beijing time). */
export interface PeakWindow {
  start: string;
  end: string;
}

/** Plugin settings (persisted to localStorage). */
export interface PeakGateSettings {
  /** Master switch: when false the gate never intercepts. */
  enabled: boolean;
  /** IANA timezone used for the pricing clock (default "Asia/Shanghai"). */
  timezone: string;
  /** Peak windows applied on weekdays (default 09:00-12:00 / 14:00-18:00). */
  peakWindows: PeakWindow[];
  /** Weekends are billed at off-peak price all day (DeepSeek policy). */
  offPeakWeekends: boolean;
  /** Ask at most once per session per day (both choices consume the question). */
  askOncePerDay: boolean;
}

export declare const inject: string[];
export declare function apply(ctx: unknown): void;
