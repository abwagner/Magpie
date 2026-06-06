// QF-51 unit tests for the operator-edit form's serialization. The
// React component is integration-tested via the JobQueuePanel.test
// pattern in a follow-up; this file pins the editStateToApiEdits
// contract that decides what flows through to the backend on
// approve.

import { describe, expect, it } from "vitest";
import { editStateToApiEdits, type EditState } from "./ApprovalsPanel.js";

const empty: EditState = {
  order_type: "",
  limit_price: "",
  time_in_force: "",
  working_policy_id: "",
};

describe("editStateToApiEdits", () => {
  it("returns undefined when every field is empty (approve-as-recommended path)", () => {
    expect(editStateToApiEdits(empty)).toBeUndefined();
  });

  it("includes only the fields the operator touched", () => {
    expect(editStateToApiEdits({ ...empty, limit_price: "12.55" })).toEqual({
      limit_price: 12.55,
    });
  });

  it("parses limit_price as a number and drops non-numeric strings silently", () => {
    expect(editStateToApiEdits({ ...empty, limit_price: "12.55" })).toEqual({
      limit_price: 12.55,
    });
    // Garbage input → field omitted (operator didn't supply a valid override).
    expect(editStateToApiEdits({ ...empty, limit_price: "not a number" })).toBeUndefined();
  });

  it("propagates order_type / time_in_force selects through to the API shape", () => {
    expect(
      editStateToApiEdits({
        ...empty,
        order_type: "limit",
        time_in_force: "gtc",
      }),
    ).toEqual({ order_type: "limit", time_in_force: "gtc" });
  });

  it("trims whitespace on working_policy_id and drops whitespace-only entries", () => {
    expect(editStateToApiEdits({ ...empty, working_policy_id: "  patient-30s-repeg  " })).toEqual({
      working_policy_id: "patient-30s-repeg",
    });
    expect(editStateToApiEdits({ ...empty, working_policy_id: "   " })).toBeUndefined();
  });

  it("composes multiple fields into one edits object", () => {
    expect(
      editStateToApiEdits({
        order_type: "limit",
        limit_price: "12.55",
        time_in_force: "day",
        working_policy_id: "patient",
      }),
    ).toEqual({
      order_type: "limit",
      limit_price: 12.55,
      time_in_force: "day",
      working_policy_id: "patient",
    });
  });
});
