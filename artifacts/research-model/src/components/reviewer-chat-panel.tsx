import React, { useState, useRef, useEffect } from "react";
import { useSendReviewerChatMessage } from "@workspace/api-client-react";
import type { ReviewerChatMessage } from "@workspace/api-client-react";
import { Bot, Send, Loader2, User, MessageSquare } from "lucide-react";
import { useT } from "@/lib/i18n";

interface Props {
  sessionId: number;
  modelId: number;
}

export function ReviewerChatPanel({ sessionId, modelId }: Props) {
  const { t } = useT();
  const [history, setHistory] = useState<ReviewerChatMessage[]>([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const sendMutation = useSendReviewerChatMessage();

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || sendMutation.isPending) return;
    setInput("");

    const optimisticMsg: ReviewerChatMessage = {
      role: "user",
      content: msg,
      ts: new Date().toISOString(),
    };
    setHistory((prev) => [...prev, optimisticMsg]);

    sendMutation.mutate(
      { id: sessionId, modelId, data: { message: msg } },
      {
        onSuccess: (res) => {
          setHistory(res.history);
        },
        onError: () => {
          setHistory((prev) => prev.filter((m) => m !== optimisticMsg));
        },
      },
    );
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const isEmpty = history.length === 0;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
        <MessageSquare className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">
          {t("reviewerChat.title" as any)}
        </h2>
      </div>

      <div className="min-h-[180px] max-h-[420px] overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-[140px] gap-2 text-muted-foreground">
            <Bot className="w-8 h-8 opacity-40" />
            <p className="text-xs text-center leading-relaxed max-w-xs">
              {t("reviewerChat.empty" as any)}
            </p>
          </div>
        ) : (
          history.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
            >
              <div
                className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {msg.role === "user" ? (
                  <User className="w-3.5 h-3.5" />
                ) : (
                  <Bot className="w-3.5 h-3.5" />
                )}
              </div>
              <div
                className={`max-w-[80%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {sendMutation.isPending && (
          <div className="flex gap-2.5">
            <div className="shrink-0 w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center mt-0.5">
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className="bg-muted rounded-lg px-3.5 py-2.5 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t("reviewerChat.thinking" as any)}
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border px-4 py-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={t("reviewerChat.placeholder" as any)}
          disabled={sendMutation.isPending}
          className="flex-1 text-sm bg-background border border-input rounded-md px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sendMutation.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {sendMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          {t("reviewerChat.send" as any)}
        </button>
      </div>
    </div>
  );
}
