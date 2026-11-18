/** Display labels shared by server and browser code. */
export const EVENT_LABELS: Record<string, string> = {
  scan_started: "Scan started",
  scan_finished: "Scan finished",
  scan_failed: "Scan failed",
  flag_written: "Product flagged",
  settings_changed: "Settings changed",
  role_changed: "Role changed",
  staff_added: "Staff member added",
  price_list_imported: "Price list imported",
  price_list_check_failed: "Price list check failed",
  price_list_source_changed: "Price list link changed",
  shipping_check_changed: "Shipping profiles need attention",
  shipping_moved_to_freight: "Moved to Freight profile",
  shipping_removed_from_freight: "Removed from Freight profile",
  notification_sent: "Email sent",
};

export const ROLE_LABELS = {
  ANALYST: "Analyst",
  APPROVER: "Approver",
  ADMIN: "Admin",
} as const;
