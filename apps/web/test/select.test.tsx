// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Select } from "@/components/ui/select";
import { chooseOption, installSelectDom, selectTrigger } from "./select-helper";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installSelectDom();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const OPTIONS = [
  { value: "", label: "All" },
  { value: "btc", label: "Bitcoin", hint: "Crypto" },
  { value: "tsla", label: "Tesla", hint: "Stock" },
  { value: "gone", label: "Delisted", disabled: true },
];

function Harness({ searchable = false, initial = "" }: { searchable?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="pick">Market</label>
      <Select id="pick" value={value} onValueChange={setValue} options={OPTIONS} searchable={searchable} searchPlaceholder="Search" placeholder="Choose" />
      <output>{value || "none"}</output>
    </>
  );
}

it("is a labelled combobox showing the current choice, with the 48 px capsule trigger", async () => {
  await act(async () => root.render(<Harness initial="btc" />));
  const trigger = selectTrigger(container)!;
  expect(trigger.getAttribute("role")).toBe("combobox");
  expect(trigger.id).toBe("pick");
  expect(container.querySelector('label[for="pick"]')).not.toBeNull();
  expect(trigger.textContent).toContain("Bitcoin");
  expect(trigger.className).toContain("h-12");
  expect(trigger.className).toContain("rounded-full");
});

it("opens with the keyboard, checks the selected item and picks another with Enter", async () => {
  await act(async () => root.render(<Harness initial="btc" />));
  await chooseOption(selectTrigger(container), "tsla");
  expect(container.querySelector("output")!.textContent).toBe("tsla");
  expect(selectTrigger(container)!.textContent).toContain("Tesla");
  expect(selectTrigger(container)!.getAttribute("aria-expanded")).toBe("false");
});

it("maps the empty value (\"All\") through Radix, which reserves it", async () => {
  await act(async () => root.render(<Harness initial="tsla" />));
  await chooseOption(selectTrigger(container), "");
  expect(container.querySelector("output")!.textContent).toBe("none");
  expect(selectTrigger(container)!.textContent).toContain("All");
});

it("shows the placeholder when nothing is chosen and no option is empty", async () => {
  function NoEmpty() {
    const [value, setValue] = useState("");
    return <Select label="Account" value={value} onValueChange={setValue} options={OPTIONS.slice(1)} placeholder="Choose an account" />;
  }
  await act(async () => root.render(<NoEmpty />));
  expect(selectTrigger(container)!.textContent).toContain("Choose an account");
  expect(selectTrigger(container)!.getAttribute("aria-label")).toBe("Account");
});

it("searchable: filters by typing, moves with arrows, skips disabled items and picks with Enter", async () => {
  await act(async () => root.render(<Harness searchable initial="btc" />));
  const trigger = selectTrigger(container)!;
  expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  await act(async () => trigger.click());
  const input = document.querySelector<HTMLInputElement>('[role="combobox"][aria-autocomplete="list"]')!;
  expect(input).not.toBeNull();
  const listbox = document.getElementById(input.getAttribute("aria-controls")!)!;
  expect(listbox.getAttribute("role")).toBe("listbox");
  // The selected option is active and checked.
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)!.textContent).toContain("Bitcoin");
  expect(listbox.querySelector('[aria-selected="true"]')!.textContent).toContain("Bitcoin");
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)!.textContent).toContain("Tesla");
  // Down again wraps past the disabled item to "All".
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)!.textContent).toContain("All");
  // Typing filters.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "tes"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect([...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["TeslaStock"]);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(container.querySelector("output")!.textContent).toBe("tsla");
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});
