# Checkout freight charge

Status: approved 2026-11-17. Native shipping profiles, with amounts edited by hand in Shopify admin
(not in the app). Amounts and thresholds not yet set. Docs checked 2026-11-17.

## What we want

| Cart contains | Freight fee |
| --- | --- |
| Only `Small Parcel` products | **$0** (free shipping) |
| One or more `Oversize` or `Motor Freight` products | **One flat fee per order**, picked by order total after discounts |

The fee is charged once per order, however many Oversize or Motor Freight items are in the cart.
The dollar amounts and order-total thresholds are not decided yet, so they stay configurable.

### Rules table (fill in)

| Order total after discounts | Fee when cart has an Oversize or Motor Freight item |
| --- | --- |
| $0 to $____ | $____ (about $100) |
| $____ and up | $____ (about $200) |

## Product marker

Product metafield "Shipping Method" (definition exists in the store, checked 2026-11-17).
One value per product. Use these exact spellings:

| Field | Value |
| --- | --- |
| Namespace and key | `custom.shipping_method` |
| Type | Single line text, limited to preset choices |
| Choices | `Small Parcel`, `Oversize`, `Motor Freight` |

Pick the value from confirmed shipping requirements. If the method isn't confirmed, leave it blank
and flag the product for review. Blank products stay in the General profile, so they ship free
until someone sets a value.

The definition's "Filter products in admin" option is currently **off**. Turn it on so the product
list can be filtered by Shipping Method when checking the Freight profile.

Products are added to the Freight profile **by hand**: in the profile, Add products and search each
one by name. The picker can't browse collections or filter by metafield, so a helper collection
doesn't help.

## Approach: native shipping profiles

HTGT is on the **Basic** plan. Native profiles are the only option that works on Basic with no new
app code and no plan change.

1. **General profile** (all normal products): one rate, "Free shipping", $0.
2. **New profile "Freight"** (one profile only): every product whose `custom.shipping_method` is
   `Oversize` or `Motor Freight`. One rate per row of the rules table, using price-based conditions
   (min/max order price).

When a cart has items from both profiles, Shopify charges each profile's rate and adds them.
General is always $0, so the customer pays exactly one Freight fee per order. That gives the
"once per order" rule.

The amounts are changed in **Settings → Shipping and delivery → Freight profile**. That is where they
are configurable, with no deploy.

### Limits to know

- **Profiles can't read metafields.** Products must be added to the Freight profile by hand (or by
  bulk select in the admin). A product marked `Oversize` but left in General ships free. See "How
  the app helps" below.
- **Price condition looks only at the Freight profile's items.** Shopify evaluates a profile's
  price-based rate on the items in that profile, not the whole cart. So a $300 oversize chair plus a
  $3,000 rug is priced on the $300, not $3,300. If the threshold must use the whole order total,
  native profiles can't do it exactly. Check this in a test checkout before going live.
- **Discounts.** Check in a test checkout that the price condition uses the total after discounts.
- **Oversize and Motor Freight pay the same fee.** If they ever need different fees, they would go in
  two profiles, and a cart with both would pay both fees, which breaks "once per order".
- **Shopify Collective profile.** The store has a second profile, "Shopify Collective" (500 variants).
  Products in it keep their own rates and aren't covered by these rules.

## Options ruled out

| Option | Why not |
| --- | --- |
| Carrier service callback in this app | Needs the `write_shipping` scope (beyond Phase 1). Shopify only allows it on Advanced or higher, the Shopify plan with yearly billing, or a paid add-on via Support. HTGT is on Basic. It would compute the exact rule (whole-cart total, any metafield) if the store upgrades. |
| Shopify Functions | Delivery customization can only hide, rename or reorder rates. The only functions that set a price are local pickup and pickup point generators, which don't apply. Also, custom apps with functions only run on Shopify Plus. |

## How it fits with Phase 1 (read only)

The app writes nothing. Shipping rates and profile membership are set by hand in the admin.

How the app helps, read only:
- Add `custom.shipping_method` to the products the scan reads.
- Add a **Data health** check: products marked `Oversize` or `Motor Freight` that aren't in the
  Freight profile, products in the Freight profile marked `Small Parcel` or blank, and products with
  no Shipping Method at all (the "flag for review" list). This needs the `read_shipping`
  scope (read only, allowed in Phase 1).
- Optionally show the Freight profile's current rates on the Settings screen, so the freight margin
  math can use what the customer actually pays.

If the team later wants to edit the amounts **inside the app** and have the app push them to the
Freight profile, that needs `write_shipping` (works on Basic for profiles; only carrier services need
Advanced). **Decided 2026-11-17: not now.** Amounts stay in Shopify admin; revisit in Phase 2.

## Next steps

1. Turn on "Filter products in admin" for `custom.shipping_method`, then set it on every product
   whose shipping method is confirmed. Leave the rest blank and flag them for review.
2. Create the Freight profile, add those products, and set the rates once the amounts are decided.
3. Place test orders: freight only, parcel only, mixed, with a discount code, and above and below
   each threshold.
4. Build the app's read-only checks above.
