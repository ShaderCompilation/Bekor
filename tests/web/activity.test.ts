import { describe, expect, it } from "vitest";
import { addDays, heatmap, localDate, streaks } from "../../apps/web/src/activity";
import { resolveTheme } from "../../apps/web/src/stores/preferences";

const day = (date: string, attempts = 1, solved = 0) => ({ date, attempts, solved });

describe("activity helpers", () => {
  it("formats local calendar dates in the user's timezone", () => {
    const instant = new Date("2026-10-28T03:00:00.000Z");
    expect(localDate(instant, "UTC")).toBe("2026-10-28");
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-10-27");
    expect(localDate(instant, "Asia/Tokyo")).toBe("2026-10-28");
  });

  it("adds days across month, year and DST boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("counts the current streak through today or, before today's first attempt, yesterday", () => {
    const activity = [day("2026-10-20"), day("2026-10-25"), day("2026-10-26"), day("2026-10-27")];
    expect(streaks(activity, "2026-10-27")).toEqual({ current: 3, longest: 3, activeDays: 4 });
    expect(streaks(activity, "2026-10-28").current).toBe(3);
    expect(streaks(activity, "2026-10-29").current).toBe(0);
    expect(streaks([], "2026-10-28")).toEqual({ current: 0, longest: 0, activeDays: 0 });
    expect(streaks([day("2026-10-28", 0)], "2026-10-28").current).toBe(0);
  });

  it("finds the longest run anywhere in the year", () => {
    const run = ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"].map((date) => day(date));
    expect(streaks([...run, day("2026-10-28")], "2026-10-28")).toMatchObject({
      current: 1,
      longest: 4,
    });
  });

  it("builds Sunday-first weekly columns ending with today's week", () => {
    // 2026-10-28 is a Wednesday.
    const grid = heatmap([day("2026-10-28", 8, 2), day("2026-10-26", 2)], "2026-10-28", 3);
    expect(grid).toHaveLength(3);
    for (const column of grid) expect(column).toHaveLength(7);
    expect(grid[0]?.[0]?.date).toBe("2026-10-11");
    const last = grid[2] ?? [];
    expect(last[0]?.date).toBe("2026-10-25");
    expect(last[3]).toMatchObject({ date: "2026-10-28", attempts: 8, solved: 2, level: 4 });
    expect(last[1]).toMatchObject({ date: "2026-10-26", level: 1 });
    expect(last[4]?.future).toBe(true);
    expect(last[3]?.future).toBe(false);
  });
});

describe("theme resolution", () => {
  it("follows the system only for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
