// XML 1.0 characters, excluding unpaired UTF-16 surrogates and forbidden controls.
export function isXmlText(value: string) {
  return /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u.test(value);
}

export function escapeXml(value: string) {
  if (!isXmlText(value)) {
    throw new Error("Text contains characters that XML cannot represent.");
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;");
}

// Names are internal literals; caller-controlled values are always escaped.
export function element(
  name: string,
  attributes: Record<string, string | number>,
  children: string = "",
) {
  const fields = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");

  return `<${name}${fields}>${children}</${name}>`;
}
