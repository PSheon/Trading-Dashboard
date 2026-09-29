"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { ImportLeaderListResponse } from "@trading-dashboard/shared";

import { ApiError, api } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** A1: leader list CSV/JSON upload. Parsing happens client-side; the api's
 * /import/lists endpoint owns column mapping, dedupe, and history backfill
 * (A1/A2/A5) once implemented. */
export default function ImportPage() {
  const [fileName, setFileName] = useState<string>();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [parseError, setParseError] = useState<string>();

  const importMutation = useMutation<
    ImportLeaderListResponse,
    ApiError,
    void
  >({
    mutationFn: () =>
      api.post<ImportLeaderListResponse>("/import/lists", {
        source: "copydog",
        fileName: fileName ?? "unknown",
        rows,
      }),
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(undefined);
    setFileName(file.name);
    importMutation.reset();

    try {
      const text = await file.text();
      if (file.name.endsWith(".json")) {
        const parsed = JSON.parse(text);
        setRows(Array.isArray(parsed) ? parsed : [parsed]);
      } else {
        setRows(parseCsv(text));
      }
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to parse file",
      );
      setRows([]);
    }
  }

  const previewRows = rows.slice(0, 5);
  const columns = previewRows.length > 0 ? Object.keys(previewRows[0]) : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Import leader list
        </h1>
        <p className="text-sm text-muted-foreground">
          Upload a CopyDog top100 CSV/JSON export (A1). Each upload creates a
          new list version.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Upload</CardTitle>
          <CardDescription>
            Accepts .csv or .json. The first row of a CSV is used as column
            headers.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="list-file">File</Label>
            <Input
              id="list-file"
              type="file"
              accept=".csv,.json"
              onChange={handleFileChange}
            />
          </div>

          {parseError ? (
            <p className="text-sm text-destructive">{parseError}</p>
          ) : null}

          {rows.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Parsed {rows.length} row{rows.length === 1 ? "" : "s"} from{" "}
                {fileName}. Preview:
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {columns.map((col) => (
                        <TableHead key={col}>{col}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row, i) => (
                      <TableRow key={i}>
                        {columns.map((col) => (
                          <TableCell key={col}>
                            {String(row[col] ?? "")}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          <Button
            disabled={rows.length === 0 || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? "Importing..." : "Import list"}
          </Button>

          {importMutation.isError ? (
            <p className="text-sm text-destructive">
              Import failed: {importMutation.error.message}
            </p>
          ) : null}

          {importMutation.isSuccess ? (
            <p className="text-sm text-emerald-500">
              Imported list #{importMutation.data.listId} —{" "}
              {importMutation.data.itemCount} items,{" "}
              {importMutation.data.newAddresses.length} new addresses.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
