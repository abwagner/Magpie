import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TypedConfirmation, isArmed } from "./TypedConfirmation.js";

describe("isArmed", () => {
  it("requires the exact uppercase safety word", () => {
    expect(isArmed("FIRE", "FIRE")).toBe(true);
    expect(isArmed("fire", "FIRE")).toBe(false);
    expect(isArmed("Fire", "FIRE")).toBe(false);
    expect(isArmed("HALT", "FIRE")).toBe(false);
    expect(isArmed("FIRE ", "FIRE")).toBe(false);
    expect(isArmed(" FIRE", "FIRE")).toBe(false);
    expect(isArmed("", "FIRE")).toBe(false);
  });

  it("works the same way for HALT", () => {
    expect(isArmed("HALT", "HALT")).toBe(true);
    expect(isArmed("halt", "HALT")).toBe(false);
    expect(isArmed("HALT!", "HALT")).toBe(false);
  });
});

describe("TypedConfirmation", () => {
  it("notifies parent only when the safety word is typed exactly", () => {
    const events: boolean[] = [];
    const { getByLabelText } = render(
      <TypedConfirmation safetyWord="FIRE" onArmedChange={(v) => events.push(v)} />,
    );
    const input = getByLabelText("type FIRE to confirm") as HTMLInputElement;

    // initial render: not armed
    expect(events.at(-1)).toBe(false);

    fireEvent.change(input, { target: { value: "FIR" } });
    expect(events.at(-1)).toBe(false);

    fireEvent.change(input, { target: { value: "FIRE" } });
    expect(events.at(-1)).toBe(true);

    fireEvent.change(input, { target: { value: "FIREX" } });
    expect(events.at(-1)).toBe(false);

    fireEvent.change(input, { target: { value: "fire" } });
    expect(events.at(-1)).toBe(false);
  });
});
