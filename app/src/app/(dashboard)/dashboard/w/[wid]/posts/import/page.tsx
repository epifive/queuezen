import type { Metadata } from "next";
import { CsvImport } from "@/components/dashboard/post-csv-import";
import { DashHeader } from "@/components/dashboard/ui";
import { Alert } from "@/components/ui/alert";
import { isDemoMode } from "@/lib/config";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.csv.title") };
}

/** Bulk import of posts from a CSV file. */
export default async function ImportPage({ params }: { params: Promise<{ wid: string }> }) {
  const { workspace } = await requireWorkspace((await params).wid, "editor");
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <>
      <DashHeader title={t("dash.csv.title")} description={t("dash.csv.subtitle", { tz: workspace.timezone.replaceAll("_", " ") })} />
      {isDemoMode() ? <Alert className="mb-5">{t("dash.csv.demo")}</Alert> : null}
      <CsvImport workspaceId={workspace.id} locale={locale.code} />
    </>
  );
}
