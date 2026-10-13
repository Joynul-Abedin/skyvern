/** Resolve root-relative services on the browser's origin, including TLS-aware WebSockets. */
export function resolveServiceUrl(
  value: string | undefined,
  origin = window.location.origin,
  websocket = false,
): string {
  if (!value) return "";
  if (!value.startsWith("/")) return value;
  const url = new URL(value, origin);
  if (websocket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
