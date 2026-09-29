/**
 * The sidebar's width is a preference kept in a cookie (not local storage),
 * so the server renders it and the sidebar doesn't jump after load. It's
 * not a secret, so the browser writes it.
 */
export const sidebarWidthCookie = "winston_sidebar_width";

export function saveSidebarWidth(width: number) {
  document.cookie = `${sidebarWidthCookie}=${String(Math.round(width))}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
