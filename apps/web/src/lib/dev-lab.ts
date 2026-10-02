/** The lab (design concepts and the Orbie-only extras) is a development
 * tool: a production server answers 404 unless NEXT_DEV_LAB=1 is set on it. */
export function labEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_DEV_LAB === "1";
}
