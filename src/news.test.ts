import { beforeEach, describe, expect, it } from "vitest";
import { use } from "./i18n";
import { cmp, localize, parse, unseen, type Release } from "./news";

beforeEach(() => use("en"));

const CHANGELOG = `# Changelog

Changes in Prometeu, release by release, for app users.

## [0.4.8] - 2026-08-31

### New

- **files:** Edit and save the open file without asking the agent

### Fixes

- **chat:** Messages no longer get stuck when resuming a tab

## [0.4.7] - 2026-08-30

### Fixes

- **toolbar:** Simplify the header

## [0.1.0] - 2026-08-01

### New

- Initial release
`;

describe("parse", () => {
  it("parses one release per section from newest to oldest", () => {
    const all = parse(CHANGELOG);
    expect(all.map((r) => r.version)).toEqual(["0.4.8", "0.4.7", "0.1.0"]);
    expect(all[0].date).toBe("2026-08-31");
    expect(all[0].body).toContain("### New");
    expect(all[0].body).toContain("Messages no longer get stuck");
    // A release body ends at the next release heading.
    expect(all[0].body).not.toContain("Simplify the header");
  });

  it("does not treat the file preamble as a release", () => {
    expect(parse(CHANGELOG).some((r) => r.body.includes("release by release"))).toBe(false);
  });

  it("handles empty files", () => {
    expect(parse("")).toEqual([]);
    expect(parse("# Changelog\n\nnothing here\n")).toEqual([]);
  });

  it("accepts releases without dates", () => {
    const [one] = parse("## [0.5.0]\n\n### New\n\n- something\n");
    expect(one).toMatchObject({ version: "0.5.0", date: "" });
  });
});

describe("cmp", () => {
  it("orders versions by their three numeric parts instead of text", () => {
    expect(cmp("0.4.10", "0.4.9")).toBe(1);
    expect(cmp("0.4.9", "0.4.10")).toBe(-1);
    expect(cmp("0.5.0", "0.4.99")).toBe(1);
    expect(cmp("1.0.0", "0.9.9")).toBe(1);
    expect(cmp("0.4.8", "0.4.8")).toBe(0);
  });
});

describe("unseen", () => {
  const all = parse(CHANGELOG);
  const versions = (rs: Release[]) => rs.map((r) => r.version);

  it("counts releases after the last viewed version", () => {
    expect(versions(unseen(all, "0.4.8", "0.4.7"))).toEqual(["0.4.8"]);
    expect(versions(unseen(all, "0.4.8", "0.1.0"))).toEqual(["0.4.8", "0.4.7"]);
  });

  it("counts nothing when up to date", () => {
    expect(unseen(all, "0.4.8", "0.4.8")).toEqual([]);
    // Downgrading below the last viewed version shows no new releases.
    expect(unseen(all, "0.4.7", "0.4.8")).toEqual([]);
  });

  it("shows only the current release without a saved version", () => {
    expect(versions(unseen(all, "0.4.8", null))).toEqual(["0.4.8"]);
    expect(versions(unseen(all, "0.4.7", null))).toEqual(["0.4.7"]);
  });

  it("never counts releases that are not installed yet", () => {
    expect(versions(unseen(all, "0.4.7", "0.1.0"))).toEqual(["0.4.7"]);
  });
});

describe("localize", () => {
  it("preserves unrecognized headings and release content", () => {
    const body = "### Custom heading\n\n- **chat:** Keep this description unchanged.\n";
    expect(localize(body)).toBe(body);
  });

  it("selects only the requested language block in bilingual notes", () => {
    const body = `<!-- lang:pt-BR -->
### Selected section

- First language content
<!-- lang:en -->
### Selected section

- Second language content
<!-- lang:end -->`;
    use("en");
    expect(localize(body)).toBe("### Selected section\n\n- Second language content");
    use("pt-BR");
    expect(localize(body)).toBe("### Selected section\n\n- First language content");
  });
});
