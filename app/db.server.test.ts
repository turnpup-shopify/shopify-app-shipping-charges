import { describe, expect, it } from "vitest";
import { withConnectionTimeouts } from "./db.server";

describe("withConnectionTimeouts", () => {
  it("adds 30s timeouts and keeps existing params", () => {
    const out = withConnectionTimeouts("postgres://u:p@pooled.db.prisma.io:5432/postgres?sslmode=require");
    const params = new URL(out!).searchParams;
    expect(params.get("sslmode")).toBe("require");
    expect(params.get("connect_timeout")).toBe("30");
    expect(params.get("pool_timeout")).toBe("30");
  });

  it("works with no query string", () => {
    expect(withConnectionTimeouts("postgres://h/db")).toBe("postgres://h/db?connect_timeout=30&pool_timeout=30");
  });

  it("does not override values already in the URL", () => {
    const out = withConnectionTimeouts("postgres://h/db?connect_timeout=5");
    expect(new URL(out!).searchParams.get("connect_timeout")).toBe("5");
  });

  it("passes through a missing URL", () => {
    expect(withConnectionTimeouts(undefined)).toBeUndefined();
  });
});
