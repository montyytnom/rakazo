import { describe, expect, it } from "vitest";
import { intentDeliveryKey, runDeliveryKey, sameFinalText } from "./handoff-delivery.js";

describe("handoff delivery keys", () => {
  it("scopes result delivery to the source intent, not two run finals", () => {
    expect(intentDeliveryKey("msg-1", "result")).toBe("auto-outcome:msg-1:result");
    expect(intentDeliveryKey("msg-1", "result")).not.toBe(runDeliveryKey("run-1", "result"));
    expect(sameFinalText("Assigned.\n", "Assigned.")).toBe(true);
    expect(sameFinalText("Assigned.", "Pending.")).toBe(false);
  });
});
