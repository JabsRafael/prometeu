import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  terminals: [] as { output: string; input: (text: string) => void }[],
}));
vi.mock("./ipc", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    output = "";
    input = (_text: string) => {};
    constructor() { fake.terminals.push(this); }
    loadAddon() {}
    open() {}
    onData(input: (text: string) => void) { this.input = input; }
    reset() { this.output = ""; }
    write(text: string) { this.output += text; }
    focus() {}
  },
}));

import * as dock from "./dock";
import { loneCompositionEnds } from "./term";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const bytes = (text: string) => [...new TextEncoder().encode(text)];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  fake.invoke.mockReset();
  dock.detach();
  dock.init(new EventTarget() as HTMLElement, new EventTarget() as HTMLElement);
});

it("keeps terminal input in the current workspace when an earlier open finishes late", async () => {
  const first = deferred<string>();
  fake.invoke.mockImplementation((command, args) => command === "open_dock"
    ? args.id === "first" ? first.promise : Promise.resolve(`${args.id}:${args.kind}`)
    : command === "pty_buffer" ? Promise.resolve(bytes(args.session)) : Promise.resolve());
  const old = dock.open("first", "terminal");
  dock.detach();
  await dock.open("second", "terminal");
  first.resolve("first:terminal");
  await old;

  expect(dock.currentKey("shell")).toBe("second:terminal");
  expect(fake.terminals[1].output).toBe("second:terminal");
  fake.terminals[1].input("pwd\r");
  expect(fake.invoke).toHaveBeenLastCalledWith("pty_write", { session: "second:terminal", data: "pwd\r" });
});

it("discards retained output from an earlier attachment", async () => {
  const first = deferred<number[]>();
  fake.invoke.mockImplementation((command, args) => command === "open_dock"
    ? Promise.resolve(`${args.id}:${args.kind}`)
    : args.session === "first:terminal" ? first.promise : Promise.resolve(bytes(args.session)));
  const old = dock.open("first", "terminal");
  await Promise.resolve();
  await dock.open("second", "terminal");
  first.resolve(bytes("old output"));
  await old;

  expect(fake.terminals[1].output).toBe("second:terminal");
  expect(dock.currentKey("shell")).toBe("second:terminal");
});

it("invalidates pending logs and opens when detaching or closing", async () => {
  const buffer = deferred<number[]>();
  fake.invoke.mockReturnValueOnce(buffer.promise);
  const old = dock.show("first", "run");
  dock.detach();
  buffer.resolve(bytes("old log"));
  await old;
  expect(fake.terminals[0].output).toBe("");

  const opening = deferred<string>();
  fake.invoke.mockImplementation(command => command === "open_dock" ? opening.promise : Promise.resolve());
  const pending = dock.open("first", "terminal");
  await dock.kill("first", "terminal");
  opening.resolve("first:terminal");
  await pending;
  expect(dock.currentKey("shell")).toBeNull();
  expect(fake.terminals[1].output).toBe("");
});

it("keeps script and shell attachment lifecycles independent", async () => {
  const opening = deferred<string>();
  fake.invoke.mockImplementation((command, args) => command === "open_dock"
    ? args.kind === "run" ? opening.promise : Promise.resolve(`${args.id}:${args.kind}`)
    : Promise.resolve(bytes(args.session)));
  const run = dock.open("first", "run");
  await dock.open("first", "terminal");
  opening.resolve("first:run");
  await run;
  expect(dock.currentKey("scripts")).toBe("first:run");
  expect(dock.currentKey("shell")).toBe("first:terminal");
  expect(fake.terminals.map(term => term.output)).toEqual(["first:run", "first:terminal"]);
});

it.each(["open_dock", "pty_buffer"])("detaches input when %s fails", async command => {
  const error = new Error("terminal unavailable");
  fake.invoke.mockImplementation(next => next === command ? Promise.reject(error) : Promise.resolve("first:terminal"));
  await expect(dock.open("first", "terminal")).rejects.toBe(error);
  expect(dock.currentKey("shell")).toBeNull();
  fake.invoke.mockClear();
  fake.terminals[1].input("pwd\r");
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("ignores failed older opens without detaching the current shell", async () => {
  const first = deferred<string>();
  fake.invoke.mockImplementation((command, args) => command === "open_dock"
    ? args.id === "first" ? first.promise : Promise.resolve(`${args.id}:${args.kind}`)
    : Promise.resolve(bytes(args.session)));
  const old = dock.open("first", "terminal");
  await dock.open("second", "terminal");
  first.reject(new Error("old open failed"));
  await old;
  expect(dock.currentKey("shell")).toBe("second:terminal");
  expect(fake.terminals[1].output).toBe("second:terminal");
});

it("drops composition ends that no composition start opened", () => {
  const lone = loneCompositionEnds();
  expect(lone("compositionend")).toBe(true);
  expect(lone("compositionstart")).toBe(false);
  expect(lone("compositionend")).toBe(false);
  expect(lone("compositionend")).toBe(true);
});
