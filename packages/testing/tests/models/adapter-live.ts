import { createOpenRouterAdapter } from "@winston/adapters/models";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to run the opt-in model adapter check.");

const adapter = createOpenRouterAdapter(apiKey);
for (const role of ["conversation", "worker"] as const) {
  const result = await adapter.generate({
    role,
    messages: [
      {
        role: "user",
        content: "This is a synthetic connectivity check. Reply with exactly: WINSTON_OK",
      },
    ],
    signal: new AbortController().signal,
  });
  const passed = result.ok && result.text.trim() === "WINSTON_OK";
  console.log(
    JSON.stringify({ passed, ...result.attempt, ...(!result.ok ? { code: result.code } : {}) }),
  );
  if (!passed) process.exitCode = 1;
}
