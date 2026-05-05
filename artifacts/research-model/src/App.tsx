import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Home from "./pages/home";
import NewSession from "./pages/sessions/new";
import SessionLayout from "./pages/sessions/layout";
import SessionPapers from "./pages/sessions/papers";
import SessionVariables from "./pages/sessions/variables";
import SessionModels from "./pages/sessions/models";
import SessionModelDetail from "./pages/sessions/model-detail";
import { Layout } from "./components/layout";

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
        <Route path="/sessions/:id/models/:modelId" component={(props) => <SessionLayout><SessionModelDetail params={props.params} /></SessionLayout>} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
