import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireStaff } from "../lib/staff.server";
import { formatDateTime, adminProductUrl } from "../lib/format";
import { latestShippingCheck, moveFreightVariants, runShippingCheck } from "../lib/shipping/shipping-check.server";
import type { DriftItem } from "../lib/shipping/drift";

const canMove = (role: string) => role === "ADMIN" || role === "APPROVER";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, staff } = await requireStaff(request);
  return { check: await latestShippingCheck(shop), canMove: canMove(staff.role) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, staff, actor, admin } = await requireStaff(request);
  const intent = String((await request.formData()).get("intent") ?? "");
  try {
    if (intent === "check") {
      const { changed } = await runShippingCheck(shop, "MANUAL", actor, admin);
      return { ok: true as const, message: changed ? "Checked. Something changed since the last check." : "Checked. Nothing changed." };
    }
    if (intent === "add" || intent === "remove") {
      if (!canMove(staff.role)) return { ok: false as const, message: "Only Admins and Approvers can move products." };
      const { moved } = await moveFreightVariants(shop, actor, admin, intent);
      const where = intent === "add" ? "into the freight profile" : "out of the freight profile";
      return { ok: true as const, message: moved ? `Moved ${moved} variants ${where}.` : "Nothing to move; it's already in step." };
    }
    return { ok: false as const, message: "Unknown action." };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/access|scope|denied/i.test(message)) {
      return {
        ok: false as const,
        message: "Shopify refused: the app needs shipping access. Open the app from Shopify admin and approve the updated permissions.",
      };
    }
    return { ok: false as const, message };
  }
};

export default function Shipping() {
  const { check, canMove } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";

  useEffect(() => {
    if (fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  const submit = (intent: string) => fetcher.submit({ intent }, { method: "POST" });
  const loading = (intent: string) => (busyIntent === intent ? { loading: true } : {});

  return (
    <s-page heading="Shipping profiles" inlineSize="large">
      <s-button slot="primary-action" onClick={() => submit("check")} {...loading("check")} {...(busy ? { disabled: true } : {})}>
        Check now
      </s-button>

      <s-section heading="How this works">
        <s-paragraph>
          A product belongs in the <s-text type="strong">US Motor Freight</s-text> shipping profile when its{" "}
          <s-text type="strong">Shipping Method</s-text> is Motor Freight or it’s tagged{" "}
          <s-text type="strong">motorfreight</s-text>. Everything else, including Oversize, uses the other profiles.
          Every morning the app compares this with Shopify and emails you only when there’s something new. The buttons
          below move products only when you click them.
        </s-paragraph>
      </s-section>

      {!check ? (
        <s-section>
          <s-paragraph>No check has run yet. Click “Check now”.</s-paragraph>
        </s-section>
      ) : (
        <>
          <s-section heading={`Summary: ${check.counts.profileName ?? "freight profile not found"}`}>
            <s-stack gap="small-200">
              <s-text color="subdued">
                Last change found {formatDateTime(check.checkedAt)} ({check.trigger === "CRON" ? "daily check" : check.triggeredByName}).
                Last checked {formatDateTime(check.lastSeenAt)}.
              </s-text>
              <s-paragraph>
                {check.counts.variants.toLocaleString("en-US")} variants: {Object.entries(check.counts.byMethod)
                  .map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`)
                  .join(", ")}. {(check.counts.belongInFreight ?? 0).toLocaleString("en-US")} belong in{" "}
                {check.counts.profileName ?? "the freight profile"}; {check.counts.inFreight.toLocaleString("en-US")} are in it now.
              </s-paragraph>
            </s-stack>
          </s-section>

          {check.rateWarnings.length ? (
            <s-banner tone="critical" heading="Freight profile problem">
              <s-unordered-list>
                {check.rateWarnings.map((w) => (
                  <s-list-item key={w}>{w}</s-list-item>
                ))}
              </s-unordered-list>
              <s-paragraph>Fix this in Shopify: Settings → Shipping and delivery → {check.counts.profileName ?? "the freight profile"}.</s-paragraph>
            </s-banner>
          ) : null}

          <ItemSection
            heading="Should be in the freight profile but isn’t"
            empty="Every Motor Freight product is in the freight profile."
            items={check.toAdd}
            action={
              canMove && check.toAdd.length ? (
                <s-button variant="primary" onClick={() => submit("add")} {...loading("add")} {...(busy ? { disabled: true } : {})}>
                  Move {check.toAdd.length} into {check.counts.profileName ?? "freight"}
                </s-button>
              ) : null
            }
          />
          <ItemSection
            heading="In the freight profile but shouldn’t be"
            empty="Everything in the freight profile is Motor Freight."
            items={check.toRemove}
            note="Moving them out sends them back to the General profile. If one should pay freight, set its Shipping Method to Motor Freight or tag it motorfreight instead."
            action={
              canMove && check.toRemove.length ? (
                <s-button onClick={() => submit("remove")} {...loading("remove")} {...(busy ? { disabled: true } : {})}>
                  Move {check.toRemove.length} out of {check.counts.profileName ?? "freight"}
                </s-button>
              ) : null
            }
          />
          {check.notPhysical.length ? (
            <ItemSection
              heading="Motor Freight but marked “not a physical product”"
              items={check.notPhysical}
              note="Shopify charges no shipping for these and can't put them in any profile. In Shopify, open each product and tick “This is a physical product”, then click Check now."
            />
          ) : null}
          {check.protectedProfile.length ? (
            <ItemSection
              heading="Motor Freight but in Shopify Collective"
              items={check.protectedProfile}
              note="Shopify Collective manages these, so the app leaves them alone."
            />
          ) : null}
          {!canMove && (check.toAdd.length || check.toRemove.length) ? (
            <s-section>
              <s-text color="subdued">Only Admins and Approvers can move products.</s-text>
            </s-section>
          ) : null}
        </>
      )}
    </s-page>
  );
}

const SHOW = 200;

function ItemSection({
  heading,
  items,
  empty,
  note,
  action,
}: {
  heading: string;
  items: DriftItem[];
  empty?: string;
  note?: string;
  action?: React.ReactNode;
}) {
  if (!items.length) {
    return empty ? (
      <s-section heading={heading}>
        <s-paragraph>{empty}</s-paragraph>
      </s-section>
    ) : null;
  }
  return (
    <s-section heading={`${heading} (${items.length})`} padding="none">
      <s-box padding="base">
        <s-stack gap="base">
          {note ? <s-paragraph>{note}</s-paragraph> : null}
          {action}
        </s-stack>
      </s-box>
      <s-table>
        <s-table-header-row>
          <s-table-header>Product</s-table-header>
          <s-table-header>Shipping Method</s-table-header>
          <s-table-header>motorfreight tag</s-table-header>
          <s-table-header>Profile now</s-table-header>
          <s-table-header>Shopify</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {items.slice(0, SHOW).map((i) => (
            <s-table-row key={i.variantId}>
              <s-table-cell>{i.title}</s-table-cell>
              <s-table-cell>{i.shippingMethod ?? "Not set"}</s-table-cell>
              <s-table-cell>{i.freightTag ? "Yes" : ""}</s-table-cell>
              <s-table-cell>{i.profileName ?? "None"}</s-table-cell>
              <s-table-cell>
                <s-link href={adminProductUrl(i.productId)} target="_blank">
                  Edit
                </s-link>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      {items.length > SHOW ? (
        <s-box padding="base">
          <s-text color="subdued">Showing the first {SHOW}. The button moves all {items.length}.</s-text>
        </s-box>
      ) : null}
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
