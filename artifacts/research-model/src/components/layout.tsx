import React from "react";
import { Link } from "wouter";
import { Activity, LayoutDashboard, Languages, LogOut } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAuth } from "@workspace/replit-auth-web";

function LangSwitch() {
  const { lang, setLang, t } = useT();
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-xs font-medium">
      <Languages className="w-3.5 h-3.5 ml-2 text-muted-foreground" />
      <button
        type="button"
        onClick={() => setLang("zh")}
        data-testid="lang-zh"
        className={cn(
          "px-2.5 py-1 rounded transition-colors",
          lang === "zh" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t("nav.lang.zh" as any)}
      </button>
      <button
        type="button"
        onClick={() => setLang("zh-TW")}
        data-testid="lang-zh-tw"
        className={cn(
          "px-2.5 py-1 rounded transition-colors",
          lang === "zh-TW" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t("nav.lang.zhTW" as any)}
      </button>
      <button
        type="button"
        onClick={() => setLang("en")}
        data-testid="lang-en"
        className={cn(
          "px-2.5 py-1 rounded transition-colors",
          lang === "en" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t("nav.lang.en" as any)}
      </button>
    </div>
  );
}

function UserMenu() {
  const { t } = useT();
  const { user, logout } = useAuth();
  if (!user) return null;
  const label = user.firstName || user.email || user.id;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground hidden sm:inline" data-testid="auth-user-label">{label}</span>
      <button
        type="button"
        onClick={logout}
        data-testid="logout-button"
        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      >
        <LogOut className="w-3 h-3" />
        {t("auth.signOut" as any)}
      </button>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground">
            <Activity className="w-5 h-5" />
          </div>
          <span className="font-serif font-bold text-xl text-foreground">{t("brand.name" as any)}</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm font-medium text-muted-foreground">
          <Link href="/" className="flex items-center gap-2 hover:text-foreground transition-colors">
            <LayoutDashboard className="w-4 h-4" />
            {t("nav.sessions" as any)}
          </Link>
          <LangSwitch />
          <UserMenu />
        </nav>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8">{children}</main>
    </div>
  );
}
