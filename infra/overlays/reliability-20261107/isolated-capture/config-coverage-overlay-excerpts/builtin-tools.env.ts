const COORDSCALE = (() => {
  const n = Number(process.env.RAKAZO_COORD_SCALE ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
void COORDSCALE;
void (process.env.RAKAZO_BOT_ASK_WAIT && process.env.RAKAZO_BOT_ASK_WAIT !== "0");
