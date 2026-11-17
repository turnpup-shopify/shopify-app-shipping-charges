import type { ReceiptLine } from "../lib/freight/engine";
import { Explain } from "./Explain";

/** The math card. Reads top to bottom like a receipt; every value is clickable. */
export function Receipt({ lines, warnings }: { lines: ReceiptLine[]; warnings?: string[] }) {
  return (
    <s-stack gap="small-200">
      {warnings?.length ? (
        <s-banner tone="warning" heading="Check these inputs">
          <s-unordered-list>
            {warnings.map((w) => (
              <s-list-item key={w}>{w}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      ) : null}
      {lines.map((l) => (
        <s-stack key={l.key} gap="small-300">
          {l.emphasis === "total" ? <s-divider /> : null}
          <s-grid gridTemplateColumns="1fr auto" alignItems="center" gap="base">
            <s-stack gap="none">
              <s-text type={l.emphasis === "total" ? "strong" : "generic"}>{l.label}</s-text>
              <s-text color="subdued">{l.how}</s-text>
            </s-stack>
            <Explain
              value={l.value}
              how={l.how}
              label={l.label}
              tone={l.emphasis === "bad" ? "critical" : undefined}
            />
          </s-grid>
        </s-stack>
      ))}
    </s-stack>
  );
}
