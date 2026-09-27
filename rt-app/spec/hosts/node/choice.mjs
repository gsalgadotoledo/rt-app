// Subjects: choice, choice-jev, choice-transformers. Providers are faked from `init` so no network
// or model is used: every language builds the same fakes (see rt-app/docs/polyglot/choice.md).
// Also exports localChoiceProvider, the deterministic provider the reference API (node-api.mjs)
// serves /admin/app/choice/decide with.
import { Choice, validateChoice } from "@gsalgadotoledo/rt-app-choice";
import { JevProvider } from "@gsalgadotoledo/rt-app-choice-jev";
import { TransformersChoiceProvider } from "@gsalgadotoledo/rt-app-choice-transformers";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** A signal for `when`: "before" is already aborted; "during" is aborted by the fake mid-call. */
function abortable(when) {
  const controller = new AbortController();
  if (when === "before") controller.abort();
  else if (when !== "during") throw new Error('when must be "before" or "during"');
  return controller;
}

/**
 * Local development provider (never for production): a context object with a `prediction`
 * field is returned as the provider response ("fail" makes the provider throw); otherwise every
 * option gets 1/n as uncalibrated scores, so decisions abstain.
 */
export function localChoiceProvider() {
  return {
    id: "local",
    async predict(input) {
      const context = input.context;
      if (context && typeof context === "object" && !Array.isArray(context) && Object.hasOwn(context, "prediction")) {
        if (context.prediction === "fail") throw new Error("Local choice provider failure");
        return context.prediction;
      }
      const share = 1 / input.options.length;
      return {
        model: "local",
        semantics: "uncalibrated-scores",
        probabilities: Object.fromEntries(input.options.map((o) => [o.id, share])),
      };
    },
  };
}

/** choice: Choice over a fake provider returning init.prediction (or throwing init.error). */
function choice(init) {
  const calls = [];
  let during;
  const provider = {
    id: init.id ?? "fake",
    predict: async (input) => {
      calls.push(structuredClone(input));
      during?.abort();
      if (init.error != null) throw new Error(init.error);
      return structuredClone(init.prediction);
    },
  };
  const module = new Choice(provider);
  const feature = module.feature();
  return {
    validateChoice: (input) => validateChoice(input),
    decide: (input, policy) => module.decide(input, given(policy)),
    decideAborted: (input, policy, when) => {
      const controller = abortable(when);
      if (when === "during") during = controller;
      return module.decide(input, given(policy), controller.signal);
    },
    calls: () => calls,
    feature: () => ({
      id: feature.id,
      migrations: feature.migrations,
      endpoints: feature.endpoints.map(({ method, path, resource, access, explicitGrant, tool }) => ({
        method, path, resource, access, explicitGrant, tool,
      })),
    }),
    handle: (body) => feature.endpoints[0].handle({ request: { body }, params: {} }),
  };
}

/**
 * choice-jev: JevProvider with a fake transport answering init.responses in order:
 * {status, json} (a JSON body), {status, text} (a raw body) or {error} (the transport throws).
 */
function jev(init) {
  const requests = [];
  const responses = [...(init.responses ?? [])];
  const transport = async (url, options) => {
    requests.push({
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
      text: options.body,
    });
    const next = responses.shift();
    if (!next) throw new Error("No fake response left");
    if (next.error != null) throw new Error(next.error);
    const body = next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json));
    return new Response(body, { status: next.status ?? 200 });
  };
  const provider = new JevProvider(init.apiKey, given(init.model), transport, given(init.timeoutMs));
  const module = new Choice(provider);
  return {
    id: () => provider.id,
    predict: (input) => provider.predict(input),
    decide: (input, policy) => module.decide(input, given(policy)),
    requests: () => requests,
  };
}

/**
 * choice-transformers: TransformersChoiceProvider over a fake zero-shot pipeline answering
 * init.results in order ({labels, scores}, null, or {error} to throw).
 */
function transformers(init) {
  const calls = [];
  const results = [...(init.results ?? [])];
  let during;
  const pipeline = async (text, labels, options) => {
    calls.push({ text, labels: [...labels], options: { ...options } });
    during?.abort();
    if (!results.length) throw new Error("No fake result left");
    const next = results.shift();
    if (next && next.error != null) throw new Error(next.error);
    return next;
  };
  const provider = new TransformersChoiceProvider(pipeline, init.model);
  const module = new Choice(provider);
  return {
    id: () => provider.id,
    predict: (input) => provider.predict(input),
    predictAborted: (input, when) => {
      const controller = abortable(when);
      if (when === "during") during = controller;
      return provider.predict(input, controller.signal);
    },
    decide: (input, policy) => module.decide(input, given(policy)),
    calls: () => calls,
  };
}

export const subjects = {
  choice,
  "choice-jev": jev,
  "choice-transformers": transformers,
};
