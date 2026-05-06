import { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/replit-auth-web";
import { Sparkles, Database, Network, FileSearch, ArrowRight, ShieldCheck, Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";

import Home from "./pages/home";
import NewSession from "./pages/sessions/new";
import SessionLayout from "./pages/sessions/layout";
import SessionPapers from "./pages/sessions/papers";
import SessionVariables from "./pages/sessions/variables";
import SessionModels from "./pages/sessions/models";
import SessionModelsCompare from "./pages/sessions/models-compare";
import SessionModelDetail from "./pages/sessions/model-detail";
import SessionLiveModel from "./pages/sessions/live-model";
import { Layout } from "./components/layout";
import { useT } from "@/lib/i18n";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/sessions/new" component={NewSession} />
        <Route path="/sessions/:id" component={(props) => <SessionLayout><SessionPapers params={props.params} /></SessionLayout>} />
        <Route path="/sessions/:id/papers" component={(props) => <SessionLayout><SessionPapers params={props.params} /></SessionLayout>} />
        <Route path="/sessions/:id/variables" component={(props) => <SessionLayout><SessionVariables params={props.params} /></SessionLayout>} />
        <Route path="/sessions/:id/models" component={(props) => <SessionLayout><SessionModels params={props.params} /></SessionLayout>} />
        {/* `compare` route must be declared BEFORE `:modelId` so wouter doesn't
            capture the literal "compare" segment as a modelId. */}
        <Route path="/sessions/:id/models/compare" component={(props) => <SessionLayout><SessionModelsCompare params={props.params} /></SessionLayout>} />
        <Route path="/sessions/:id/models/:modelId" component={(props) => <SessionLayout><SessionModelDetail params={props.params} /></SessionLayout>} />
        <Route path="/sessions/:id/live-model" component={(props) => <SessionLayout><SessionLiveModel params={props.params} /></SessionLayout>} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Shared cosmic-grid backdrop used by both the initial sign-in screen and the
// session-expired overlay. Layers (in z-order, bottom up):
//   1. Deep navy gradient base
//   2. Two slow-pulsing radial "orbs" (primary + cyan) drifting behind glass
//   3. A subtle dotted grid suggesting a neural lattice
//   4. A vertical "scan line" that drifts top→bottom every 8s
// The whole thing renders inside a `<div className="ai-aurora">` and the
// keyframes live in `index.css`.
function AIAurora({ children, fixed = false }: { children: React.ReactNode; fixed?: boolean }) {
  return (
    <div className={`${fixed ? "fixed inset-0 z-[1000]" : "min-h-screen"} relative overflow-hidden bg-[#0a1228] text-slate-100`}>
      {/* Orbs */}
      <div
        aria-hidden
        className="ai-orb absolute -top-32 -left-32 h-[28rem] w-[28rem] rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(closest-side, hsl(220 90% 55% / 0.55), transparent 70%)" }}
      />
      <div
        aria-hidden
        className="ai-orb absolute -bottom-40 -right-32 h-[32rem] w-[32rem] rounded-full opacity-50 blur-3xl"
        style={{
          background: "radial-gradient(closest-side, hsl(190 90% 55% / 0.45), transparent 70%)",
          animationDelay: "-4s",
        }}
      />
      {/* Dotted grid */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(180,200,255,0.6) 1px, transparent 0)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(ellipse at center, black 35%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 35%, transparent 80%)",
        }}
      />
      {/* Scan line */}
      <div aria-hidden className="ai-scanline absolute inset-x-0 h-px pointer-events-none" />
      {/* Top hairline */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      {children}
    </div>
  );
}

