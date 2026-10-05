/** `next/root-params` is compiled by Next; unit tests render pages on their
 * own, in the default locale. */
export async function locale(): Promise<string> {
  return "zh-TW";
}
