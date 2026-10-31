export class InputError extends Error {
  readonly field: string;
  readonly validValues: readonly string[];

  constructor(field: string, message: string, validValues: readonly string[] = []) {
    const validValueDetail = validValues.length > 0
      ? ` Valid values: ${validValues.join(", ")}.`
      : "";
    super(`${field}: ${message}.${validValueDetail}`);
    this.name = "InputError";
    this.field = field;
    this.validValues = validValues;
  }
}
