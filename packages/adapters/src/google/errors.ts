export class GoogleAccessError extends Error {
  constructor(readonly kind: "reconnect" | "limited" | "disconnected" | "unavailable") {
    super(`Google connection ${kind}.`);
  }
}
