/**
 * Minimal CSV → row-object parser for the A1 import flow. Good enough for a
 * CopyDog-style export (header row + simple comma-separated values, basic
 * double-quote handling); not a general-purpose CSV library.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
  };

  const [headerLine, ...rowLines] = lines;
  const headers = parseLine(headerLine);

  return rowLines.map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

/** A cell a spreadsheet would run as a formula (CSV injection): one that
 * starts with = + - @, a tab or a carriage return. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Plain numbers (a negative PnL, "-12.5") are data, not formulas. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * RFC 4180 CSV from rows; cells with commas, quotes or newlines are quoted.
 * A text cell that starts like a formula gets a leading `'` so Excel,
 * Sheets and LibreOffice show it instead of evaluating it: coin names,
 * labels and other strings come from users and upstream APIs. Numbers,
 * negative ones included, are left alone.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (value: string | number | null | undefined) => {
    let s = value === null || value === undefined ? "" : String(value);
    if (typeof value !== "number" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Save a CSV in the browser (with a BOM so Excel reads UTF-8). */
export function downloadCsv(fileName: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
