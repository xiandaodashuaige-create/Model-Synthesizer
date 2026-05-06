import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/replit-auth-web";
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
import { Button } from "@/components/ui/button";
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

function LoginGate() {
  const { t } = useT();
  const { isLoading, isAuthenticated, login } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        {t("auth.loading" as any)}
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6 px-6 text-center">
        <h1 className="font-serif font-bold text-3xl text-foreground">{t("brand.name" as any)}</h1>
        <p className="text-muted-foreground max-w-md">{t("auth.signInPrompt" as any)}</p>
        <Button onClick={login} data-testid="login-button">{t("auth.signIn" as any)}</Button>
      </div>
    );
  }
  return <Router />;
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
