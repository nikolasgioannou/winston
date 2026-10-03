import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { costLedger, files, inboundItems, jobs } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import type { ExecResult } from "@winston/domain/frames";
import { renderUserMessage } from "@winston/domain/envelope";
import {
  userMessagePayloadSchema,
  type Attachment,
} from "@winston/domain/inbound";
import {
  frontTurnJob,
  saveAttachmentJob,
  transcribeVoiceJob,
} from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import {
  fallbackName,
  maxShownTextBytes,
  safeFileName,
  saveAttachmentHandler,
  transcribeVoiceHandler,
} from "./attachments.ts";
import type { BlobStore } from "./blobs.ts";
import type { TelegramFiles } from "./telegram/files.ts";
import type { Transcriber } from "./transcribe.ts";
import { GatewayError, type VmClient } from "./vm/gateway-client.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

describe("safeFileName", () => {
  test("keeps ordinary names, including spaces and non-Latin letters", () => {
    expect(safeFileName("Lease 2026.pdf", "x")).toBe("Lease 2026.pdf");
    expect(safeFileName("résumé 履歴書.docx", "x")).toBe("résumé 履歴書.docx");
  });

  test("drops directories, control characters and leading dots", () => {
    expect(safeFileName("../../etc/passwd", "x")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\notes.txt", "x")).toBe("notes.txt");
    expect(safeFileName(".bashrc", "x")).toBe("bashrc");
    expect(safeFileName("bad\u0000na\u202eme\n.txt", "x")).toBe("badname.txt");
  });

  test("falls back when nothing is left", () => {
    expect(safeFileName(undefined, "photo-140312.jpg")).toBe(
      "photo-140312.jpg",
    );
    expect(safeFileName("..", "fallback")).toBe("fallback");
    expect(safeFileName("  / ", "fallback")).toBe("fallback");
  });

  test("shortens long names but keeps the extension", () => {
    const name = safeFileName(`${"a".repeat(300)}.pdf`, "x");
    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith("a.pdf")).toBe(true);
  });
});

test("fallbackName names a file by kind, time and type", () => {
  const photo: Attachment = {
    kind: "photo",
    telegramFileId: "f",
    mimeType: "image/jpeg",
    status: "pending",
  };
  expect(fallbackName(photo, "140312")).toBe("photo-140312.jpg");
  expect(
    fallbackName({ ...photo, kind: "video", mimeType: "video/x-odd" }, "0901"),
  ).toBe("video-0901");
});

/**
 * A VM that answers the scripts the job runs: reserving a name (the
 * requested one, or "name (2)" if `taken`), pdfinfo, and view_image's
 * inspect and prepare.
 */
function fakeVm(
  options: {
    taken?: boolean;
    pdfInfo?: string;
    image?: string;
    down?: boolean;
  } = {},
) {
  const execs: { cmd: string; env: Record<string, string> }[] = [];
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const answer = (cmd: string, env: Record<string, string>) => {
    if (cmd.includes("set -C")) {
      const name = env.NAME ?? "";
      return options.taken ? name.replace(/(\.\w+)?$/, " (2)$1") : name;
    }
    if (cmd.includes("pdfinfo")) return options.pdfInfo ?? "3 no";
    if (cmd.includes("identify -format '%m"))
      return options.image ?? "image JPEG 1280 960 180000";
    if (cmd.includes("mkdir -p ~/.winston/view")) return "1280 960";
    return "";
  };
  const vm: VmClient = {
    fetchExec: () => Promise.resolve(undefined),
    holdBrowser: () => Promise.resolve(null),
    releaseBrowser: () => Promise.resolve(),
    closeBrowser: () => Promise.resolve(),
    transferBrowser: () => Promise.resolve(null),
    exec: (_userId, request) => {
      if (options.down)
        return Promise.reject(new GatewayError("vm_unavailable", "down"));
      execs.push({ cmd: request.cmd, env: request.env });
      const result: ExecResult = {
        stdout: answer(request.cmd, request.env),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
      return Promise.resolve(result);
    },
    writeFile: (_userId, path, bytes) => {
      if (options.down)
        return Promise.reject(new GatewayError("vm_unavailable", "down"));
      writes.push({ path, bytes });
      return Promise.resolve();
    },
    readFile: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])),
  };
  return { vm, execs, writes };
}

function fakeTelegram(result: Uint8Array | "too_large") {
  const downloads: string[] = [];
  const telegram: TelegramFiles = {
    download: (fileId) => {
      downloads.push(fileId);
      return Promise.resolve(result);
    },
  };
  return { telegram, downloads };
}

