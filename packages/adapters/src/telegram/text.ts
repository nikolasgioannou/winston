// Plain text avoids interpreting model output as Telegram markup. URLs remain intact.
export function splitTelegramText(input: string): string[] {
  if (!input.trim() || input.length > 1_000_000) throw new Error("Invalid Telegram text length.");
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };

  for (const token of input.match(/\S+|\s+/gu) ?? []) {
    if (token.length > 4096 && /^(?:https?|tg):\/\//i.test(token))
      throw new Error("Telegram URL is too long; send it as a file instead.");
    if (current.length + token.length > 4096) flush();
    for (const character of token) {
      if (current.length + character.length > 4096) flush();
      current += character;
    }
  }
  flush();

  return parts;
}
