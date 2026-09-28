import { createHash } from "node:crypto";
import {
  newFrameId,
  type FileErrorCode,
  type GatewayToVmFrame,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import { VmUnavailableError } from "./execs.ts";

/** Chunks of at most this many bytes, base64 in a frame (docs/design.md §15). */
export const fileChunkBytes = 256 * 1024;
/** Uploads and downloads fail if the VM goes quiet this long. */
export const fileTransferTimeoutMs = 120_000;

export class FileTransferError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Where a frame went, so a transfer can fail when that socket closes. */
type Send = (vmId: string, frame: GatewayToVmFrame) => object | undefined;

interface Read {
  kind: "read";
  vmId: string;
  socket: object;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  started: (stream: ReadableStream<Uint8Array>) => void;
  failed: (error: Error) => void;
  stream: ReadableStream<Uint8Array>;
  hash: ReturnType<typeof createHash>;
  seq: number;
  begun: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Write {
  kind: "write";
  vmId: string;
  socket: object;
  resolve: (result: { size: number; sha256: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * File transfers with VMs (docs/design.md §15). A read resolves with a
 * stream as soon as bytes start arriving (so errors surface first), and is
 * checked against the VM's SHA-256 at the end. A write sends the size and
 * hash up front; the VM renames the file into place only if both match.
 */
export function createFileTransfers(send: Send) {
  const transfers = new Map<string, Read | Write>();

  const finish = (id: string) => {
    const transfer = transfers.get(id);
    if (transfer) clearTimeout(transfer.timer);
    transfers.delete(id);
    return transfer;
  };

  const fail = (id: string, error: Error) => {
    const transfer = finish(id);
    if (!transfer) return;
    if (transfer.kind === "write") transfer.reject(error);
    else if (transfer.begun) transfer.controller?.error(error);
    else transfer.failed(error);
  };

  const timeout = (id: string) =>
    setTimeout(() => {
      fail(
        id,
        new FileTransferError(
          "failed",
          "the VM stopped responding mid-transfer",
        ),
      );
    }, fileTransferTimeoutMs);

  return {
    /** Reads a file from a VM. Resolves once it's streaming; rejects if it can't be read. */
    read(vmId: string, path: string) {
      const id = newFrameId();
      return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
        const socket = send(vmId, { id, type: "file.read", path });
        if (!socket) {
          reject(new VmUnavailableError());
          return;
        }
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
          },
        });
        transfers.set(id, {
          kind: "read",
          vmId,
          socket,
          ...(controller ? { controller } : {}),
          started: resolve,
          failed: reject,
          stream,
          hash: createHash("sha256"),
          seq: 0,
          begun: false,
          timer: timeout(id),
        });
      });
    },

    /** Writes a file to a VM, atomically on the VM's side. */
    write(vmId: string, path: string, bytes: Uint8Array) {
      const id = newFrameId();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return new Promise<{ size: number; sha256: string }>(
        (resolve, reject) => {
          const socket = send(vmId, {
            id,
            type: "file.write",
            path,
            size: bytes.length,
            sha256,
          });
          if (!socket) {
            reject(new VmUnavailableError());
            return;
          }
          transfers.set(id, {
            kind: "write",
            vmId,
            socket,
            resolve,
            reject,
            timer: timeout(id),
          });
          let seq = 0;
          for (let at = 0; at < bytes.length; at += fileChunkBytes) {
            const data = Buffer.from(
              bytes.subarray(at, at + fileChunkBytes),
            ).toString("base64");
            send(vmId, {
              id: newFrameId(),
              type: "file.chunk",
              transferId: id,
              seq,
              data,
            });
            seq += 1;
          }
          send(vmId, { id: newFrameId(), type: "file.end", transferId: id });
        },
      );
    },

    /** Feeds a frame from a VM. Returns true if it was about a transfer. */
    handle(vmId: string, frame: VmToGatewayFrame) {
      if (
        frame.type !== "file.chunk" &&
        frame.type !== "file.done" &&
        frame.type !== "file.error"
      )
        return false;
      const transfer = transfers.get(frame.transferId);
      if (transfer?.vmId !== vmId) return true;

      if (frame.type === "file.error") {
        fail(
          frame.transferId,
          new FileTransferError(frame.code, frame.message),
        );
      } else if (transfer.kind === "write") {
        if (frame.type === "file.done") {
          finish(frame.transferId);
          transfer.resolve({ size: frame.size, sha256: frame.sha256 });
        }
      } else if (frame.type === "file.chunk") {
        if (frame.seq !== transfer.seq) {
          fail(
            frame.transferId,
            new FileTransferError("failed", "file chunks arrived out of order"),
          );
          return true;
        }
        transfer.seq += 1;
        const bytes = new Uint8Array(Buffer.from(frame.data, "base64"));
        transfer.hash.update(bytes);
        transfer.controller?.enqueue(bytes);
        if (!transfer.begun) {
          transfer.begun = true;
          transfer.started(transfer.stream);
        }
      } else {
        // file.done for a read: every byte arrived; check it's the file the VM hashed.
        finish(frame.transferId);
        if (transfer.hash.digest("hex") !== frame.sha256) {
          const error = new FileTransferError(
            "mismatch",
            "the file changed in transit",
          );
          if (transfer.begun) transfer.controller?.error(error);
          else transfer.failed(error);
          return true;
        }
        if (!transfer.begun) transfer.started(transfer.stream);
        transfer.controller?.close();
      }
      return true;
    },

    /** A VM's socket closed: its transfers on that socket can't finish. */
    closed(socket: object) {
      for (const [id, transfer] of transfers)
        if (transfer.socket === socket) fail(id, new VmUnavailableError());
    },
  };
}

export type FileTransfers = ReturnType<typeof createFileTransfers>;
