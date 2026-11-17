/** Display labels shared by server and browser code. */
export const EVENT_LABELS: Record<string, string> = {
  scan_started: "Scan started",
  scan_finished: "Scan finished",
  scan_failed: "Scan failed",
  flag_written: "Product flagged",
  settings_changed: "Settings changed",
  role_changed: "Role changed",
  staff_added: "Staff member added",
};

export const ROLE_LABELS = {
  ANALYST: "Analyst",
  APPROVER: "Approver",
  ADMIN: "Admin",
} as const;
