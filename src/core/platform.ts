/**
 * The host OS, as the webview reports it.
 *
 * Tauri uses the platform's own WebView (WebView2, WebKitGTK, WKWebView), so
 * the user agent is stable enough for UI gating. Native-only features (screen
 * capture, clips, the Windows HUD) use this to disappear instead of offering a
 * button that can only fail.
 */

const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const IS_WINDOWS = /Windows/i.test(userAgent);
export const IS_MACOS = /Macintosh|Mac OS X/i.test(userAgent);
export const IS_LINUX = !IS_WINDOWS && !IS_MACOS;

/** Screen capture, clips and the Windows HUD are Windows-only today. */
export const HAS_NATIVE_CAPTURE = IS_WINDOWS;

export function platformName(): "windows" | "macos" | "linux" {
  if (IS_WINDOWS) return "windows";
  if (IS_MACOS) return "macos";
  return "linux";
}
