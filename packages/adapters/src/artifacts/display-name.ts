export function artifactDisplayName(original: string, fallback = "attachment") {
  const safe = original
    .replace(/[\p{Cc}/\\]/gu, "_")
    .replace(/^\.+/, "")
    .trim();
  let name = "";
  for (const character of safe) {
    if (name.length + character.length > 255) break;
    name += character;
  }
  return name || fallback;
}
