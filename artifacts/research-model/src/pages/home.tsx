import React from "react";
import { Link } from "wouter";
import { Plus, Database, FileText, Share2, ArrowRight, Loader2, Calendar } from "lucide-react";
import { useListSessions, getListSessionsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { useT } from "@/lib/i18n";
import { GettingStarted } from "@/components/getting-started";
import { PersonalizationCard } from "@/components/personalization-card";

export default function Home() {
  const { t, lang } = useT();
  const { data: sessions, isLoading, error } = useListSessions({
    query: { queryKey: getListSessionsQueryKey() },
  });

  const dateLocale = lang === "zh" ? "yyyy年M月d日" : "MMM d, yyyy";

  return (
    <div className="space-y-8">
      <GettingStarted />
      <PersonalizationCard />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">{t("home.title" as any)}</h1>
          <p className="text-muted-foreground mt-1">{t("home.subtitle" as any)}</p>
        </div>
        <Link
          href="/sessions/new"
          data-testid="link-new-session"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 gap-2"
        >
          <Plus className="w-4 h-4" />
          {t("home.newSession" as any)}
        </Link>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="bg-destructive/10 text-destructive p-4 rounded-md border border-destructive/20">
          {t("home.failedLoad" as any)}
        </div>
      ) : sessions && sessions.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <Link key={session.id} href={`/sessions/${session.id}`} className="block group">
              <div className="bg-card border border-border rounded-lg p-5 h-full hover:border-primary/50 transition-all hover:shadow-md flex flex-col">
                <div className="flex justify-between items-start mb-2">
                  <h2 className="font-semibold text-lg text-foreground line-clamp-1 group-hover:text-primary transition-colors">
                    {session.name}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">{session.topic}</p>

                <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                  <div className="flex items-center gap-1.5" title={t("common.papers" as any)}>
                    <FileText className="w-4 h-4" />
                    <span>{session.paperCount}</span>
                  </div>
                  <div className="flex items-center gap-1.5" title={t("common.variables" as any)}>
                    <Database className="w-4 h-4" />
                    <span>{session.variableCount}</span>
                  </div>
                  <div className="flex items-center gap-1.5" title={t("common.models" as any)}>
                    <Share2 className="w-4 h-4" />
                    <span>{session.modelCount}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-auto pt-4 border-t border-border">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{format(new Date(session.updatedAt), dateLocale)}</span>
                  </div>
                  <span className="text-primary text-sm font-medium flex items-center gap-1 group-hover:translate-x-1 transition-transform">
                    {t("common.open" as any)} <ArrowRight className="w-4 h-4" />
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bg-card border border-dashed border-border rounded-lg p-12 text-center flex flex-col items-center">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
            <FileText className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-semibold mb-2">{t("home.empty.title" as any)}</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-6">{t("home.empty.body" as any)}</p>
          <Link
            href="/sessions/new"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 gap-2"
          >
            <Plus className="w-4 h-4" />
            {t("home.empty.cta" as any)}
          </Link>
        </div>
      )}
    </div>
  );
}
