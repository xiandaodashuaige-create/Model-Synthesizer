import React from "react";
import { Link } from "wouter";
import { BookOpen, Activity, LayoutDashboard, Settings } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground">
            <Activity className="w-5 h-5" />
          </div>
          <span className="font-serif font-bold text-xl text-foreground">Research Model Builder</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm font-medium text-muted-foreground">
          <Link href="/" className="flex items-center gap-2 hover:text-foreground transition-colors">
            <LayoutDashboard className="w-4 h-4" />
            Sessions
          </Link>
          <a href="#" className="flex items-center gap-2 hover:text-foreground transition-colors">
            <Settings className="w-4 h-4" />
            Settings
          </a>
        </nav>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8">
        {children}
      </main>
    </div>
  );
}