function memoryBlobs() {
  const stored = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    put: (bytes) => {
      const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      stored.set(key, bytes);
      return Promise.resolve(key);
    },
    get: (key) => Promise.resolve(stored.get(key) ?? new Uint8Array()),
    delete: (key) => {
      stored.delete(key);
      return Promise.resolve();
    },
  };
  return { blobs, stored };
}

// 14:03:12 in Los Angeles on 2026-09-26.
const sentAt = new Date("2026-09-26T21:03:12Z");

async function heldItem(tx: DbOrTx, attachment: Omit<Attachment, "status">) {
  const user = await insertUser(tx, { timezone: "America/Los_Angeles" });
  const [item] = await tx
    .insert(inboundItems)
    .values({
      userId: user.id,
      type: "user_message",
      payload: {
        text: "",
        telegramMessageId: 1,
        attachment: { ...attachment, status: "pending" },
      },
      occurredAt: sentAt,
      pending: true,
    })
    .returning();
  if (!item) throw new Error("no item");
  return item;
}

async function runJob(
  tx: DbOrTx,
  itemId: string,
  deps: Parameters<typeof saveAttachmentHandler>[0],
  attempt = { attempts: 1, maxAttempts: 5 },
) {
  const job = {
    id: "job_1",
    type: saveAttachmentJob.type,
    payload: { inboundItemId: itemId },
    ...attempt,
  } as unknown as Job;
  await saveAttachmentHandler(deps)({
    job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });
  const [item] = await tx
    .select()
    .from(inboundItems)
    .where(eq(inboundItems.id, itemId));
  const payload = item?.payload as { attachment: Attachment } | undefined;
  return { item, attachment: payload?.attachment };
}

const photo = {
  kind: "photo" as const,
  telegramFileId: "tg-photo",
  mimeType: "image/jpeg",
  size: 180_000,
};

