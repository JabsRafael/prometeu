import { expect, it } from "vitest";
import { gitMarks } from "./tree-git";

const marks = gitMarks([
  { path: "Gemfile", status: "M" },
  { path: "app/models/user.rb", status: "A" },
  { path: "app/models/old.rb", status: "D" },
  { path: "lib/tasks/merge.rake", status: "U" },
  { path: "lib/new.rb", status: "A" },
  { path: "docs/", status: "A" },
]);

it("marks changed files by their own status", () => {
  expect(marks("Gemfile", false)).toBe("M");
  expect(marks("app/models/user.rb", false)).toBe("A");
  expect(marks("README.md", false)).toBeNull();
});

it("gives folders the strongest change below them, with deletions as modifications", () => {
  expect(marks("app", true)).toBe("M");
  expect(marks("app/models", true)).toBe("M");
  expect(marks("lib", true)).toBe("U");
  expect(marks("config", true)).toBeNull();
});

it("treats everything inside an untracked folder as new", () => {
  expect(marks("docs", true)).toBe("A");
  expect(marks("docs/guide/intro.md", false)).toBe("A");
  expect(marks("docsite", true)).toBeNull();
});
