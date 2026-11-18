/**
 * Builds the daily notification email. Pure, so it can be tested.
 */
import type { CheckResult } from "./price-list/price-list.server";
import type { Drift, DriftItem } from "./shipping/drift";
import type { Email } from "./notify.server";

export interface DailyInput {
  shop: string;
  appUrl: (path: string) => string;
  priceList: CheckResult;
  shipping: { changed: boolean; drift: Drift } | { error: string };
}

const LIST_LIMIT = 15;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Null when nothing is worth an email. */
export function buildDailyEmail(input: DailyInput): Email | null {
  const sections: Array<{ heading: string; lines: string[]; link?: { label: string; href: string } }> = [];

  const pl = input.priceList;
  if (pl.status === "imported") {
    sections.push({
      heading: "New Uttermost price list",
      lines: [`Imported ${pl.rowCount.toLocaleString("en-US")} items as version ${pl.importId}.`],
      link: { label: "Open the price list", href: input.appUrl("/app/price-list") },
    });
  } else if (pl.status === "failed") {
    sections.push({
      heading: "Uttermost price list check failed",
      lines: [pl.error],
      link: { label: "Open the price list", href: input.appUrl("/app/price-list") },
    });
  }

  const sh = input.shipping;
  if ("error" in sh) {
    sections.push({
      heading: "Shipping profile check failed",
      lines: [sh.error],
      link: { label: "Open shipping profiles", href: input.appUrl("/app/shipping") },
    });
  } else if (sh.changed) {
    const d = sh.drift;
    const lines: string[] = [];
    const list = (label: string, items: DriftItem[]) => {
      if (!items.length) return;
      lines.push(`${label}: ${items.length}`);
      for (const i of items.slice(0, LIST_LIMIT)) lines.push(`  • ${i.title}${i.shippingMethod ? ` (${i.shippingMethod})` : ""}`);
      if (items.length > LIST_LIMIT) lines.push(`  • …and ${items.length - LIST_LIMIT} more`);
    };
    list("Tagged Oversize or Motor Freight but not in the Freight profile", d.toAdd);
    list("In the Freight profile but not tagged Oversize or Motor Freight", d.toRemove);
    list("Tagged for freight but marked as not a physical product (ships with no charge)", d.notPhysical);
    list("Tagged for freight but in Shopify Collective (left alone)", d.protectedProfile);
    for (const w of d.rateWarnings) lines.push(`Rate problem: ${w}`);
    if (lines.length) {
      sections.push({
        heading: "Shipping profiles need attention",
        lines,
        link: { label: "Review and fix in one click", href: input.appUrl("/app/shipping") },
      });
    }
  }

  if (sections.length === 0) return null;

  const subject =
    sections.length === 1
      ? `Freight Margin Guard: ${sections[0].heading}`
      : `Freight Margin Guard: ${sections.length} things need a look`;

  const text = [
    ...sections.flatMap((s) => [s.heading, ...s.lines, ...(s.link ? [`${s.link.label}: ${s.link.href}`] : []), ""]),
    `Store: ${input.shop}`,
  ].join("\n");

  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">`,
    ...sections.map(
      (s) =>
        `<h2 style="font-size:16px;margin:16px 0 4px">${esc(s.heading)}</h2>` +
        `<div style="white-space:pre-wrap">${esc(s.lines.join("\n"))}</div>` +
        (s.link ? `<p><a href="${esc(s.link.href)}">${esc(s.link.label)}</a></p>` : ""),
    ),
    `<p style="color:#666;font-size:12px">Store: ${esc(input.shop)}. Sent by Freight Margin Guard's daily check. You only get this email when something changed.</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/** Link into the embedded app in Shopify admin. */
export function adminAppUrl(shop: string, path: string, appHandle = process.env.SHOPIFY_APP_HANDLE || "freight-margin-guard") {
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/apps/${appHandle}${path.replace(/^\/app/, "/app")}`;
}
