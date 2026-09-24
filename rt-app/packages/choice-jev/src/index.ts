import {
  validateChoice,
  type ChoiceInput,
  type ChoiceProvider,
  type ChoicePrediction,
} from "@gsalgadotoledo/rt-app-choice";

/** Official TypeSafe System One wire format; no implicit billable retries. */
export class JevProvider implements ChoiceProvider {
  readonly id = "jev";
  constructor(
    private apiKey: string,
    private model = "jev-latest",
    private transport: typeof fetch = fetch,
    private timeoutMs = 15000,
  ) {
    if (
      !apiKey.trim() ||
      !model.trim() ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1
    )
      throw new TypeError("Invalid Jev configuration");
  }

  /** Send one named Choice; caller uses Choice.decide to validate the returned distribution. */
  async predict(
    input: ChoiceInput,
    signal?: AbortSignal,
  ): Promise<ChoicePrediction> {
    input = validateChoice(input);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.transport(
      "https://api.typesafe.ai/v1/systemone",
      {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          authorization: "Bearer " + this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          state: input.context,
          questions: {
            decision: {
              type: "choice",
              instructions: input.question,
              criteria: Object.fromEntries(
                input.options.map((o) => [o.id, o.description ?? null]),
              ),
            },
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Jev request failed: HTTP " + response.status);
    }
    const data = (await response.json()) as any;
    if (data.answers?.decision?.type !== "choice")
      throw new Error("Invalid Jev response");
    return {
      model: data.model,
      probabilities: data.answers.decision.probabilities,
      confidence: data.answers.decision.confidence,
      semantics: "model-probabilities",
    };
  }
}
