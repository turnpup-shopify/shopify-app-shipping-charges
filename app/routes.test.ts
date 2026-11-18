import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * On Vercel, a route that exports `config` is built into its own server bundle.
 * React Router's route discovery (/__manifest) runs in the main bundle and
 * can't see those routes, so client-side links to them show "404 Not Found".
 * Only API and webhook routes, which are never linked to from the app's
 * screens, may export `config`. Fluid compute (vercel.json) already gives every
 * function 300 seconds.
 */
describe("route config", () => {
  const dir = join(__dirname, "routes");
  const screens = readdirSync(dir).filter((f) => /^app[._].*\.tsx$/.test(f) || f === "app.tsx");

  it.each(screens)("%s does not export config", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    expect(src).not.toMatch(/export\s+const\s+config\b/);
  });

  it("vercel.json turns on Fluid compute", () => {
    const vercel = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf8"));
    expect(vercel.fluid).toBe(true);
  });
});
