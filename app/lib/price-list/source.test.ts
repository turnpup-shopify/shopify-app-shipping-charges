import { describe, expect, it } from "vitest";
import { DEFAULT_PRICE_LIST_URL, fileNameFromUrl, looksLikeXlsx, PriceListUrlError, toDownloadUrl } from "./source";

const FILE =
  "https://www.dropbox.com/scl/fo/abc/XYZ/Uttermost%20Price%20List.xlsx?rlkey=key123&e=3&utm_medium=email&_hsenc=zzz&dl=0";

describe("toDownloadUrl", () => {
  it("keeps rlkey, sets dl=1 and drops tracking parameters", () => {
    expect(toDownloadUrl(FILE)).toBe(
      "https://www.dropbox.com/scl/fo/abc/XYZ/Uttermost%20Price%20List.xlsx?rlkey=key123&dl=1",
    );
  });
  it("accepts the default link", () => {
    expect(toDownloadUrl(DEFAULT_PRICE_LIST_URL)).toMatch(/Uttermost%20Price%20List\.xlsx\?rlkey=.+&dl=1$/);
  });
  it("rejects folder links", () => {
    expect(() => toDownloadUrl("https://www.dropbox.com/scl/fo/abc/XYZ?rlkey=k&dl=0")).toThrow(PriceListUrlError);
  });
  it("rejects other sites and junk", () => {
    expect(() => toDownloadUrl("https://example.com/file.xlsx")).toThrow(PriceListUrlError);
    expect(() => toDownloadUrl("not a link")).toThrow(PriceListUrlError);
  });
});

describe("fileNameFromUrl", () => {
  it("decodes the last path part", () => {
    expect(fileNameFromUrl(FILE)).toBe("Uttermost Price List.xlsx");
  });
});

describe("looksLikeXlsx", () => {
  it("spots the zip header", () => {
    expect(looksLikeXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(looksLikeXlsx(new TextEncoder().encode("<!DOCTYPE html>"))).toBe(false);
  });
});
