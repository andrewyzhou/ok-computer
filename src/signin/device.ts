// deviceName gives a short name of a user agent for the settings page, for example "Chrome on macOS", "Safari on
// iPhone" or "Edge on Windows". a missing or unknown agent gives "Unknown device".
export function deviceName(userAgent: string | null | undefined): string {
  void userAgent;
  throw new Error('not built: deviceName');
}
