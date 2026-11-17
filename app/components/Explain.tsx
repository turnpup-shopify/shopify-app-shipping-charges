import { useId } from "react";

/**
 * A number you can click to see how it was worked out. Uses Polaris
 * components only, so it follows the admin's light or dark theme.
 */
export function Explain({
  value,
  how,
  label,
  tone,
}: {
  value: string;
  how: string;
  label?: string;
  tone?: "critical" | "success";
}) {
  const id = `explain-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  return (
    <>
      <s-button
        variant="tertiary"
        commandFor={id}
        accessibilityLabel={`${label ?? value}: show how this was worked out`}
        {...(tone === "critical" ? { tone: "critical" } : {})}
      >
        {value}
      </s-button>
      <s-popover id={id} maxInlineSize="380px">
        <s-box padding="base">
          <s-stack gap="small-200">
            {label ? <s-heading>{label}</s-heading> : null}
            <s-paragraph>{how}</s-paragraph>
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}
