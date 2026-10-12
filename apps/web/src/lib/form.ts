/** A text field from a submitted form; '' when missing or a file. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * A number typed on an Arabic keyboard (٣٫٥ or ۳٫۵) in the 0-9 digits and decimal point the API
 * reads. The thousands separator ٬ is dropped only where it groups thousands (١٢٬٣٠٠): next to the
 * decimal point on the keypad, a slip (١٢٬٥) must stay visible to the API, which then names the
 * field, never silently become another amount. Anything else is kept for the API to refuse.
 */
export function asciiDigits(value: string): string {
  const mapped = value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, '.');
  return /^\d{1,3}(\u066c\d{3})+(\.\d*)?$/.test(mapped) ? mapped.replace(/\u066c/g, '') : mapped;
}
