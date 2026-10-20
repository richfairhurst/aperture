import { describe, expect, it } from "vitest";
import { enforceTriage, type TriageInput } from "../src/pipeline/triage";

function item(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    proposedState: "watch",
    proposedReason: "Model considers this relevant.",
    personalUtilityScore: 3,
    actionabilityScore: 3,
    strategicImplication: null,
    evidenceStatus: "corroborated",
    freshnessStatus: "new_development",
    promotionalSignal: false,
    profileMatchSignal: "strong",
    duplicate: false,
    consequential: false,
    finalScore: 75,
    ...overrides,
  };
}

describe("triage enforcement", () => {
  it("allows a valid read-now proposal", () => {
    const result = enforceTriage({ ...item(), proposedState: "read_now" });

    expect(result.triageState).toBe("read_now");
    expect(result.triageReasonCode).toBe("high_utility_actionable");
  });

  it("requires utility and actionability or strategy for read-now", () => {
    const lowUtility = enforceTriage({
      ...item(),
      proposedState: "read_now",
      personalUtilityScore: 2,
    });
    const strategic = enforceTriage({
      ...item(),
      proposedState: "read_now",
      actionabilityScore: 1,
      strategicImplication: "This changes an active decision.",
    });

    expect(lowUtility.triageState).toBe("watch");
    expect(strategic.triageState).toBe("read_now");
  });

  it("blocks unverified and conflicting evidence from read-now", () => {
    const unverified = enforceTriage({
      ...item(),
      proposedState: "read_now",
      evidenceStatus: "unverified",
    });
    const conflicting = enforceTriage({
      ...item(),
      proposedState: "read_now",
      evidenceStatus: "conflicting",
    });

    expect(unverified.triageState).toBe("watch");
    expect(unverified.triageReasonCode).toBe("freshness_unverified");
    expect(conflicting.triageState).toBe("watch");
    expect(conflicting.triageReasonCode).toBe("conflicting_evidence");
  });

  it("keeps otherwise strong items on watch when freshness is unverified", () => {
    const result = enforceTriage({
      ...item(),
      proposedState: "read_now",
      freshnessStatus: "unverified",
    });

    expect(result.triageState).toBe("watch");
    expect(result.triageReasonCode).toBe("freshness_unverified");
  });

  it("allows important context without immediate action", () => {
    const result = enforceTriage({
      ...item(),
      proposedState: "important_context",
      actionabilityScore: 1,
    });

    expect(result.triageState).toBe("important_context");
    expect(result.triageReasonCode).toBe("important_context_no_action");
  });

  it("archives duplicates, promotional content, outside-profile items, and low scores", () => {
    expect(enforceTriage({ ...item(), duplicate: true }).triageReasonCode).toBe(
      "duplicate",
    );
    expect(
      enforceTriage({ ...item(), promotionalSignal: true }).triageReasonCode,
    ).toBe("promotional");
    expect(
      enforceTriage({ ...item(), profileMatchSignal: "none" }).triageReasonCode,
    ).toBe("outside_profile");
    expect(
      enforceTriage({ ...item(), finalScore: 20, minimumDisplayScore: 50 })
        .triageReasonCode,
    ).toBe("below_threshold");
  });

  it("does not archive a consequential story solely for weak fit or promotion", () => {
    const result = enforceTriage({
      ...item(),
      consequential: true,
      promotionalSignal: true,
      profileMatchSignal: "none",
      proposedState: "archive",
      actionabilityScore: 0,
    });

    expect(result.triageState).toBe("watch");
    expect(result.triageReasonCode).toBe("insufficient_personal_fit");
  });

  it("preserves the model proposal and applied rules for audit", () => {
    const result = enforceTriage({
      ...item(),
      proposedState: "read_now",
      evidenceStatus: "conflicting",
      proposedReason: "Model found an urgent development.",
    });

    expect(result.proposedState).toBe("read_now");
    expect(result.proposedReason).toBe("Model found an urgent development.");
    expect(result.enforcedRules).toContain(
      "conflicting_evidence_cannot_be_read_now",
    );
  });
});
