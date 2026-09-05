import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/viewerDialog.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const listeners = new Map();
  const document = {
    activeElement: undefined,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  class Element {
    constructor(parent, tabIndex = -1) {
      this.children = [];
      this.parentElement = parent;
      this.tabIndex = tabIndex;
      this.inert = false;
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      this.style = {};
      parent?.children.push(this);
    }
    setAttribute(name, value) { if (name === "tabindex") this.tabIndex = Number(value); }
    focus() { document.activeElement = this; }
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
    matches() { return this.disabled; }
    closest(selector) { return (this.inert || (selector.includes("hidden") && this.hidden)) ? this : this.parentElement?.closest(selector); }
    getClientRects() { return this.hidden ? [] : [{}]; }
  }
  document.body = new Element();
  const background = new Element(document.body);
  const origin = new Element(background, 0);
  const backdrop = new Element(document.body);
  const dialog = new Element(backdrop);
  const first = new Element(dialog, 0);
  const disabled = new Element(dialog, 0);
  disabled.disabled = true;
  const hidden = new Element(dialog, 0);
  hidden.hidden = true;
  const last = new Element(dialog, 0);
  document.activeElement = origin;
  document.body.style.overflow = "auto";
  const module = { exports: {} };
  vm.runInNewContext(code, { document, HTMLElement: Element, Node: Element, module, exports: module.exports });
  const press = (shiftKey = false) => {
    const event = { key: "Tab", shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    listeners.get("keydown")?.(event);
    return event.defaultPrevented;
  };
  return { document, Element, background, backdrop, dialog, origin, first, last, listeners, press, activate: module.exports.activateViewerDialog };
}

test("viewer takes focus, isolates background, wraps Tab and restores previous focus", () => {
  const h = harness();
  const cleanup = h.activate(h.dialog);
  assert.equal(h.document.activeElement, h.dialog);
  assert.equal(h.background.inert, true);
  assert.equal(h.document.body.style.overflow, "hidden");
  h.first.focus();
  assert.equal(h.press(true), true);
  assert.equal(h.document.activeElement, h.last);
  assert.equal(h.press(false), true);
  assert.equal(h.document.activeElement, h.first);
  cleanup();
  assert.equal(h.background.inert, false);
  assert.equal(h.document.body.style.overflow, "auto");
  assert.equal(h.document.activeElement, h.origin);
  assert.equal(h.listeners.size, 0);
});

test("a nested sibling dialog isolates the viewer without disabling itself", () => {
  const h = harness();
  const nestedBackdrop = new h.Element(h.backdrop);
  const nestedDialog = new h.Element(nestedBackdrop);
  const nestedButton = new h.Element(nestedDialog, 0);
  h.first.focus();
  const cleanup = h.activate(nestedDialog);
  assert.equal(h.dialog.inert, true);
  assert.equal(nestedBackdrop.inert, false);
  assert.equal(h.background.inert, true);
  nestedButton.focus();
  assert.equal(h.press(), true);
  assert.equal(h.document.activeElement, nestedButton);
  cleanup();
  assert.equal(h.dialog.inert, false);
  assert.equal(h.document.activeElement, h.first);
});

test("empty dialog retains focus and preserves an already-inert background", () => {
  const h = harness();
  h.dialog.children = [];
  h.background.inert = true;
  const cleanup = h.activate(h.dialog);
  assert.equal(h.press(), true);
  assert.equal(h.document.activeElement, h.dialog);
  cleanup();
  assert.equal(h.background.inert, true);
  assert.notEqual(h.document.activeElement, h.origin);
});
