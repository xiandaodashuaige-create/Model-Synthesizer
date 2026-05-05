import React from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  useGetSession,
  getGetSessionQueryKey,
  useGetSessionSummary,
  getGetSessionSummaryQueryKey,
  useGetLiveModel,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { ChevronRight, Loader2, Home as HomeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { OnboardingStepper } from "@/components/onboarding-stepper";

export default function SessionLayout({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const routeParams = useParams<{ id: string }>();
  const sessionId = routeParams.id ? parseInt(routeParams.id, 10) : 0;
  const [location] = useLocation();

  const { data: session, isLoading: isSessionLoading } = useGetSession(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionQueryKey(sessionId) },
  });

  const { data: summary } = useGetSessionSummary(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionSummaryQueryKey(sessionId) },
  });

  const { data: liveModel } = useGetLiveModel(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetLiveModelQueryKey(sessionId) },
  });
  const liveCount = (liveModel?.nodes?.length ?? 0) + (liveModel?.edges?.length ?? 0);

  if (isSessionLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="bg-destructive/10 text-destructive p-6 rounded-md border border-destructive/20 text-center py-12">
        <h2 className="text-lg font-semibold">{t("ws.notFound" as any)}</h2>
        <Link href="/" className="mt-4 inline-block underline hover:no-underline">
          {t("ws.toDashboard" as any)}
        </Link>
      </div>
    );
  }

  const tabs = [
    { name: t("ws.tab.papers" as any), href: `/sessions/${sessionId}/papers`, count: summary?.paperCount ?? 0 },
    { name: t("ws.tab.variables" as any), href: `/sessions/${sessionId}/variables`, count: summary?.variableCount ?? 0 },
    { name: t("ws.tab.models" as any), href: `/sessions/${sessionId}/models`, count: summary?.modelCount ?? 0 },
    { name: t("ws.tab.live" as any), href: `/sessions/${sessionId}/live-model`, count: liveCount },
  ];

  const hasSelectedModel = (summary?.modelCount ?? 0) > 0 && !!(summary as any)?.hasSelectedModel;

  return (
    <div className="space-y-6">
      {/* Breadcrumbs & Header */}
      <div>
        <nav className="flex items-center text-sm text-muted-foreground mb-4">
          <Link href="/" className="hover:text-foreground transition-colors flex items-center gap-1.5">
            <HomeIcon className="w-3.5 h-3.5" />
            {t("ws.crumb.home" as any)}
          </Link>
          <ChevronRight className="w-4 h-4 mx-2 opacity-50" />
          <span className="font-medium text-foreground truncate max-w-[300px]" title={session.name}>
            {session.name}
          </span>
        </nav>

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm mb-4">
          <h1 className="text-2xl font-serif font-bold text-foreground mb-2">{session.name}</h1>
          <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">{session.topic}</p>
        </div>

        <OnboardingStepper
          sessionId={sessionId}
          paperCount={summary?.paperCount ?? 0}
          variableCount={summary?.variableCount ?? 0}
          modelCount={summary?.modelCount ?? 0}
          hasSelectedModel={hasSelectedModel}
        />
      </div>

      {/* Workspace Navigation */}
      <div className="border-b border-border">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          {tabs.map((tab) => {
            const isActive = location === tab.href || location.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  "group inline-flex items-center border-b-2 py-4 px-1 text-sm font-medium transition-colors",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <span>{tab.name}</span>
                {tab.count > 0 && (
                  <span
                    className={cn(
                      isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground group-hover:bg-muted/80",
                      "ml-2 rounded-full py-0.5 px-2.5 text-xs font-medium transition-colors",
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="pt-2">{children}</div>
    </div>
  );
}
