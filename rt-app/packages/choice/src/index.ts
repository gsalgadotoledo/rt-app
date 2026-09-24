import { canonical } from "@gsalgadotoledo/rt-app-cache";
import { HttpError, type Feature } from "@gsalgadotoledo/rt-app-contracts";

export interface ChoiceInput {
  context: unknown;
  question: string;
  options: Array<{ id: string; description?: string }>;
}
export interface ChoicePrediction {
  probabilities: Record<string, number>;
  confidence?: number;
  model: string;
  semantics: "model-probabilities" | "uncalibrated-scores";
}
export interface ChoiceProvider {
  readonly id: string;
  predict(input: ChoiceInput, signal?: AbortSignal): Promise<ChoicePrediction>;
}
export interface ChoicePolicy {
  minProbability?: number;
  minMargin?: number;
  allowUncalibrated?: boolean;
}

/** Reject malformed state before a provider sees it. Returns an immutable-by-copy JSON snapshot. */
export function validateChoice(input: ChoiceInput): ChoiceInput {
  if (
    !input ||
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.length > 4000 ||
    !Array.isArray(input.options) ||
    input.options.length < 2 ||
    input.options.length > 255
  )
    throw new HttpError(400, "Invalid choice question or options");
  if (
    input.options.some(
      (o) =>
        !o ||
        typeof o.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(o.id) ||
        (o.description !== undefined &&
          (typeof o.description !== "string" || o.description.length > 2000)),
    ) ||
    new Set(input.options.map((o) => o.id)).size !== input.options.length
  )
    throw new HttpError(400, "Invalid or duplicate option");
  const json = canonical(input as any);
  if (Buffer.byteLength(json) > 128000)
    throw new HttpError(400, "Choice input too large");
  return JSON.parse(json);
}

/** Typed decisions with explicit abstention; probability is not measured accuracy. */
export class Choice {
  constructor(private provider: ChoiceProvider) {}

  /** @example decide({context:'Refund please',question:'Route?',options:[{id:'sales'},{id:'billing'}]}) */
  async decide(
    input: ChoiceInput,
    policy: ChoicePolicy = {},
    signal?: AbortSignal,
  ) {
    const snapshot = validateChoice(input);
    const min = policy.minProbability ?? 0.8,
      margin = policy.minMargin ?? 0.1;
    if (![min, margin].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
      throw new HttpError(400, "Invalid choice policy");
    signal?.throwIfAborted();
    const result = await this.provider.predict(snapshot, signal);
    signal?.throwIfAborted();
    const keys = snapshot.options.map((o) => o.id),
      probabilities = result?.probabilities;
    if (
      !probabilities ||
      Object.keys(probabilities).length !== keys.length ||
      keys.some(
        (k) =>
          !Object.hasOwn(probabilities, k) ||
          !Number.isFinite(probabilities[k]) ||
          probabilities[k] < 0 ||
          probabilities[k] > 1,
      ) ||
      Math.abs(keys.reduce((sum, k) => sum + probabilities[k], 0) - 1) >
        0.001 ||
      typeof result.model !== "string" ||
      !result.model ||
      !["model-probabilities", "uncalibrated-scores"].includes(
        result.semantics,
      ) ||
      (result.confidence !== undefined &&
        (!Number.isFinite(result.confidence) ||
          result.confidence < 0 ||
          result.confidence > 1))
    )
      throw new Error("Invalid choice provider response");
    const ranked = keys
      .map((id) => ({ id, probability: probabilities[id] }))
      .sort((a, b) => b.probability - a.probability);
    const accepted =
      ranked[0].probability >= min &&
      ranked[0].probability - ranked[1].probability >= margin &&
      ranked[0].probability > ranked[1].probability &&
      (result.semantics !== "uncalibrated-scores" ||
        policy.allowUncalibrated === true);
    return {
      provider: this.provider.id,
      ...structuredClone(result),
      selected: ranked[0].id,
      accepted,
      requiresReview: !accepted,
    };
  }

  /** Opt-in API/CLI/MCP exposure; the caller must hold choice.decide explicitly. */
  feature(): Feature {
    return {
      id: "choice",
      migrations: [],
      endpoints: [
        {
          method: "POST",
          path: "/choice/decide",
          resource: "choice.decide",
          access: "permission",
          explicitGrant: true,
          tool: {
            name: "choice_decide",
            description:
              "Evaluate context against named options. May incur provider usage. Low-certainty decisions require review.",
            example: {
              body: {
                context: "Refund please",
                question: "Route?",
                options: [{ id: "billing" }, { id: "sales" }],
              },
            },
          },
          handle: async (c) => this.decide(c.request.body as ChoiceInput),
        },
      ],
    };
  }
}
