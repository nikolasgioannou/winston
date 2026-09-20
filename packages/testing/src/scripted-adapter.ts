export type ScriptedOutcome<Output> = { value: Output } | { error: Error };

export class ScriptedAdapter<Input, Output> {
  readonly calls: Input[] = [];
  readonly #outcomes: ScriptedOutcome<Output>[];

  constructor(outcomes: readonly ScriptedOutcome<Output>[]) {
    this.#outcomes = [...outcomes];
  }

  async execute(input: Input): Promise<Output> {
    this.calls.push(structuredClone(input));

    // Keep the asynchronous boundary without introducing wall-clock delays.
    await Promise.resolve();

    const outcome = this.#outcomes.shift();

    if (!outcome) {
      throw new Error("Unexpected adapter call: no scripted outcome remains.");
    }

    if ("error" in outcome) {
      throw outcome.error;
    }

    return structuredClone(outcome.value);
  }

  assertExhausted(): void {
    if (this.#outcomes.length > 0) {
      throw new Error(`${this.#outcomes.length.toString()} scripted outcomes were not consumed.`);
    }
  }
}
