import {
  validateChoice,
  type ChoiceInput,
  type ChoiceProvider,
  type ChoicePrediction,
} from "@gsalgadotoledo/rt-app-choice";
export type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options: { multi_label: false },
) => Promise<{ labels: string[]; scores: number[] }>;

/** Inject a Transformers.js zero-shot-classification pipeline; weights load only in the owning app. */
export class TransformersChoiceProvider implements ChoiceProvider {
  readonly id = "transformers";
  constructor(
    private pipeline: ZeroShotPipeline,
    private model: string,
  ) {}

  /** NLI label scores are uncalibrated; Choice abstains by default even with a high score. */
  async predict(
    input: ChoiceInput,
    signal?: AbortSignal,
  ): Promise<ChoicePrediction> {
    input = validateChoice(input);
    signal?.throwIfAborted();
    const labels = input.options.map(
      (o) => o.id + (o.description ? ": " + o.description : ""),
    );
    const result = await this.pipeline(
      input.question + "\n\n" + JSON.stringify(input.context),
      labels,
      { multi_label: false },
    );
    signal?.throwIfAborted();
    if (
      !Array.isArray(result.labels) ||
      !Array.isArray(result.scores) ||
      result.labels.length !== labels.length ||
      result.scores.length !== labels.length ||
      new Set(result.labels).size !== labels.length ||
      result.labels.some((l) => !labels.includes(l))
    )
      throw new Error("Invalid classifier response");
    return {
      model: this.model,
      semantics: "uncalibrated-scores",
      probabilities: Object.fromEntries(
        input.options.map((o, i) => [
          o.id,
          result.scores[result.labels.indexOf(labels[i])],
        ]),
      ),
    };
  }
}
