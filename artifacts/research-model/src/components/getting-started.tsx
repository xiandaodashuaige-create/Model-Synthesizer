import React from "react";
import { Link } from "wouter";
import { FileText, Search, Database, Share2, Sparkles, ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n";

export function GettingStarted() {
  const { t } = useT();

  const steps = [
    { icon: Sparkles, titleKey: "gs.step1.title", bodyKey: "gs.step1.body" },
    { icon: Search, titleKey: "gs.step2.title", bodyKey: "gs.step2.body" },
    { icon: Database, titleKey: "gs.step3.title", bodyKey: "gs.step3.body" },
    { icon: Share2, titleKey: "gs.step4.title", bodyKey: "gs.step4.body" },
  ] as const;

  return (
    <div className="bg-gradient-to-br from-primary/5 via-card to-card border border-primary/20 rounded-xl p-6 md:p-8">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
          <Sparkles className="w-5 h-5" />
        </div>
        <h2 className="text-xl font-serif font-bold text-foreground">{t("gs.title" as any)}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">{t("gs.subtitle" as any)}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={i} className="flex items-start gap-3 p-3 rounded-md bg-background/60 border border-border">
              <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">{t(s.titleKey as any)}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t(s.bodyKey as any)}</p>
              </div>
            </div>
          );
        })}
      </div>

      <Link
        href="/sessions/new"
        className="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 transition-colors"
      >
        {t("gs.cta" as any)} <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
