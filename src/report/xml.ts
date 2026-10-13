/** XML 1.0 Fifth Edition Char production; preserve valid scalars and whitespace. */
export function escapeXml(value: unknown): string {
  let text = '';
  for (const scalar of String(value)) {
    const code = scalar.codePointAt(0)!;
    const allowed =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (!allowed) text += `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;
    else {
      switch (scalar) {
        case '&':
          text += '&amp;';
          break;
        case '<':
          text += '&lt;';
          break;
        case '>':
          text += '&gt;';
          break;
        case '"':
          text += '&quot;';
          break;
        case "'":
          text += '&apos;';
          break;
        case '\t':
          text += '&#x9;';
          break;
        case '\n':
          text += '&#xA;';
          break;
        case '\r':
          text += '&#xD;';
          break;
        default:
          text += scalar;
      }
    }
  }
  return text;
}
