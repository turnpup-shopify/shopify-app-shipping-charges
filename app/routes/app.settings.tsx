import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Role } from "@prisma/client";
import prisma from "../db.server";
import { isAdmin, requireStaff, setRole } from "../lib/staff.server";
import { ROLE_LABELS } from "../lib/labels";
import { getCurrentSettings, lastChangedBy, saveSettings } from "../lib/settings.server";
import type { FreightSettings, FreightTier } from "../lib/freight/settings";
import { formatDateTime } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, staff } = await requireStaff(request);
  const [{ row, settings }, changed, versions, team] = await Promise.all([
    getCurrentSettings(shop),
    lastChangedBy(shop),
    prisma.settingsVersion.findMany({
      where: { shop },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: { id: true, createdAt: true, createdByName: true, reason: true },
    }),
    prisma.staffMember.findMany({ where: { shop }, orderBy: { name: "asc" } }),
  ]);
  return {
    canEdit: isAdmin(staff),
    me: staff.userId,
    versionId: row.id,
    settings,
    changed: Object.fromEntries(
      Object.entries(changed).map(([k, v]) => [k, v && { name: v.name, at: v.at.toISOString(), reason: v.reason }]),
    ) as Record<string, { name: string; at: string; reason: string } | undefined>,
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    team: team.map((t) => ({ userId: t.userId, name: t.name, email: t.email, role: t.role })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, staff, actor } = await requireStaff(request);
  if (!isAdmin(staff)) return { ok: false as const, errors: ["Only an Admin can change settings or roles."] };
  const body = (await request.json()) as
    | { intent: "settings"; settings: FreightSettings; reason: string }
    | { intent: "role"; userId: string; role: Role; reason: string };

  if (body.intent === "role") {
    if (!body.reason?.trim()) return { ok: false as const, errors: ["A reason is required."] };
    if (!["ANALYST", "APPROVER", "ADMIN"].includes(body.role)) return { ok: false as const, errors: ["Unknown role."] };
    try {
      await setRole(shop, actor, body.userId, body.role, body.reason.trim());
      return { ok: true as const, message: "Role updated" };
    } catch (e) {
      return { ok: false as const, errors: [e instanceof Error ? e.message : "Could not change role."] };
    }
  }

  const r = await saveSettings(shop, actor, body.settings, body.reason ?? "");
  return r.ok ? { ok: true as const, message: "Settings saved" } : { ok: false as const, errors: r.errors };
};

// Percent settings are stored as fractions and edited as whole percents.
const PCT_FIELDS: { key: keyof FreightSettings; label: string; help: string }[] = [
  { key: "targetMargin", label: "Target margin (%)", help: "Used to work out the suggested price and surcharge." },
  { key: "flagThreshold", label: "Flag when margin is under (%)", help: "Margin after freight below this is flagged." },
  { key: "criticalThreshold", label: "Critical when margin is under (%)", help: "Margin after freight below this is critical." },
  { key: "maxDiscount", label: "Max discount to test (%)", help: "We check margin at this discount off the price." },
  { key: "repriceMaxIncrease", label: "Suggest reprice up to (%)", help: "Price increases up to this suggest Reprice." },
];

type Draft = Record<string, string> & { overrideIsPerBox: string };

const toDraft = (s: FreightSettings): Draft => ({
  ...Object.fromEntries(PCT_FIELDS.map((f) => [f.key, String(+(Number(s[f.key]) * 100).toFixed(4))])),
  dimDivisor: String(s.dimDivisor),
  surchargeMax: String(s.surchargeMax),
  overrideIsPerBox: s.overrideIsPerBox ? "1" : "",
});

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  // Remount the form whenever a new settings version is saved, so it shows
  // the saved values and an empty reason.
  return <SettingsForm key={data.versionId} {...data} />;
}