describe("save_attachment", () => {
  test("a photo is saved to the inbox, shown to the model, recorded, and its turn queued", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, photo);
      const vm = fakeVm();
      const { telegram, downloads } = fakeTelegram(new Uint8Array(180_000));
      const { blobs, stored } = memoryBlobs();
      const { item, attachment } = await runJob(tx, held.id, {
        vm: vm.vm,
        telegram,
        blobs,
      });

      expect(downloads).toEqual(["tg-photo"]);
      // Named by the local time it was sent, in a folder for the local date.
      expect(vm.execs[0]?.env).toEqual({
        DIR: "inbox/2026-09-26",
        NAME: "photo-140312.jpg",
      });
      expect(vm.writes.map((write) => write.path)).toEqual([
        "inbox/2026-09-26/photo-140312.jpg",
      ]);
      expect(item?.pending).toBe(false);
      expect(attachment).toMatchObject({
        status: "saved",
        path: "~/inbox/2026-09-26/photo-140312.jpg",
        size: 180_000,
        shown: { as: "image", mediaType: "image/jpeg" },
      });
      expect(stored.size).toBe(1);

      const [file] = await tx
        .select()
        .from(files)
        .where(eq(files.userId, held.userId));
      expect(file).toMatchObject({
        vmPath: "~/inbox/2026-09-26/photo-140312.jpg",
        mime: "image/jpeg",
        size: 180_000,
        telegramFileId: "tg-photo",
      });
      const queued = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.userId, held.userId));
      expect(queued.map((job) => job.type)).toEqual([frontTurnJob.type]);
    });
  });

  test("a name that's taken gets a number, and the name is kept for a retry", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        kind: "document",
        telegramFileId: "tg-doc",
        fileName: "notes.txt",
        mimeType: "text/plain",
      });
      const { blobs } = memoryBlobs();
      // The first attempt reserves a name, then the VM goes away.
      const reserved = fakeVm({ taken: true });
      const failing: VmClient = {
        ...reserved.vm,
        writeFile: () =>
          Promise.reject(new GatewayError("vm_unavailable", "down")),
      };
      const text = new TextEncoder().encode("milk\neggs\n");
      const first = await runJob(tx, held.id, {
        vm: failing,
        telegram: fakeTelegram(text).telegram,
        blobs,
      }).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(GatewayError);

      const retry = fakeVm();
      const { item, attachment } = await runJob(tx, held.id, {
        vm: retry.vm,
        telegram: fakeTelegram(text).telegram,
        blobs,
      });
      expect(retry.execs.some((exec) => exec.cmd.includes("set -C"))).toBe(
        false,
      );
      expect(retry.writes[0]?.path).toBe("inbox/2026-09-26/notes (2).txt");
      expect(item?.pending).toBe(false);
      expect(attachment).toMatchObject({
        status: "saved",
        path: "~/inbox/2026-09-26/notes (2).txt",
        shown: { as: "text" },
      });
    });
  });

  test("a file Telegram says is over 20 MB isn't downloaded at all", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        kind: "video",
        telegramFileId: "tg-video",
        fileName: "trip.mp4",
        mimeType: "video/mp4",
        size: 50 * 1024 * 1024,
      });
      const vm = fakeVm();
      const { telegram, downloads } = fakeTelegram(new Uint8Array(1));
      const { item, attachment } = await runJob(tx, held.id, {
        vm: vm.vm,
        telegram,
        blobs: memoryBlobs().blobs,
      });
      expect(downloads).toEqual([]);
      expect(vm.writes).toEqual([]);
      expect(item?.pending).toBe(false);
      expect(attachment).toEqual({
        kind: "video",
        telegramFileId: "tg-video",
        fileName: "trip.mp4",
        mimeType: "video/mp4",
        size: 50 * 1024 * 1024,
        status: "too_large",
      });
    });
  });

  test("a file of unknown size that turns out too large is reported the same way", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        kind: "video",
        telegramFileId: "tg-video",
      });
      const { attachment } = await runJob(tx, held.id, {
        vm: fakeVm().vm,
        telegram: fakeTelegram("too_large").telegram,
        blobs: memoryBlobs().blobs,
      });
      expect(attachment?.status).toBe("too_large");
      expect(
        await tx.select().from(files).where(eq(files.userId, held.userId)),
      ).toEqual([]);
    });
  });

  test("while retries remain a failure is retried; the last attempt releases the message as failed", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, photo);
      const deps = {
        vm: fakeVm({ down: true }).vm,
        telegram: fakeTelegram(new Uint8Array(10)).telegram,
        blobs: memoryBlobs().blobs,
      };
      const early = await runJob(tx, held.id, deps).catch(
        (error: unknown) => error,
      );
      expect(early).toBeInstanceOf(GatewayError);
      const [still] = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.id, held.id));
      expect(still?.pending).toBe(true);

      const { item, attachment } = await runJob(tx, held.id, deps, {
        attempts: 5,
        maxAttempts: 5,
      });
      expect(item?.pending).toBe(false);
      expect(attachment?.status).toBe("failed");
      expect(attachment?.path).toBeUndefined();
    });
  });

  test("PDFs are shown only when short and unencrypted; big text files aren't shown", async () => {
    await inRollback(db, async (tx) => {
      const pdf = {
        kind: "document" as const,
        telegramFileId: "tg-pdf",
        fileName: "lease.pdf",
        mimeType: "application/pdf",
      };
      const bytes = new Uint8Array(1000);
      const run = async (
        attachment: Omit<Attachment, "status">,
        vm: ReturnType<typeof fakeVm>,
        content = bytes,
      ) =>
        (
          await runJob(tx, (await heldItem(tx, attachment)).id, {
            vm: vm.vm,
            telegram: fakeTelegram(content).telegram,
            blobs: memoryBlobs().blobs,
          })
        ).attachment;

      expect((await run(pdf, fakeVm()))?.shown).toMatchObject({
        as: "pdf",
        mediaType: "application/pdf",
      });
      expect(
        (await run(pdf, fakeVm({ pdfInfo: "40 no" })))?.shown,
      ).toBeUndefined();
      expect(
        (await run(pdf, fakeVm({ pdfInfo: "2 yes" })))?.shown,
      ).toBeUndefined();
      const big = await run(
        { kind: "document", telegramFileId: "t", fileName: "log.txt" },
        fakeVm(),
        new Uint8Array(maxShownTextBytes + 1).fill(97),
      );
      expect(big).toMatchObject({ status: "saved" });
      expect(big?.shown).toBeUndefined();
    });
  });
});

