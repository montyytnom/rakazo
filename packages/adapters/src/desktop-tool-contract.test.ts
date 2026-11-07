import { describe, expect, it } from "vitest";
import {
  DESKTOP_LAUNCH_UNSUPPORTED,
  desktopSendToolName,
  sandboxLaunchUnsupported,
} from "./desktop-tool-contract.js";

describe("desktop tool contract", () => {
  it("does not treat sandbox launch_app 500 as a send", () => {
    expect(
      sandboxLaunchUnsupported(
        'sandbox action failed: 500 {"error":"unsupported computer action"}',
      ),
    ).toBe(true);
    expect(desktopSendToolName("launch_app")).toBe(false);
    expect(desktopSendToolName("mac_messages_send")).toBe(true);
    expect(DESKTOP_LAUNCH_UNSUPPORTED).toMatch(/installed_search_tools/);
  });
});