function SettingsForm({
  canEdit,
  settings,
  changed,
  versions,
  team,
  versionId,
  me,
}: ReturnType<typeof useLoaderData<typeof loader>>) {
  const fetcher = useFetcher<typeof action>({ key: "settings-save" });
  const shopify = useAppBridge();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [tiers, setTiers] = useState<FreightTier[]>(settings.tiers);
  const [reason, setReason] = useState("");
  const [roleReason, setRoleReason] = useState("");

  useEffect(() => {
    if (!fetcher.data) return;
    // A successful save creates a new settings version, which remounts the
    // form (see the key below) and clears the reason.
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);

  const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;
  const num = (s: string | number | null) => (s === "" || s == null ? null : Number(s));

  const save = () => {
    const next: FreightSettings = {
      targetMargin: Number(draft.targetMargin) / 100,
      flagThreshold: Number(draft.flagThreshold) / 100,
      criticalThreshold: Number(draft.criticalThreshold) / 100,
      maxDiscount: Number(draft.maxDiscount) / 100,
      repriceMaxIncrease: Number(draft.repriceMaxIncrease) / 100,
      dimDivisor: Number(draft.dimDivisor),
      surchargeMax: Number(draft.surchargeMax),
      overrideIsPerBox: draft.overrideIsPerBox === "1",
      tiers: tiers.map((t) => ({
        ...t,
        cost: Number(t.cost),
        maxSize: num(t.maxSize),
        maxBillableWeight: num(t.maxBillableWeight),
        maxLongestSide: num(t.maxLongestSide),
      })),
    };
    fetcher.submit({ intent: "settings", settings: next, reason } as never, {
      method: "POST",
      encType: "application/json",
    });
  };

  const who = (key: string) => {
    const c = changed[key];
    return c ? `Last changed by ${c.name}, ${formatDateTime(c.at)}: “${c.reason}”` : "";
  };
  const errors = fetcher.data && !fetcher.data.ok ? fetcher.data.errors : [];
  const editTier = (i: number, patch: Partial<FreightTier>) =>
    setTiers((ts) => ts.map((t, j) => (j === i ? ({ ...t, ...patch } as FreightTier) : t)));

  return (
    <s-page heading="Settings">
      {canEdit ? (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={save}
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          {...(!reason.trim() ? { disabled: true } : {})}
        >
          Save settings
        </s-button>
      ) : null}

      {!canEdit ? (
        <s-banner tone="info" heading="View only">
          <s-paragraph>Only an Admin can change settings. Everyone can see them.</s-paragraph>
        </s-banner>
      ) : null}
      {errors.length ? (
        <s-banner tone="critical" heading="Not saved">
          <s-unordered-list>
            {errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      ) : null}

      <s-section heading={`Margin rules (version ${versionId})`}>
        <s-stack gap="base">
          {PCT_FIELDS.map((f) => (
            <s-number-field
              key={f.key}
              label={f.label}
              value={draft[f.key]}
              details={[f.help, who(f.key)].filter(Boolean).join(" ")}
              suffix="%"
              {...(!canEdit ? { readOnly: true } : {})}
              onInput={(e) => setDraft({ ...draft, [f.key]: val(e) })}
            />
          ))}
          <s-number-field
            label="Suggest surcharge up to ($)"
            value={draft.surchargeMax}
            prefix="$"
            details={["Surcharges up to this suggest Freight surcharge.", who("surchargeMax")].filter(Boolean).join(" ")}
            {...(!canEdit ? { readOnly: true } : {})}
            onInput={(e) => setDraft({ ...draft, surchargeMax: val(e) })}
          />
        </s-stack>
      </s-section>

      <s-section heading="Freight model">
        <s-stack gap="base">
          <s-number-field
            label="Dimensional weight divisor"
            value={draft.dimDivisor}
            details={["Dimensional weight = L × W × H ÷ this number.", who("dimDivisor")].filter(Boolean).join(" ")}
            {...(!canEdit ? { readOnly: true } : {})}
            onInput={(e) => setDraft({ ...draft, dimDivisor: val(e) })}
          />
          <s-switch
            label="Manual freight override is per box (multiply by box count)"
            checked={draft.overrideIsPerBox === "1"}
            details={["When off, freight.override_cost is the total for one unit.", who("overrideIsPerBox")].filter(Boolean).join(" ")}
            {...(!canEdit ? { disabled: true } : {})}
            onChange={(e) => setDraft({ ...draft, overrideIsPerBox: (e.currentTarget as unknown as { checked: boolean }).checked ? "1" : "" })}
          />
          <s-paragraph>
            Tiers are checked from top to bottom. A box goes in the first tier where it is at or under every limit. The
            last tier catches everything else. Freight is the tier cost × box count. {who("tiers")}
          </s-paragraph>
          {tiers.map((t, i) => {
            const last = i === tiers.length - 1;
            return (
              <s-box key={t.key} padding="base" borderWidth="base" borderRadius="base">
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
                  <s-text-field label="Tier name" value={t.name} {...(!canEdit ? { readOnly: true } : {})} onInput={(e) => editTier(i, { name: val(e) })} />
                  <s-number-field label="Cost per box ($)" value={String(t.cost)} {...(!canEdit ? { readOnly: true } : {})} onInput={(e) => editTier(i, { cost: val(e) as unknown as number })} />
                  {last ? (
                    <s-text color="subdued">Catch-all: anything over the limits above.</s-text>
                  ) : (
                    <>
                      <s-number-field label="Max size (in)" value={t.maxSize == null ? "" : String(t.maxSize)} {...(!canEdit ? { readOnly: true } : {})} onInput={(e) => editTier(i, { maxSize: val(e) as unknown as number })} />
                      <s-number-field label="Max billable weight (lb)" value={t.maxBillableWeight == null ? "" : String(t.maxBillableWeight)} {...(!canEdit ? { readOnly: true } : {})} onInput={(e) => editTier(i, { maxBillableWeight: val(e) as unknown as number })} />
                      <s-number-field label="Max longest side (in)" value={t.maxLongestSide == null ? "" : String(t.maxLongestSide)} {...(!canEdit ? { readOnly: true } : {})} onInput={(e) => editTier(i, { maxLongestSide: val(e) as unknown as number })} />
                    </>
                  )}
                </s-grid>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      {canEdit ? (
        <s-section heading="Reason for this change">
          <s-text-area
            label="Reason (required)"
            value={reason}
            rows={2}
            details="Saved with the new settings version and in the activity log."
            onInput={(e) => setReason(val(e))}
          />
        </s-section>
      ) : null}

      <s-section heading="Team and roles">
        <s-paragraph>
          In Phase 1, everyone can view everything and only Admins can change settings. Approver is reserved for Phase 2.
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header>Name</s-table-header>
            <s-table-header>Email</s-table-header>
            <s-table-header>Role</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {team.map((t) => (
              <s-table-row key={t.userId}>
                <s-table-cell>{t.name}{t.userId === me ? " (you)" : ""}</s-table-cell>
                <s-table-cell>{t.email ?? ""}</s-table-cell>
                <s-table-cell>
                  {canEdit ? (
                    <s-select
                      label="Role"
                      labelAccessibilityVisibility="exclusive"
                      value={t.role}
                      {...(!roleReason.trim() ? { disabled: true } : {})}
                      onChange={(e) =>
                        fetcher.submit({ intent: "role", userId: t.userId, role: val(e), reason: roleReason } as never, {
                          method: "POST",
                          encType: "application/json",
                        })
                      }
                    >
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <s-option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </s-option>
                      ))}
                    </s-select>
                  ) : (
                    ROLE_LABELS[t.role]
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {canEdit ? (
          <s-box paddingBlockStart="base">
            <s-text-field
              label="Reason for a role change (required before changing a role)"
              value={roleReason}
              onInput={(e) => setRoleReason(val(e))}
            />
          </s-box>
        ) : null}
        <s-box paddingBlockStart="base">
          <s-text color="subdued">People appear here the first time they open the app.</s-text>
        </s-box>
      </s-section>

      <s-section heading="Settings history" slot="aside">
        <s-stack gap="base">
          {versions.map((v) => (
            <s-stack key={v.id} gap="none">
              <s-text type="strong">Version {v.id}</s-text>
              <s-text color="subdued">
                {v.createdByName}, {formatDateTime(v.createdAt)}
              </s-text>
              <s-text>{v.reason}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