describe("voice notes", () => {
  const voice = {
    kind: "voice" as const,
    telegramFileId: "tg-voice",
    mimeType: "audio/ogg",
    size: 14_000,
  };

  function fakeTranscriber(result: string | Error) {
    const calls: { bytes: number; format: string }[] = [];
    const transcriber: Transcriber = {
      transcribe: (audio, format) => {
        calls.push({ bytes: audio.length, format });
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve({ text: result, costUsd: 0.00018 });
      },
    };
    return { transcriber, calls };
  }

  async function transcribe(
    tx: DbOrTx,
    itemId: string,
    transcriber: Transcriber,
    attempt = { attempts: 1, maxAttempts: 5 },
  ) {
    const job = {
      id: "job_2",
      type: transcribeVoiceJob.type,
      payload: { inboundItemId: itemId },
      ...attempt,
    } as unknown as Job;
    await transcribeVoiceHandler({ vm: fakeVm().vm, transcriber })({
      job,
      db: tx as never,
      logger,
      extendLease: () => Promise.resolve(true),
    });
    const [item] = await tx
      .select()
      .from(inboundItems)
      .where(eq(inboundItems.id, itemId));
    return item;
  }

  const queuedTypes = async (tx: DbOrTx, userId: string) =>
    (await tx.select().from(jobs).where(eq(jobs.userId, userId))).map(
      (job) => job.type,
    );

  test("a saved voice note stays held and goes to transcription, not a turn", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, voice);
      const { item, attachment } = await runJob(tx, held.id, {
        vm: fakeVm().vm,
        telegram: fakeTelegram(new Uint8Array(14_000)).telegram,
        blobs: memoryBlobs().blobs,
      });
      expect(item?.pending).toBe(true);
      expect(attachment).toMatchObject({
        status: "saved",
        path: "~/inbox/2026-09-26/voice-140312.ogg",
      });
      expect(await queuedTypes(tx, held.userId)).toEqual([
        transcribeVoiceJob.type,
      ]);
      const recorded = await tx
        .select()
        .from(files)
        .where(eq(files.userId, held.userId));
      expect(recorded).toHaveLength(1);
    });
  });

  test("the transcript becomes the message text, marked as voice, and the turn is queued", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        ...voice,
        path: "~/inbox/2026-09-26/voice-140312.ogg",
      });
      await tx
        .update(inboundItems)
        .set({
          payload: {
            text: "",
            telegramMessageId: 1,
            attachment: {
              ...voice,
              status: "saved",
              path: "~/inbox/2026-09-26/voice-140312.ogg",
            },
          },
        })
        .where(eq(inboundItems.id, held.id));
      const { transcriber, calls } = fakeTranscriber(
        " Remind me to call Dana at 4:30. ",
      );
      const item = await transcribe(tx, held.id, transcriber);
      expect(calls).toEqual([{ bytes: 3, format: "ogg" }]);
      expect(item?.pending).toBe(false);
      expect(item?.payload).toMatchObject({
        text: "Remind me to call Dana at 4:30.",
        source: "voice",
      });
      const xml = renderUserMessage(
        {
          occurredAt: sentAt,
          payload: userMessagePayloadSchema.parse(item?.payload),
        },
        "America/Los_Angeles",
      );
      expect(xml).toContain("<source>voice</source>");
      expect(xml).toContain("<text>Remind me to call Dana at 4:30.</text>");
      const [cost] = await tx
        .select()
        .from(costLedger)
        .where(eq(costLedger.userId, held.userId));
      expect(cost).toMatchObject({ category: "stt", costUsd: "0.000180" });
      expect(await queuedTypes(tx, held.userId)).toEqual([frontTurnJob.type]);
    });
  });

  test("a failing transcription is retried, then released marked as failed with the audio kept", async () => {
    await inRollback(db, async (tx) => {
      const path = "~/inbox/2026-09-26/voice-140312.ogg";
      const held = await heldItem(tx, { ...voice, path });
      const { transcriber } = fakeTranscriber(new Error("upstream 502"));
      const early = await transcribe(tx, held.id, transcriber).catch(
        (error: unknown) => error,
      );
      expect(early).toBeInstanceOf(Error);

      const item = await transcribe(tx, held.id, transcriber, {
        attempts: 5,
        maxAttempts: 5,
      });
      expect(item?.pending).toBe(false);
      expect(item?.payload).toMatchObject({
        text: "",
        attachment: { path, transcriptionFailed: true },
      });
      expect(item?.payload).not.toHaveProperty("source");
    });
  });

  test("silence isn't retried: an empty transcript is released as failed at once", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        ...voice,
        path: "~/inbox/2026-09-26/voice-140312.ogg",
      });
      const item = await transcribe(
        tx,
        held.id,
        fakeTranscriber("  ").transcriber,
      );
      expect(item?.pending).toBe(false);
      expect(item?.payload).toMatchObject({
        attachment: { transcriptionFailed: true },
      });
    });
  });

  test("a round video note is sent as MP4", async () => {
    await inRollback(db, async (tx) => {
      const held = await heldItem(tx, {
        kind: "video_note",
        telegramFileId: "tg-round",
        mimeType: "video/mp4",
        path: "~/inbox/2026-09-26/video_note-140312.mp4",
      });
      const { transcriber, calls } = fakeTranscriber("hi");
      await transcribe(tx, held.id, transcriber);
      expect(calls[0]?.format).toBe("mp4");
    });
  });
});
