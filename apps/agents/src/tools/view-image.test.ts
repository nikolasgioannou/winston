import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";
import { maxImageEdge, planImage, viewImageTool } from "./view-image.ts";

const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

describe("planImage", () => {
  test("small images in accepted formats pass through", () => {
    expect(
      planImage({ format: "PNG", width: 800, height: 600, bytes: 200_000 }),
    ).toEqual({ convert: false });
    expect(
      planImage({ format: "JPEG", width: 1568, height: 700, bytes: 400_000 }),
    ).toEqual({ convert: false });
  });

  test("unusual formats are converted: photos to JPEG, the rest to PNG", () => {
    expect(
      planImage({ format: "HEIC", width: 800, height: 600, bytes: 1 }),
    ).toEqual({ convert: true, to: "jpeg" });
    expect(
      planImage({ format: "TIFF", width: 800, height: 600, bytes: 1 }),
    ).toEqual({ convert: true, to: "png" });
  });

  test("large images are downscaled, by edge, area or bytes", () => {
    expect(
      planImage({
        format: "PNG",
        width: maxImageEdge + 1,
        height: 100,
        bytes: 1,
      }),
    ).toEqual({ convert: true, to: "png" });
    expect(
      planImage({ format: "JPEG", width: 1200, height: 1200, bytes: 1 }),
    ).toEqual({ convert: true, to: "jpeg" });
    expect(
      planImage({ format: "PNG", width: 500, height: 500, bytes: 6_000_000 }),
    ).toEqual({ convert: true, to: "png" });
  });
});

/** A VM answering the inspect and prepare scripts, and serving `bytes` for the read. */
function fakeVm(
  inspect: string,
  prepared = "800 600",
  options: { down?: boolean } = {},
) {
  const commands: { cmd: string; env: Record<string, string> }[] = [];
  const vm: VmClient = {
    exec: (_userId, request) => {
      if (options.down)
        return Promise.reject(new GatewayError("vm_unavailable", "down"));
      commands.push({ cmd: request.cmd, env: request.env });
      const stdout = request.cmd.includes("identify -format '%m")
        ? inspect
        : request.cmd.includes("mkdir -p")
          ? prepared
          : "";
      const result: ExecResult = {
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
      return Promise.resolve(result);
    },
    readFile: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])),
    writeFile: () => Promise.resolve(),
  };
  return { vm, commands };
}

async function view(path: string, fake: ReturnType<typeof fakeVm>) {
  const viewImage = viewImageTool({ vm: fake.vm, logger, userId: "usr_1" });
  const output = await viewImage.execute(
    { path },
    { toolCallId: "c1", messages: [], context: {} },
  );
  return viewImage.toModelOutput?.({
    toolCallId: "c1",
    input: { path },
    output,
  } as never);
}

describe("view_image", () => {
  test("shows a small PNG as it is, with its size", async () => {
    const fake = fakeVm("image PNG 800 600 120000");
    const output = await view("~/shot.png", fake);
    expect(output).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "~/shot.png (800×600 PNG)" },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "iVBORw==" },
        },
      ],
    });
    // The path travels in the environment, never in the command text.
    expect(fake.commands[0]?.env).toEqual({ IMG: "~/shot.png" });
    expect(fake.commands.some((c) => c.cmd.includes("~/shot.png"))).toBe(false);
    expect(fake.commands[1]?.cmd).toContain("cp --");
  });

  test("converts an iPhone HEIC photo to a downscaled JPEG", async () => {
    const fake = fakeVm("image HEIC 4032 3024 2500000", "1239 929");
    const output = await view("~/inbox/IMG_0001.HEIC", fake);
    expect(fake.commands[1]?.cmd).toContain("convert --");
    expect(fake.commands[1]?.cmd).toContain("-quality 85");
    expect(output).toMatchObject({
      value: [
        {
          text: "~/inbox/IMG_0001.HEIC (4032×3024 HEIC, shown as 1239×929 JPEG)",
        },
        { mediaType: "image/jpeg" },
      ],
    });
  });

  test("missing files, directories and non-images are explained", async () => {
    expect(await view("~/nope.png", fakeVm("missing"))).toEqual({
      type: "text",
      value: "There's no file at ~/nope.png.",
    });
    expect(await view("~/inbox", fakeVm("not_a_file"))).toEqual({
      type: "text",
      value: "~/inbox is a directory, not an image.",
    });
    expect(await view("~/notes.md", fakeVm("not_an_image"))).toEqual({
      type: "text",
      value: "~/notes.md isn't an image I can read.",
    });
  });

  test("an unreachable computer is explained", async () => {
    const output = await view("~/a.png", fakeVm("", "", { down: true }));
    expect(output?.type).toBe("text");
    expect(JSON.stringify(output)).toContain("isn't reachable");
  });
});
