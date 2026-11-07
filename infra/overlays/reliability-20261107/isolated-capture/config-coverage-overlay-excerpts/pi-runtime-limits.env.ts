const MODEL_STREAM_TIMEOUT_MS = (() => {
  const v = Number(process.env.RAKAZO_MODEL_STREAM_TIMEOUT_MS?.trim() || "");
  return Number.isFinite(v) && v >= 10_000 ? v : 120_000;
})();
const MODEL_STREAM_IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.RAKAZO_MODEL_STREAM_IDLE_TIMEOUT_MS?.trim() || "");
  return Number.isFinite(v) && v >= 10_000 ? v : 180_000;
})();
void MODEL_STREAM_TIMEOUT_MS;
void MODEL_STREAM_IDLE_TIMEOUT_MS;
const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
void value;
