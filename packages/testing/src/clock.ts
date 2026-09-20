export class TestClock {
  #milliseconds: number;

  constructor(instant: string) {
    const milliseconds = Date.parse(instant);

    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("The test clock needs a valid initial instant.");
    }

    this.#milliseconds = milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    const next = this.#milliseconds + milliseconds;

    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      !Number.isFinite(new Date(next).getTime())
    ) {
      throw new RangeError("Clock advancement must be a valid nonnegative integer duration.");
    }

    this.#milliseconds = next;
  }
}
