import React from "react";
import { Link, useRoute, useLocation, useParams } from "wouter";
import { useGetSession, getGetSessionQueryKey, useGetSessionSummary, getGetSessionSummaryQueryKey } from "@workspace/api-client-react";
import { FileText, Database, Share2, ChevronRight, Loader2, Home as HomeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export default function SessionLayout({ children }: { children: React.ReactNode }) {
  const routeParams = useParams<{ id: string }>();
  const sessionId = routeParams.id ? parseInt(routeParams.id, 10) : 0;
  const [location] = useLocation();

  const { data: session, isLoading: isSessionLoading } = useGetSession(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionQueryKey(sessionId)
    }
  });

  const { data: summary } = useGetSessionSummary(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey: getGetSessionSummaryQueryKey(sessionId)
    }
  });

  if (isSessionLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="bg-destructive/10 text-destructive p-4 rounded-md border border-destructive/20 text-center py-12">
        <h2 className="text-lg font-semibold">Session not found</h2>
        <Link href="/" className="mt-4 inline-block underline hover:no-underline">Return to dashboard</Link>
      </div>
    );
  }

  const tabs = [
    { name: "Papers", href: `/sessions/${sessionId}/papers`, icon: FileText, count: summary?.paperCount ?? 0 },
    { name: "Variables", href: `/sessions/${sessionId}/variables`, icon: Database, count: summary?.variableCount ?? 0 },
    { name: "Models", href: `/sessions/${sessionId}/models`, icon: Share2, count: summary?.modelCount ?? 0 }
  ];

  return (
    <div className="space-y-6">
      {/* Breadcrumbs & Header */}
      <div>
        <nav className="flex items-center text-sm text-muted-foreground mb-4">
          <Link href="/" className="hover:text-foreground transition-colors flex items-center gap-1.5">
            <HomeIcon className="w-3.5 h-3.5" />
            Sessions
          </Link>
          <ChevronRight className="w-4 h-4 mx-2 opacity-50" />
          <span className="font-medium text-foreground truncate max-w-[300px]" title={session.name}>
            {session.name}
          </span>
        </nav>
        
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm mb-6">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-serif font-bold text-foreground mb-2">{session.name}</h1>
              <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">{session.topic}</p>
            </div>
            <div className="shrink-0">
              <span className="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground uppercase tracking-wider">
                Status: {session.status}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Workspace Navigation */}
      <div className="border-b border-border">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          {tabs.map((tab) => {
            const isActive = location === tab.href || location.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.name}
                href={tab.href}
                className={cn(
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  "group inline-flex items-center border-b-2 py-4 px-1 text-sm font-medium transition-colors"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <tab.icon
                  className={cn(
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                    "-ml-0.5 mr-2 h-4 w-4 transition-colors"
                  )}
                  aria-hidden="true"
                />
                <span>{tab.name}</span>
                {tab.count > 0 && (
                  <span
                    className={cn(
                      isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground group-hover:bg-muted/80",
                      "ml-2 rounded-full py-0.5 px-2.5 text-xs font-medium transition-colors"
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

      {/* Main Workspace Content Area */}
      <div className="pt-2">
        {children}
      </div>
    </div>
  );
}
