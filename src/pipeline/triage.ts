export type TriageState =
  "read_now" | "important_context" | "watch" | "archive";

export type EvidenceStatus =
  "corroborated" | "single_source" | "conflicting" | "unverified";

export type FreshnessStatus =
  | "new_development"
  | "new_reporting_old_event"
  | "ongoing"
  | "stale"
  | "unverified";

export type ProfileMatchSignal = "strong" | "weak" | "none";

export type TriageInput = {
  proposedState: TriageState;
  proposedReason: string;
  personalUtilityScore: number;
  actionabilityScore: number;
  strategicImplication: string | null;
  evidenceStatus: EvidenceStatus;
  freshnessStatus: FreshnessStatus;
  promotionalSignal: boolean;
  profileMatchSignal: ProfileMatchSignal;
  duplicate: boolean;
  consequential: boolean;
  finalScore: number;
  minimumDisplayScore?: number;
};

export type TriageReasonCode =
  | "high_utility_actionable"
  | "important_context_no_action"
  | "freshness_unverified"
  | "single_source"
  | "conflicting_evidence"
  | "duplicate"
  | "promotional"
  | "outside_profile"
  | "below_threshold"
  | "insufficient_personal_fit"
  | "model_proposal_not_supported";

export type TriageDecision = {
  triageState: TriageState;
  triageReasonCode: TriageReasonCode;
  triageReason: string;
  proposedState: TriageState;
  proposedReason: string;
  enforcedRules: string[];
};

export function enforceTriage(input: TriageInput): TriageDecision {
  validateScores(input);
  const enforcedRules: string[] = [];

  if (input.duplicate) {
    if (input.consequential) {
      enforcedRules.push("consequential_story_not_archived_as_duplicate");
    } else {
      return decision(
        input,
        "archive",
        "duplicate",
        "Duplicate coverage was collapsed.",
        ["duplicate_content_is_archived"],
      );
    }
  }

  if (input.promotionalSignal && !input.consequential) {
    return decision(
      input,
      "archive",
      "promotional",
      "Promotional or low-signal content was archived.",
      ["promotional_content_cannot_be_read_now"],
    );
  }

  if (input.profileMatchSignal === "none" && !input.consequential) {
    return decision(
      input,
      "archive",
      "outside_profile",
      "The item is outside the active intelligence profile.",
      ["outside_profile_content_is_archived"],
    );
  }

  if (
    input.minimumDisplayScore !== undefined &&
    input.finalScore < input.minimumDisplayScore &&
    !input.consequential
  ) {
    return decision(
      input,
      "archive",
      "below_threshold",
      "The item is below the configured display threshold.",
      ["below_threshold_content_is_archived"],
    );
  }

  if (input.evidenceStatus === "conflicting") {
    return decision(
      input,
      "watch",
      "conflicting_evidence",
      "Sources conflict, so the item requires cautious review.",
      ["conflicting_evidence_cannot_be_read_now"],
    );
  }

  if (input.evidenceStatus === "unverified") {
    return decision(
      input,
      "watch",
      "freshness_unverified",
      "Evidence is unverified, so the item remains watch-only.",
      ["unverified_evidence_cannot_be_read_now"],
    );
  }

  if (input.freshnessStatus === "unverified") {
    return decision(
      input,
      "watch",
      "freshness_unverified",
      "Freshness is unverified, so the item remains watch-only.",
      ["unverified_freshness_remains_watch"],
    );
  }

  if (
    input.proposedState === "read_now" &&
    input.personalUtilityScore >= 3 &&
    (input.actionabilityScore >= 3 || hasStrategicImplication(input))
  ) {
    return decision(
      input,
      "read_now",
      "high_utility_actionable",
      "High personal utility and a clear action or strategic implication.",
      [
        "read_now_requires_utility",
        "read_now_requires_evidence",
        "read_now_requires_action_or_strategy",
      ],
    );
  }

  if (
    input.proposedState === "important_context" &&
    input.profileMatchSignal !== "none"
  ) {
    return decision(
      input,
      "important_context",
      "important_context_no_action",
      "Materially relevant context without an immediate action.",
      ["important_context_requires_credible_evidence"],
    );
  }

  if (input.personalUtilityScore < 2 || input.profileMatchSignal === "none") {
    return decision(
      input,
      "watch",
      "insufficient_personal_fit",
      "The item may be relevant but has insufficient personal fit for promotion.",
      ["weak_personal_fit_remains_watch"],
    );
  }

  return decision(
    input,
    "watch",
    "model_proposal_not_supported",
    "The proposed triage state did not satisfy the deterministic promotion rules.",
    ["unsupported_promotion_remains_watch"],
  );
}

function decision(
  input: TriageInput,
  triageState: TriageState,
  triageReasonCode: TriageReasonCode,
  triageReason: string,
  enforcedRules: string[],
): TriageDecision {
  return {
    triageState,
    triageReasonCode,
    triageReason,
    proposedState: input.proposedState,
    proposedReason: input.proposedReason,
    enforcedRules,
  };
}

function hasStrategicImplication(input: TriageInput): boolean {
  return input.strategicImplication?.trim().length !== 0;
}

function validateScores(input: TriageInput): void {
  for (const [field, score] of [
    ["personalUtilityScore", input.personalUtilityScore],
    ["actionabilityScore", input.actionabilityScore],
    ["finalScore", input.finalScore],
  ] as const) {
    if (
      !Number.isFinite(score) ||
      score < 0 ||
      (field !== "finalScore" && score > 4)
    ) {
      throw new Error(`${field} is outside its allowed range`);
    }
  }

  if (
    input.minimumDisplayScore !== undefined &&
    (!Number.isFinite(input.minimumDisplayScore) ||
      input.minimumDisplayScore < 0)
  ) {
    throw new Error("minimumDisplayScore must be a non-negative number");
  }
}
