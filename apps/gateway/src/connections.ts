/** Anything the registry can close: a websocket, or a test double. */
export interface Closable {
  close(code?: number, reason?: string): void;
}

/** Close code sent to a connection that a newer one replaced. */
export const replacedCloseCode = 4000;

/**
 * The live connection for each VM. Exactly one per VM: a new connection
 * replaces (and closes) the old one.
 */
export class Connections<Socket extends Closable> {
  private readonly byVm = new Map<string, Socket>();

  add(vmId: string, socket: Socket) {
    const previous = this.byVm.get(vmId);
    this.byVm.set(vmId, socket);
    previous?.close(replacedCloseCode, "replaced by a newer connection");
  }

  /** Forgets `socket`, unless a newer connection already replaced it. */
  remove(vmId: string, socket: Socket) {
    if (this.byVm.get(vmId) === socket) this.byVm.delete(vmId);
  }

  get(vmId: string) {
    return this.byVm.get(vmId);
  }

  get size() {
    return this.byVm.size;
  }
}
