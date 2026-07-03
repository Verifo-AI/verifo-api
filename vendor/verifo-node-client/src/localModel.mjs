const OLLAMA_URL = process.env.VERIFO_OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.VERIFO_OLLAMA_MODEL || "llama3.2";
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Attempts to run the given prompt against a local Ollama install. Returns
 * `{ ok: true, output }` on a real local-model completion, or
 * `{ ok: false, reason }` when the contributor's machine can't run it
 * locally (Ollama not installed/running, model missing, request failed).
 * This is what keeps provenance honest — we never fabricate a local result.
 */
const ENGLISH_ONLY_SYSTEM =
  "Always respond in English, regardless of the language the user writes in. If asked to translate into another language, the translated text itself may be in that language, but all of your own explanations and surrounding text must stay in English.";

export async function runLocalModel(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, system: ENGLISH_ONLY_SYSTEM, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, reason: `Ollama responded with status ${res.status}` };
    }

    const data = await res.json();
    if (typeof data.response !== "string" || data.response.trim().length === 0) {
      return { ok: false, reason: "Ollama returned an empty response" };
    }

    return { ok: true, output: data.response };
  } catch (err) {
    const reason =
      err.name === "AbortError"
        ? "Local model timed out"
        : err.code === "ECONNREFUSED" || /fetch failed/i.test(err.message || "")
        ? "Ollama is not running on this machine"
        : `Local model error: ${err.message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
