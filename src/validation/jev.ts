export type JevChoiceQuestion = {
  type: "choice";
  choices: readonly string[];
};

export type JevScoreQuestion = {
  type: "score";
  minimum: number;
  maximum: number;
};

export type JevNoulQuestion = {
  type: "noul";
};

export type JevQuestion =
  JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export type JevQuestionSchema = Record<string, JevQuestion>;

export type ValidatedChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type ValidatedScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: Record<string, string> | null;
};

export type ValidatedNoulAnswer = {
  type: "noul";
  noul: number;
};

export type ValidatedJevAnswer =
  ValidatedChoiceAnswer | ValidatedScoreAnswer | ValidatedNoulAnswer;

export type ValidatedJevResponse = {
  model: string;
  answers: Record<string, ValidatedJevAnswer>;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  rawResponse: unknown;
};

export const defaultJevQuestionSchema: JevQuestionSchema = {
  primary_topic: {
    type: "choice",
    choices: [
      "ai",
      "cybersecurity",
      "geopolitics",
      "technology_strategy",
      "executive_decision_making",
      "business_opportunity",
      "other",
    ],
  },
  content_type: {
    type: "choice",
    choices: [
      "analysis",
      "news",
      "research",
      "opinion",
      "how_to",
      "interview",
      "announcement",
      "other",
    ],
  },
  quality_score: { type: "score", minimum: 0, maximum: 4 },
  personal_utility_score: { type: "score", minimum: 0, maximum: 4 },
  actionability_score: { type: "score", minimum: 0, maximum: 4 },
  contains_evidence: { type: "noul" },
  has_mental_model: { type: "noul" },
  has_relevant_action: { type: "noul" },
  worth_sharing_executive: { type: "noul" },
  primarily_promotional: { type: "noul" },
};

export class JevValidationError extends Error {
  readonly code = "invalid_jev_response";

  constructor(message: string) {
    super(`Invalid Jev response: ${message}`);
    this.name = "JevValidationError";
  }
}

export function validateJevResponse(
  payload: unknown,
  schema: JevQuestionSchema = defaultJevQuestionSchema,
): ValidatedJevResponse {
  if (!isRecord(payload)) {
    throw new JevValidationError("response must be an object");
  }

  const model = requiredString(payload.model, "model");
  const answers = requireRecord(payload.answers, "answers");
  const schemaKeys = Object.keys(schema);
  const answerKeys = Object.keys(answers);

  for (const question of schemaKeys) {
    if (!(question in answers)) {
      throw new JevValidationError(`missing answer '${question}'`);
    }
  }

  for (const answerKey of answerKeys) {
    if (!(answerKey in schema)) {
      throw new JevValidationError(`unexpected answer '${answerKey}'`);
    }
  }

  const validatedAnswers: Record<string, ValidatedJevAnswer> = {};
  for (const [question, definition] of Object.entries(schema)) {
    validatedAnswers[question] = validateAnswer(
      answers[question],
      definition,
      question,
    );
  }

  return {
    model,
    answers: validatedAnswers,
    usage: validateUsage(payload.usage),
    rawResponse: payload,
  };
}

function validateAnswer(
  value: unknown,
  definition: JevQuestion,
  question: string,
): ValidatedJevAnswer {
  const answer = requireRecord(value, `answers.${question}`);
  const type = requiredString(answer.type, `answers.${question}.type`);

  if (type !== definition.type) {
    throw new JevValidationError(
      `answers.${question}.type must be '${definition.type}'`,
    );
  }

  if (definition.type === "choice") {
    return validateChoiceAnswer(answer, definition, question);
  }

  if (definition.type === "score") {
    return validateScoreAnswer(answer, definition, question);
  }

  return validateNoulAnswer(answer, question);
}

function validateChoiceAnswer(
  answer: Record<string, unknown>,
  definition: JevChoiceQuestion,
  question: string,
): ValidatedChoiceAnswer {
  const choice = requiredString(answer.choice, `answers.${question}.choice`);
  if (!definition.choices.includes(choice)) {
    throw new JevValidationError(
      `answers.${question}.choice '${choice}' is not allowed`,
    );
  }

  return {
    type: "choice",
    choice,
    confidence: validateConfidence(answer.confidence, question),
    probabilities: validateProbabilities(
      answer.probabilities,
      definition.choices,
      question,
    ),
  };
}

function validateScoreAnswer(
  answer: Record<string, unknown>,
  definition: JevScoreQuestion,
  question: string,
): ValidatedScoreAnswer {
  const score = answer.score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < definition.minimum ||
    score > definition.maximum
  ) {
    throw new JevValidationError(
      `answers.${question}.score must be a number from ${definition.minimum} to ${definition.maximum}`,
    );
  }

  const expectedScores = Array.from(
    { length: definition.maximum - definition.minimum + 1 },
    (_, index) => String(definition.minimum + index),
  );

  return {
    type: "score",
    score,
    confidence: validateConfidence(answer.confidence, question),
    probabilities: validateProbabilities(
      answer.probabilities,
      expectedScores,
      question,
    ),
    legend: validateLegend(answer.legend, question),
  };
}

function validateNoulAnswer(
  answer: Record<string, unknown>,
  question: string,
): ValidatedNoulAnswer {
  if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new JevValidationError(
      `answers.${question}.noul must be a finite number`,
    );
  }

  return { type: "noul", noul: answer.noul };
}

function validateProbabilities(
  value: unknown,
  expectedKeys: readonly string[],
  question: string,
): Record<string, number> {
  const probabilities = requireRecord(
    value,
    `answers.${question}.probabilities`,
  );
  const actualKeys = Object.keys(probabilities).sort();
  const requiredKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index])
  ) {
    throw new JevValidationError(
      `answers.${question}.probabilities must contain exactly the configured keys`,
    );
  }

  const result: Record<string, number> = {};
  let total = 0;
  for (const key of expectedKeys) {
    const probability = probabilities[key];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw new JevValidationError(
        `answers.${question}.probabilities.${key} must be between 0 and 1`,
      );
    }

    result[key] = probability;
    total += probability;
  }

  if (Math.abs(total - 1) > 0.01) {
    throw new JevValidationError(
      `answers.${question}.probabilities must sum to 1`,
    );
  }

  return result;
}

function validateConfidence(value: unknown, question: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new JevValidationError(
      `answers.${question}.confidence must be between 0 and 1`,
    );
  }

  return value;
}

function validateLegend(
  value: unknown,
  question: string,
): Record<string, string> | null {
  if (value === undefined || value === null) {
    return null;
  }

  const legend = requireRecord(value, `answers.${question}.legend`);
  const result: Record<string, string> = {};
  for (const [key, description] of Object.entries(legend)) {
    result[key] = requiredString(
      description,
      `answers.${question}.legend.${key}`,
    );
  }

  return result;
}

function validateUsage(value: unknown): ValidatedJevResponse["usage"] {
  if (value === undefined || value === null) {
    return { inputTokens: null, outputTokens: null };
  }

  const usage = requireRecord(value, "usage");
  return {
    inputTokens: optionalNonNegativeInteger(
      usage.input_tokens,
      "usage.input_tokens",
    ),
    outputTokens: optionalNonNegativeInteger(
      usage.output_tokens,
      "usage.output_tokens",
    ),
  };
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JevValidationError(`${field} must be a non-negative integer`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new JevValidationError(`${field} must be an object`);
  }

  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JevValidationError(`${field} must be a non-empty string`);
  }

  return value;
}
