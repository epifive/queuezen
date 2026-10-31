"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Download, FileUp, Loader2, XCircle } from "lucide-react";
import { importCsvAction } from "@/app/actions/dashboard/posts";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";
import { MESSAGES } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import type { CsvImportReport, CsvIssue } from "@/lib/engine/csv-import";
import { issueText } from "./composer-issues";

/** Bulk import of posts from CSV: paste or choose a file, check it (dry run), then import. */

const SAMPLE = [
  "text,channels,scheduled_at,queue,media_urls,link,first_comment,labels",
  '"Our autumn menu is here 🍂 Come by this weekend!","all","2026-11-02 09:30",,,https://example.com/menu,"Book a table: https://example.com/book","menu|autumn"',
  '"New blog post: 5 ways to plan a week of content",x|linkedin,,yes,,https://example.com/blog/plan,,blog',
  '"Draft idea: behind the scenes video",instagram,,,,,,ideas',
].join("\n");

export function CsvImport({ workspaceId, locale }: { workspaceId: number; locale: string }) {
  const t = useT();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [imported, setImported] = useState<CsvImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const base = `/dashboard/w/${workspaceId}`;

  const issue = (i: CsvIssue) => {
    if (i.platform) return issueText(t, { code: i.code, message: i.message ?? i.code, params: i.params }, i.platform, locale);
    const key = `dash.csv.err.${i.code}`;
    if (key in MESSAGES) return t(key as MessageKey, i.params);
    return i.message ?? i.code;
  };

  const run = (dryRun: boolean) =>
    start(async () => {
      setError(null);
      const r = await importCsvAction(workspaceId, csv, dryRun);
      if (!r.ok) return setError(r.error);
      if (r.report.fileError) return setError(t(`dash.csv.file.${r.report.fileError}` as MessageKey, { max: 500 }));
      if (dryRun) {
        setReport(r.report);
        setImported(null);
      } else setImported(r.report);
    });

  const shown = imported ?? report;
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium hover:border-primary-line">
            <FileUp className="size-4" aria-hidden />
            {t("dash.csv.choose")}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setCsv(await file.text());
                setReport(null);
                setImported(null);
              }}
            />
          </label>
          {fileName ? <bdi className="text-sm text-muted">{fileName}</bdi> : null}
          <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`} download="queuezen-sample.csv" className="ms-auto inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
            <Download className="size-4" aria-hidden />
            {t("dash.csv.sample")}
          </a>
        </div>
        <Textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setReport(null);
            setImported(null);
          }}
          rows={8}
          dir="ltr"
          placeholder={SAMPLE}
          aria-label={t("dash.csv.paste")}
          className="mt-4 font-mono text-xs"
        />
        <p className="mt-2 text-xs text-muted">{t("dash.csv.help")}</p>
        {error ? (
          <Alert tone="error" className="mt-4">
            {error}
          </Alert>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => run(true)} disabled={!csv.trim() || pending}>
            {pending && !report ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("dash.csv.check")}
          </Button>
          <Button onClick={() => run(false)} disabled={!report || !report.valid || pending || Boolean(imported)}>
            {pending && report ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("dash.csv.import", { n: report?.valid ?? 0 })}
          </Button>
        </div>
      </div>

      {imported ? (
        <Alert tone={imported.imported ? "success" : "warning"}>
          {t("dash.csv.done", { n: imported.imported })}{" "}
          <Link href={`${base}/calendar?view=list`} className="font-medium underline">
            {t("dash.csv.openCalendar")}
          </Link>
        </Alert>
      ) : null}

      {shown ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <p className="border-b border-line px-5 py-3 text-sm">
            <span className="font-semibold text-emerald-700 dark:text-emerald-400">{t("dash.csv.valid", { n: shown.valid })}</span>
            {" · "}
            <span className={cn("font-semibold", shown.invalid ? "text-red-600 dark:text-red-400" : "text-muted")}>{t("dash.csv.invalid", { n: shown.invalid })}</span>
          </p>
          <ul className="divide-y divide-line">
            {shown.rows.map((row) => (
              <li key={row.line} className="flex gap-3 px-5 py-3 text-sm">
                {row.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label={t("dash.csv.ok")} /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-label={t("dash.csv.bad")} />}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs text-muted tabular-nums">{t("dash.csv.line", { n: row.line })}</span>
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {row.excerpt || "—"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {t(`dash.csv.action.${row.action}`)}
                    {row.when ? ` · ${new Date(row.when).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
                    {row.channels.length ? ` · ${row.channels.join(", ")}` : ""}
                    {row.postId ? (
                      <>
                        {" · "}
                        <Link href={`${base}/posts/${row.postId}`} className="text-primary hover:underline">
                          {t("dash.csv.viewPost")}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  {row.errors.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-red-700 dark:text-red-400">
                      {row.errors.map((e, i) => (
                        <li key={i}>
                          {e.channel ? <bdi className="font-medium">{e.channel}: </bdi> : null}
                          {issue(e)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {row.warnings.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-amber-700 dark:text-amber-400">
                      {row.warnings.map((w, i) => (
                        <li key={i}>
                          {w.channel ? <bdi className="font-medium">{w.channel}: </bdi> : null}
                          {issue(w)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
