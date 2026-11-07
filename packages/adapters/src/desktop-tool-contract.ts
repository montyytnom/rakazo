const UNSUPPORTED = /unsupported computer action|500/;

export const DESKTOP_LAUNCH_UNSUPPORTED =
  "Sandbox launch_app is not available here. Search installed desktop tools (installed_search_tools) for the host Messages skill and send on that path. Do not retry launch_app.";

export function sandboxLaunchUnsupported(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return UNSUPPORTED.test(text);
}

export function desktopSendToolName(name: string): boolean {
  return /mac_messages_send|messages_send|desktop_sensitive_action|desktop_launch/i.test(name);
}
