/**
 * Providers without native PDF input get the document's extracted text instead.
 * The text travels beside the Anthropic document block in a WeakMap, so the
 * block itself stays a valid Anthropic payload.
 */
const texts = new WeakMap<object, string>();

export function setPdfText(block: object, text: string | undefined): void {
  if (text && text.trim()) texts.set(block, text);
}

export function getPdfText(block: object): string | undefined {
  return texts.get(block);
}
