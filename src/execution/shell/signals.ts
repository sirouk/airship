/**
 * Non-local control flow.
 *
 * `break`, `continue`, `return`, and `exit` are not exit statuses — a status
 * would have to be distinguished from a command that merely returned the same
 * number. They travel as distinct signal objects so the interpreter can never
 * confuse "the loop asked to stop" with "the loop's last command failed".
 *
 * They live in their own module so the builtins and the interpreter can both
 * reference them without an import cycle between the two.
 */
export class LoopSignal {
  constructor(readonly kind: "break" | "continue", public count: number) {}
}

export class ReturnSignal {
  constructor(readonly status: number) {}
}

export class ExitSignal {
  constructor(readonly status: number) {}
}
