import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { files, outboundMessages } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import type { ExecResult } from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { asc, eq } from "drizzle-orm";
import type { OutgoingFile, TelegramSender } from "../telegram/sender.ts";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";
import { attachTool, groupFiles, sendsAsPhoto } from "./attach.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

describe("sendsAsPhoto", () => {
  const image = { extension: "jpg", size: 500_000, width: 1600, height: 1200 };
  test("ordinary photos go as photos", () => {
    expect(sendsAsPhoto(image)).toBe(true);
    expect(sendsAsPhoto({ ...image, extension: "png" })).toBe(true);
  });
  test("big, huge, extreme or unusual images go as documents", () => {
    expect(sendsAsPhoto({ ...image, size: 11 * 1024 * 1024 })).toBe(false);
    expect(sendsAsPhoto({ ...image, width: 9000, height: 3000 })).toBe(false);
    expect(sendsAsPhoto({ ...image, width: 4200, height: 200 })).toBe(false);
    expect(sendsAsPhoto({ ...image, extension: "heic" })).toBe(false);
    expect(sendsAsPhoto({ ...image, width: 0, height: 0 })).toBe(false);
  });
});

test("groupFiles keeps order and never mixes kinds in an album", () => {
  const p = { kind: "photo" };
  const d = { kind: "document" };
  expect(groupFiles([p, p, d, p]).map((g) => g.length)).toEqual([2, 1, 1]);
  expect(
    groupFiles(Array.from({ length: 12 }, () => p)).map((g) => g.length),
  ).toEqual([10, 2]);
});

/** Files on the fake VM, by path as the model writes it: [size, width, height]. */
const disk: Record<string, [number, number, number]> = {
  "~/inbox/dog.jpg": [400_000, 1600, 1200],
  "~/inbox/cat.jpg": [300_000, 1200, 900],
  "~/Documents/scan.png": [12 * 1024 * 1024, 4000, 3000],
  "~/Documents/lease.pdf": [2_400_000, 0, 0],
  "~/Documents/wedding.mp4": [60 * 1024 * 1024, 0, 0],
};

function fakeVm(options: { down?: boolean } = {}) {
  const reads: string[] = [];
  const vm: VmClient = {
    fetchExec: () => Promise.resolve(undefined),
    holdBrowser: () => Promise.resolve(null),
    releaseBrowser: () => Promise.resolve(),
    closeBrowser: () => Promise.resolve(),
    transferBrowser: () => Promise.resolve(null),
    exec: (_userId, request) => {
      if (options.down)
        return Promise.reject(new GatewayError("vm_unavailable", "down"));
      const path = request.env.F ?? "";
      const file = disk[path];
      const stdout =
        path === "~/Documents"
          ? "not_a_file"
          : path === "/etc/passwd"
            ? "outside_home"
            : file
              ? `file ${String(file[0])} ${String(file[1])} ${String(file[2])}\n${path.slice(2)}`
              : "missing";
      const result: ExecResult = {
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
      return Promise.resolve(result);
    },
    readFile: (_userId, path) => {
      reads.push(path);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    writeFile: () => Promise.resolve(),
  };
  return { vm, reads };
}

function fakeTelegram() {
  const uploads: OutgoingFile[][] = [];
  let id = 100;
  const telegram: TelegramSender = {
    sendMessage: () => Promise.resolve({ message_id: 1 }),
    sendRichMessage: () => Promise.resolve({ message_id: 1 }),
    sendRichMessageDraft: () => Promise.resolve(true),
    sendChatAction: () => Promise.resolve(true),
    sendFiles: (_chatId, list) => {
      uploads.push([...list]);
      return Promise.resolve(
        list.map((file) => {
          id += 1;
          return { messageId: id, fileId: `tg-${file.name}` };
        }),
      );
    },
  };
  return { telegram, uploads };
}

async function attach(
  tx: DbOrTx,
  paths: string[],
  vm = fakeVm(),
  telegram = fakeTelegram(),
) {
  const user = await insertUser(tx);
  const run = await insertRun(tx, user.id);
  const tool = attachTool({
    db: tx,
    vm: vm.vm,
    telegram: telegram.telegram,
    logger,
    userId: user.id,
    runId: run.id,
    chatId: 42,
  });
  const output = await tool.execute(
    { paths },
    { toolCallId: "c1", messages: [], context: {} },
  );
  return { output, userId: user.id, vm, telegram };
}

describe("attach", () => {
  test("photos go as one album, documents on their own, in order, and each is recorded", async () => {
    await inRollback(db, async (tx) => {
      const { output, userId, telegram } = await attach(tx, [
        "~/inbox/dog.jpg",
        "~/inbox/cat.jpg",
        "~/Documents/lease.pdf",
        "~/Documents/scan.png",
      ]);
      expect(output).toBe(
        "Sent dog.jpg (391 KB, as a photo), cat.jpg (293 KB, as a photo), lease.pdf (2.3 MB), scan.png (12 MB).",
      );
      expect(
        telegram.uploads.map((group) =>
          group.map((file) => `${file.kind}:${file.name}`),
        ),
      ).toEqual([
        ["photo:dog.jpg", "photo:cat.jpg"],
        // The PDF and the oversized scan are both documents, so they share an album.
        ["document:lease.pdf", "document:scan.png"],
      ]);
      const sent = await tx
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.userId, userId))
        .orderBy(asc(outboundMessages.sentAt), asc(outboundMessages.id));
      expect(sent.map((row) => row.text).sort()).toEqual(
        [
          "[file: ~/inbox/dog.jpg]",
          "[file: ~/inbox/cat.jpg]",
          "[file: ~/Documents/lease.pdf]",
          "[file: ~/Documents/scan.png]",
        ].sort(),
      );
      const recorded = await tx
        .select()
        .from(files)
        .where(eq(files.userId, userId));
      expect(
        recorded.find((f) => f.vmPath === "~/Documents/lease.pdf"),
      ).toMatchObject({
        mime: "application/pdf",
        size: 2_400_000,
        telegramFileId: "tg-lease.pdf",
      });
    });
  });

  test("any bad path sends nothing and says why", async () => {
    await inRollback(db, async (tx) => {
      const { output, telegram, vm } = await attach(tx, [
        "~/inbox/dog.jpg",
        "~/nope.pdf",
        "~/Documents",
        "/etc/passwd",
      ]);
      expect(output).toBe(
        "Nothing sent: there's no file at ~/nope.pdf; ~/Documents is a directory, not a file; /etc/passwd is outside your home folder; copy it there first.",
      );
      expect(telegram.uploads).toEqual([]);
      expect(vm.reads).toEqual([]);
    });
  });

  test("a file over Telegram's 50 MB limit is refused with its size", async () => {
    await inRollback(db, async (tx) => {
      const { output, telegram } = await attach(tx, [
        "~/Documents/wedding.mp4",
      ]);
      expect(output).toBe(
        "Nothing sent: ~/Documents/wedding.mp4 is 60 MB; Telegram only takes files up to 50 MB.",
      );
      expect(telegram.uploads).toEqual([]);
    });
  });

  test("an unreachable computer is explained", async () => {
    await inRollback(db, async (tx) => {
      const { output } = await attach(
        tx,
        ["~/inbox/dog.jpg"],
        fakeVm({ down: true }),
      );
      expect(output).toBe(
        "Nothing sent: your computer isn't reachable right now.",
      );
    });
  });
});
