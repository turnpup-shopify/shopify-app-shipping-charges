/**
 * Dropbox shared-link handling. Pure functions, no network.
 */

/** The link HTGT was given for the Summer 26 folder's price list file. */
export const DEFAULT_PRICE_LIST_URL =
  "https://www.dropbox.com/scl/fo/efv1ssr4k9sgpm1fihedc/AP18GZf1m4-v4vFHpqfCuck/Uttermost%20Price%20List.xlsx?rlkey=lcttjlnm8ivea8bx8ol105fqu&dl=0";

/** Older imported versions beyond this many are deleted, with their items. */
export const KEEP_VERSIONS = 6;

export class PriceListUrlError extends Error {}

const DROPBOX_HOSTS = new Set(["www.dropbox.com", "dropbox.com"]);

/**
 * Turns a pasted Dropbox share link into a direct-download link.
 * Keeps only `rlkey` (needed for access) and sets `dl=1`. Drops email
 * tracking parameters. Rejects folder links, because a folder link downloads
 * the whole folder instead of the one file.
 */
export function toDownloadUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new PriceListUrlError("That isn't a valid link.");
  }
  if (url.protocol !== "https:" || !DROPBOX_HOSTS.has(url.hostname)) {
    throw new PriceListUrlError("Use a Dropbox share link (https://www.dropbox.com/…).");
  }
  if (!/\.xlsx$/i.test(decodeURIComponent(url.pathname))) {
    throw new PriceListUrlError(
      "That looks like a folder link. Open the folder in Dropbox, click the price list file, and copy the link to the file itself (it ends in .xlsx).",
    );
  }
  const out = new URL(`https://www.dropbox.com${url.pathname}`);
  const rlkey = url.searchParams.get("rlkey");
  if (rlkey) out.searchParams.set("rlkey", rlkey);
  out.searchParams.set("dl", "1");
  return out.toString();
}

/** The file name at the end of a Dropbox link, e.g. "Uttermost Price List.xlsx". */
export function fileNameFromUrl(input: string): string {
  const path = new URL(input).pathname;
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "price-list.xlsx";
}

/** True when the bytes start like a zip file, which every .xlsx is. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
