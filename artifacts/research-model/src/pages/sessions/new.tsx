import React from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateSession } from "@workspace/api-client-react";
import { ArrowLeft, Loader2, Sparkles, Lightbulb } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

export default function NewSession() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createSession = useCreateSession();

  const formSchema = z.object({
    name: z.string().min(1, t("new.field.name.required" as any)).max(100),
    topic: z.string().min(10, t("new.field.topic.required" as any)).max(1000),
  });
  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", topic: "" },
  });

  const onSubmit = (data: FormValues) => {
    createSession.mutate(
      { data },
      {
        onSuccess: (session) => {
          toast({
            title: t("new.toast.created" as any),
            description: t("new.toast.createdDesc" as any),
          });
          setLocation(`/sessions/${session.id}/papers`);
        },
        onError: (error: any) => {
          toast({
            title: t("new.toast.failed" as any),
            description: error?.error || t("common.tryAgain" as any),
            variant: "destructive",
          });
        },
      },
    );
  };

  const fillExample = (text: string) => {
    form.setValue("topic", text, { shouldValidate: true });
    if (!form.getValues("name")) {
      form.setValue("name", text.slice(0, 24), { shouldValidate: true });
    }
  };

  const examples = [
    t("new.examples.1" as any),
    t("new.examples.2" as any),
    t("new.examples.3" as any),
  ];

  return (
    <div className="max-w-2xl mx-auto py-8">
      <Link
        href="/"
        className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4 mr-1.5" />
        {t("new.back" as any)}
      </Link>

      <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
        <div className="bg-primary/5 p-6 border-b border-border">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-primary text-primary-foreground w-10 h-10 rounded-lg flex items-center justify-center shadow-sm">
              <Sparkles className="w-5 h-5" />
            </div>
            <h1 className="text-2xl font-serif font-bold text-foreground">{t("new.title" as any)}</h1>
          </div>
          <p className="text-muted-foreground text-sm">{t("new.subtitle" as any)}</p>
        </div>

        <div className="p-6">
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium leading-none">
                {t("new.field.name" as any)}
              </label>
              <input
                id="name"
                data-testid="input-session-name"
                {...form.register("name")}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={t("new.field.name.ph" as any)}
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="topic" className="text-sm font-medium leading-none">
                {t("new.field.topic" as any)}
              </label>
              <p className="text-xs text-muted-foreground mb-2">{t("new.field.topic.hint" as any)}</p>
              <textarea
                id="topic"
                data-testid="input-session-topic"
                {...form.register("topic")}
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                placeholder={t("new.field.topic.ph" as any)}
              />
              {form.formState.errors.topic && (
                <p className="text-sm text-destructive">{form.formState.errors.topic.message}</p>
              )}
            </div>

            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-4">
              <div className="flex items-center gap-2 mb-2">
                <Lightbulb className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  {t("new.examples.title" as any)}
                </p>
              </div>
              <div className="space-y-1.5">
                {examples.map((ex, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => fillExample(ex)}
                    className="w-full text-left text-xs text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded px-2 py-1.5 transition-colors leading-relaxed"
                  >
                    · {ex}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                data-testid="button-create-session"
                disabled={createSession.isPending}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-8 disabled:opacity-50 disabled:pointer-events-none"
              >
                {createSession.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("new.submitting" as any)}
                  </>
                ) : (
                  t("new.submit" as any)
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
