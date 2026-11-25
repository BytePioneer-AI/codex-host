import { describe, expect, it } from "vitest";
import { partitionApprovalCardActions, type ApprovalCardAction } from "../src/ApprovalCard.tsx";

describe("partitionApprovalCardActions", () => {
  it("separates ACP multi-deny options from allow options so denies never enter the allow menu", () => {
    const actions: ApprovalCardAction[] = [
      { id: "allow_once", label: "Allow once", effect: "allowOnce" },
      { id: "allow_always", label: "Always allow", effect: "allowAlways" },
      { id: "reject_once", label: "Reject once", effect: "deny" },
      { id: "reject_always", label: "Always reject", effect: "deny" },
    ];

    const result = partitionApprovalCardActions(actions);
    expect(result.primaryDeny?.id).toBe("reject_once");
    expect(result.secondaryDenies.map((action) => action.id)).toEqual(["reject_always"]);
    expect(result.primaryAllow?.id).toBe("allow_once");
    expect(result.secondaryAllows.map((action) => action.id)).toEqual(["allow_always"]);
  });

  it("prefers allowOnce as primaryAllow regardless of input order", () => {
    const actions: ApprovalCardAction[] = [
      { id: "allow_session", label: "Allow for session", effect: "allowForSession" },
      { id: "allow_once", label: "Allow once", effect: "allowOnce" },
      { id: "decline", label: "Decline", effect: "deny" },
    ];

    const result = partitionApprovalCardActions(actions);
    expect(result.primaryDeny?.id).toBe("decline");
    expect(result.secondaryDenies).toEqual([]);
    expect(result.primaryAllow?.id).toBe("allow_once");
    expect(result.secondaryAllows.map((action) => action.id)).toEqual(["allow_session"]);
  });

  it("handles two-action, allow-only, and deny-only payloads without spurious menus", () => {
    expect(
      partitionApprovalCardActions([
        { id: "accept", label: "Allow", effect: "allowOnce" },
        { id: "decline", label: "Deny", effect: "deny" },
      ]),
    ).toEqual({
      primaryDeny: { id: "decline", label: "Deny", effect: "deny" },
      secondaryDenies: [],
      primaryAllow: { id: "accept", label: "Allow", effect: "allowOnce" },
      secondaryAllows: [],
    });

    expect(
      partitionApprovalCardActions([
        { id: "allow_always", label: "Always allow", effect: "allowAlways" },
      ]),
    ).toEqual({
      primaryDeny: undefined,
      secondaryDenies: [],
      primaryAllow: { id: "allow_always", label: "Always allow", effect: "allowAlways" },
      secondaryAllows: [],
    });

    expect(
      partitionApprovalCardActions([
        { id: "reject_once", label: "Reject once", effect: "deny" },
        { id: "reject_always", label: "Always reject", effect: "deny" },
      ]),
    ).toEqual({
      primaryDeny: { id: "reject_once", label: "Reject once", effect: "deny" },
      secondaryDenies: [{ id: "reject_always", label: "Always reject", effect: "deny" }],
      primaryAllow: undefined,
      secondaryAllows: [],
    });
  });
});
