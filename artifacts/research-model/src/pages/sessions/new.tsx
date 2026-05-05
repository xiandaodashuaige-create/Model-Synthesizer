import React, { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateSession } from "@workspace/api-client-react";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  name: z.string().min(1, "Session name is required").max(100),
  topic: z.string().min(10, "Please provide a more detailed research topic").max(1000),
});

type FormValues = z.infer<typeof formSchema>;

export default function NewSession() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createSession = useCreateSession();
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      topic: "",
    }
  });

  const onSubmit = (data: FormValues) => {
    createSession.mutate({ data }, {
      onSuccess: (session) => {
        toast({
          title: "Session created",
          description: "Your research workspace is ready.",
        });
        setLocation(`/sessions/${session.id}/papers`);
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error?.error || "Failed to create session.",
          variant: "destructive"
        });
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto py-8">
      <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4 mr-1.5" />
        Back to Sessions
      </Link>
      
      <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
        <div className="bg-primary/5 p-6 border-b border-border">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-primary text-primary-foreground w-10 h-10 rounded-lg flex items-center justify-center shadow-sm">
              <Sparkles className="w-5 h-5" />
            </div>
            <h1 className="text-2xl font-serif font-bold text-foreground">New Research Session</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Define your research parameters. We'll use this topic to help you discover relevant literature and synthesize models.
          </p>
        </div>

        <div className="p-6">
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Session Name
              </label>
              <input
                id="name"
                {...form.register("name")}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="e.g., AI adoption in healthcare..."
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="topic" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Research Topic
              </label>
              <p className="text-xs text-muted-foreground mb-2">
                Be specific. Describe the problem domain, theoretical lens, or the specific relationships you are interested in exploring.
              </p>
              <textarea
                id="topic"
                {...form.register("topic")}
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                placeholder="I am researching the factors that influence the adoption of generative AI tools among healthcare professionals, specifically looking at trust, perceived risk, and institutional support..."
              />
              {form.formState.errors.topic && (
                <p className="text-sm text-destructive">{form.formState.errors.topic.message}</p>
              )}
            </div>

            <div className="pt-4 flex justify-end">
              <button
                type="submit"
                disabled={createSession.isPending}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-8"
              >
                {createSession.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Initializing Workspace...
                  </>
                ) : (
                  "Create Session Workspace"
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