// Tiny floating language switcher used only on the unauthenticated screens
// (sign-in card + session-expired overlay). Once the user is authenticated,
// the persistent app shell already provides a switcher. Without this, an
// English-speaking visitor lands on the (default) zh-CN UI with no way to
// switch before signing in.
function AuthLangSwitcher() {
  const { lang, setLang } = useT();
  const opts: Array<{ code: "zh" | "zhTW" | "en"; label: string }> = [
    { code: "zh", label: "简" },
    { code: "zhTW", label: "繁" },
    { code: "en", label: "EN" },
  ];
  return (
    <div className="absolute top-5 right-5 z-10 flex items-center gap-1 rounded-full border border-white/10 bg-slate-950/40 backdrop-blur-md px-1 py-1 text-xs">
      {opts.map((o) => (
        <button
          key={o.code}
          onClick={() => setLang(o.code)}
          data-testid={`auth-lang-${o.code}`}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            lang === o.code
              ? "bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/50"
              : "text-slate-300/80 hover:text-white hover:bg-white/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LoginGate() {
  const { t } = useT();
  const { isLoading, isAuthenticated, login } = useAuth();
  // Listen for global 401 events dispatched by the api-client when any request
  // comes back Unauthorized. Without this, an expired OIDC session silently
  // breaks every card on the page (model generation, AI usage, etc.) with no
  // way for the user to recover except a manual page reload.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    function onUnauthorized() {
      setSessionExpired(true);
    }
    window.addEventListener("api:unauthorized", onUnauthorized);
    return () => window.removeEventListener("api:unauthorized", onUnauthorized);
  }, []);
  if (isLoading) {
    return (
      <AIAurora>
        <div className="relative min-h-screen flex flex-col items-center justify-center gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-cyan-300" />
          <span className="text-sm text-slate-300/80 tracking-widest uppercase">
            {t("auth.loading" as any)}
          </span>
        </div>
      </AIAurora>
    );
  }
  if (!isAuthenticated) {
    return (
      <AIAurora>
        <AuthLangSwitcher />
        <div className="relative min-h-screen flex items-center justify-center px-4 py-10">
          <div
            data-testid="login-card"
            className="ai-card relative w-full max-w-lg rounded-2xl border border-white/10 bg-slate-950/40 backdrop-blur-xl p-8 sm:p-10 shadow-[0_0_60px_-15px_rgba(56,189,248,0.35)]"
          >
            {/* Glow border */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, rgba(56,189,248,0.35), transparent 40%, rgba(99,102,241,0.3))",
                WebkitMask:
                  "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                WebkitMaskComposite: "xor",
                maskComposite: "exclude",
                padding: 1,
              }}
            />

            {/* Brand */}
            <div className="flex items-center gap-3">
              <div className="ai-logo-glow relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400/30 to-indigo-500/30 ring-1 ring-cyan-300/40">
                <Sparkles className="h-5 w-5 text-cyan-200" />
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] uppercase tracking-[0.32em] text-cyan-300/80">
                  {t("auth.tagline" as any)}
                </span>
                <h1 className="font-serif font-semibold text-2xl text-white leading-tight">
                  {t("brand.name" as any)}
                </h1>
              </div>
            </div>

            {/* Hero copy */}
            <p className="mt-6 text-sm leading-relaxed text-slate-300/90">
              {t("auth.signInPrompt" as any)}
            </p>

            {/* Feature bullets */}
            <ul className="mt-6 grid gap-3 text-sm">
              {[
                { icon: FileSearch, key: "auth.feature.papers" },
                { icon: Database, key: "auth.feature.variables" },
                { icon: Network, key: "auth.feature.models" },
              ].map(({ icon: Icon, key }) => (
                <li key={key} className="flex items-start gap-3 text-slate-200/90">
                  <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-cyan-400/10 ring-1 ring-cyan-300/30">
                    <Icon className="h-3.5 w-3.5 text-cyan-200" />
                  </span>
                  <span>{t(key as any)}</span>
                </li>
              ))}
            </ul>

            {/* CTA */}
            <button
              onClick={login}
              data-testid="login-button"
              className="ai-cta group relative mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-400 to-indigo-500 px-5 py-3 text-sm font-semibold text-slate-950 transition-transform hover:scale-[1.01] active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              <span>{t("auth.signIn" as any)}</span>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>

            {/* Footer note */}
            <div className="mt-5 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-400/80">
              <ShieldCheck className="h-3 w-3" />
              <span>{t("auth.footerSecure" as any)}</span>
            </div>
          </div>
        </div>
      </AIAurora>
    );
  }
  return (
    <>
      <Router />
      {sessionExpired && (
        <AIAurora fixed>
          <div
            data-testid="overlay-session-expired"
            className="relative h-full w-full flex items-center justify-center px-4"
          >
            <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-slate-950/60 backdrop-blur-xl p-7 shadow-[0_0_60px_-15px_rgba(56,189,248,0.45)]">
              {/* Glow border */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(244,114,182,0.35), transparent 40%, rgba(56,189,248,0.3))",
                  WebkitMask:
                    "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                  WebkitMaskComposite: "xor",
                  maskComposite: "exclude",
                  padding: 1,
                }}
              />

              <div className="flex items-start gap-3">
                <div className="ai-logo-glow flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-rose-400/30 to-cyan-400/30 ring-1 ring-rose-300/40">
                  <ShieldCheck className="h-5 w-5 text-rose-200" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-[0.28em] text-rose-300/80">
                    SESSION
                  </span>
                  <h2 className="font-serif font-semibold text-lg text-white leading-tight">
                    {t("auth.expired.title" as any)}
                  </h2>
                </div>
              </div>

              <p className="mt-5 text-sm leading-relaxed text-slate-300/90">
                {t("auth.expired.body" as any)}
              </p>

              <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  onClick={() => setSessionExpired(false)}
                  data-testid="button-dismiss-session-expired"
                  className="inline-flex items-center justify-center rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/10 transition-colors"
                >
                  {t("auth.expired.dismiss" as any)}
                </button>
                <button
                  onClick={login}
                  data-testid="button-relogin"
                  className="ai-cta group inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-cyan-400 to-indigo-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-transform hover:scale-[1.01] active:scale-[0.99]"
                >
                  <span>{t("auth.expired.relogin" as any)}</span>
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </button>
              </div>
            </div>
          </div>
        </AIAurora>
      )}
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <LoginGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
