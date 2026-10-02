/**
 * Amount fields. A comma means different things to different people:
 * "12,5" is twelve and a half in most of Europe and Latin America, and
 * "1,250" is twelve hundred and fifty in the format this site prints. The
 * fields used to delete every comma, so "12,5" became 125: ten times the
 * amount, on a withdrawal form. Here a comma is either understood or the
 * input is refused; the magnitude is never changed silently.
 */

const GROUPED = /^\d{1,3}(?:[.,]\d{3})+$/;

/**
 * `text` (digits, "." and "," only) as a plain decimal string with "." as
 * the separator, or null when it can't be read without guessing.
 *
 * - no comma: as typed;
 * - both separators: the one that comes last is the decimal mark and the
 *   other groups thousands, which must then be groups of three
 *   ("1,250.50" and "1.250,50" are both 1250.50);
 * - several commas: thousands groups ("1,250,000");
 * - one comma: the decimal mark ("12,5" → "12.5", and a comma typed at the
 *   end becomes the point at once, so the field shows what will be sent),
 *   except "1,250": one to three digits, a comma, exactly three digits is
 *   a thousands group to some and 1.25 to others → null.
 */
export function normalizeAmount(text: string): string | null {
  if (/[^\d.,]/.test(text)) return null;
  if (!text.includes(",")) return text;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastDot >= 0) {
    const [group, decimal] = lastDot > lastComma ? [",", "."] : [".", ","];
    const cut = text.lastIndexOf(decimal);
    const whole = text.slice(0, cut);
    const fraction = text.slice(cut + 1);
    if (text.indexOf(decimal) !== cut || !/^\d*$/.test(fraction)) return null;
    if (!GROUPED.test(whole) || whole.includes(decimal)) return null;
    return `${whole.split(group).join("")}.${fraction}`;
  }
  if (lastComma !== text.indexOf(",")) return GROUPED.test(text) ? text.split(",").join("") : null;
  const whole = text.slice(0, lastComma);
  const fraction = text.slice(lastComma + 1);
  if (fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole)) return null;
  return `${whole}.${fraction}`;
}

/**
 * The next value of an amount field after the person typed or pasted
 * `raw`: spaces and anything that is not a digit or a separator are
 * dropped, separators are read by {@link normalizeAmount}, and an input
 * that can't be read keeps `previous` (the field does not change).
 */
export function amountInput(raw: string, previous: string): string {
  return normalizeAmount(raw.replace(/[^\d.,]/g, "")) ?? previous;
}
