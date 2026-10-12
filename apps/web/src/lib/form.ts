/** A text field from a submitted form; '' when missing or a file. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * A number typed on an Arabic keyboard (٣٫٥ or ۳٫۵) in the 0-9 digits and decimal point the API
 * reads; anything else is kept, so the API still names the field when it is not a number.
 */
export function asciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}
