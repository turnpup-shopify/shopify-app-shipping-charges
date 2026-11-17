import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", null]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n',
    );
  });
  it("neutralises spreadsheet formulas but keeps negative numbers", () => {
    expect(toCsv(["v"], [["=SUM(A1)"], [-59], ["-18.0%"]])).toBe("v\r\n'=SUM(A1)\r\n-59\r\n-18.0%\r\n");
  });
});
