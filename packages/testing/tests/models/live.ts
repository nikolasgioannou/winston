import assert from "node:assert/strict";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { collectReply } from "./conversation";

const key = process.env.OPENROUTER_API_KEY;
const audioPath = process.argv[2];

if (!key || !audioPath) {
  console.error(
    "Set OPENROUTER_API_KEY and pass a synthetic WAV file saying: Remind me to call Alex tomorrow.",
  );
  process.exit(1);
}

const audio = await Bun.file(audioPath).bytes();

if (audio.length > 1_000_000 || Buffer.from(audio.subarray(0, 4)).toString() !== "RIFF") {
  throw new Error("Use a synthetic WAV fixture smaller than 1 MB.");
}

const provider = createOpenRouter({ apiKey: key, compatibility: "strict" });
const candidates = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"] as const;
const options = { maxRetries: 0, maxOutputTokens: 2048 } as const;
const catalogSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const failures: string[] = [];

async function check(name: string, run: () => Promise<unknown>) {
  const started = performance.now();

  try {
    const details = await run();
    console.log(
      JSON.stringify({
        name,
        passed: true,
        elapsedMs: Math.round(performance.now() - started),
        details,
      }),
    );
  } catch (error) {
    failures.push(name);
    console.error(
      JSON.stringify({
        name,
        passed: false,
        category: APICallError.isInstance(error) ? "provider" : "validation",
        status: APICallError.isInstance(error) ? error.statusCode : undefined,
        errorType: error instanceof Error ? error.name : "unknown",
        assertion: error instanceof assert.AssertionError ? error.message : undefined,
      }),
    );
  }
}

async function catalog(query: string) {
  const response = await fetch(`https://openrouter.ai/api/v1/models${query}`, {
    signal: AbortSignal.timeout(30_000),
  });

  assert.equal(response.status, 200);

  return catalogSchema.parse(await response.json()).data.map(({ id }) => id);
}

await check("catalog", async () => {
  const chat = await catalog("");
  const transcription = await catalog("?output_modalities=transcription");

  for (const id of candidates) {
    assert.ok(chat.includes(id));
  }

  assert.ok(transcription.includes("openai/gpt-transcribe"));

  return { candidates, transcription: "openai/gpt-transcribe" };
});

if (failures.length > 0) {
  process.exit(1);
}

for (const id of candidates) {
  const model = provider(id, { reasoning: { effort: "low" } });

  await check(`${id}:streaming-steering`, async () => {
    const result = await collectReply(
      model,
      [
        { role: "user", content: "Remind me to call Alex tomorrow at 9." },
        { role: "user", content: "Make it 10 instead." },
        {
          role: "user",
          content: "Actually cancel that. Just tell me the final time I had requested.",
        },
      ],
      AbortSignal.timeout(60_000),
      undefined,
      "Apply all user corrections. Acknowledge the final request briefly without claiming to have created a reminder.",
    );

    assert.match(result.text, /10|ten/i);

    return result;
  });

  await check(`${id}:ambiguous-routing`, async () => {
    const result = await generateText({
      ...options,
      model,
      abortSignal: AbortSignal.timeout(60_000),
      system:
        "Do not guess accounts or devices. Ask a clarification when either is ambiguous; choose no account or device until clarified.",
      prompt:
        "Email the report from my computer. Accounts: personal, work. Computers: laptop, desktop. No default, report path, or recipient has been supplied.",
      output: Output.object({
        schema: z.object({
          action: z.enum(["clarify", "execute"]),
          account: z.string().nullable(),
          device: z.string().nullable(),
          question: z.string(),
        }),
      }),
    });

    assert.equal(result.output.action, "clarify");
    assert.equal(result.output.account, null);
    assert.equal(result.output.device, null);
    assert.ok(result.output.question.length > 0);

    return result.output;
  });
}

await check("worker:tool-round-trip", async () => {
  const calls: string[] = [];
  const result = await generateText({
    ...options,
    model: provider("openai/gpt-5.6-sol", { reasoning: { effort: "low" } }),
    abortSignal: AbortSignal.timeout(60_000),
    prompt:
      "Use the computer tool to run pwd exactly once, then tell me the returned working directory.",
    stopWhen: stepCountIs(2),
    tools: {
      computer: tool({
        description: "A synthetic computer fixture; only pwd is supported.",
        inputSchema: z.object({ command: z.literal("pwd") }),
        execute: ({ command }) => {
          calls.push(command);

          return { stdout: "/home/winston" };
        },
      }),
    },
  });

  assert.deepEqual(calls, ["pwd"]);
  assert.match(result.text, /\/home\/winston/);

  return { calls, text: result.text, steps: result.steps.length };
});

await check("stream:cancel-after-first-token", async () => {
  const controller = new AbortController();
  let receivedText = false;

  await assert.rejects(
    collectReply(
      provider("openai/gpt-5.6-luna", { reasoning: { effort: "low" } }),
      [{ role: "user", content: "Count from 1 to 100, spelling each number on its own line." }],
      AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      () => {
        receivedText = true;
        controller.abort();
      },
    ),
    { name: "AbortError" },
  );

  assert.equal(receivedText, true);

  return { canceled: true };
});

await check("voice:transcription", async () => {
  const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(65_000),
    body: JSON.stringify({
      model: "openai/gpt-transcribe",
      input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
      language: "en",
    }),
  });

  assert.equal(response.status, 200);

  const result = z.object({ text: z.string() }).parse(await response.json());
  assert.match(result.text, /remind me to call Alex tomorrow/i);

  return result;
});

process.exitCode = failures.length > 0 ? 1 : 0;
