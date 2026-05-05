import React, { useEffect, useRef, useState } from "react";
import { useChatModelAssistant } from "@workspace/api-client-react";
import { Loader2, MessageSquare, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useT } from "@/lib/i18n";

type Attachment = { name: string; kind: "image" | "text"; data: string };
type ChatMsg = { role: "user" | "assistant"; content: string; attachments?: Attachment[] };
type Suggestion = { userPrompt?: string; focusVariableIds?: number[]; requiredOperators?: string[] };

export function ModelAssistantChat({
  sessionId,
  variableNameById,
  onApplySuggestion,
}: {
  sessionId: number;
  variableNameById: Map<number, string>;
  onApplySuggestion: (s: { userPrompt: string; focusVariableIds: number[] }) => void;
}) {
  const { t } = useT();
  const chat = useChatModelAssistant();

  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: t("models.assistant.greeting" as any) },
  ]);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [lastSuggestion, setLastSuggestion] = useState<Suggestion | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chat.isPending]);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const out: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (f.size > 5 * 1024 * 1024) continue;
      if (f.type.startsWith("image/")) {
        const data = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.readAsDataURL(f);
        });
        out.push({ name: f.name, kind: "image", data });
      } else {
        const text = await f.text();
        out.push({ name: f.name, kind: "text", data: text });
      }
    }
    setPendingAttachments((cur) => [...cur, ...out]);
  };

  const send = () => {
    const trimmed = input.trim();
    if (!trimmed && pendingAttachments.length === 0) return;
    if (chat.isPending) return;

    const newUserMsg: ChatMsg = {
      role: "user",
      content: trimmed,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
    };
    const next = [...messages, newUserMsg];
    setMessages(next);
    setInput("");
    setPendingAttachments([]);

    // Only send the latest message's attachments; for prior turns, replace binary data
    // with a short placeholder note so we don't blow up the request body each round.
    const payloadMessages = next.map((m, idx) => {
      if (idx === next.length - 1) {
        return { role: m.role, content: m.content, attachments: m.attachments };
      }
      if (m.attachments && m.attachments.length > 0) {
        const noteParts = m.attachments.map((a) => `[earlier attachment: ${a.name} (${a.kind})]`).join(" ");
        return { role: m.role, content: `${m.content}\n${noteParts}`.trim() };
      }
      return { role: m.role, content: m.content };
    });

    chat.mutate({
      id: sessionId,
      data: { messages: payloadMessages },
    }, {
      onSuccess: (resp) => {
        setMessages((cur) => [...cur, { role: "assistant", content: resp.reply ?? "" }]);
        if (resp.suggestion && (resp.suggestion.userPrompt || (resp.suggestion.focusVariableIds ?? []).length > 0)) {
          setLastSuggestion(resp.suggestion);
        }
      },
      onError: () => {
        setMessages((cur) => [...cur, { role: "assistant", content: t("models.assistant.failed" as any) }]);
      },
    });
  };

  const clear = () => {
    setMessages([{ role: "assistant", content: t("models.assistant.greeting" as any) }]);
    setPendingAttachments([]);
    setLastSuggestion(null);
  };

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col" data-testid="panel-assistant">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">{t("models.assistant.title" as any)}</h3>
        </div>
        {messages.length > 1 && (
          <button
            onClick={clear}
            data-testid="button-clear-chat"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="w-3 h-3" /> {t("models.assistant.clear" as any)}
          </button>
        )}
      </div>

      <div ref={scrollRef} className="px-4 py-3 max-h-[420px] overflow-y-auto space-y-3 bg-background/50">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              data-testid={`msg-${m.role}-${i}`}
              className={
                "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap " +
                (m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")
              }
            >
              {m.content}
              {m.attachments && m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.attachments.map((a, j) => (
                    <span key={j} className="text-[11px] bg-black/10 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                      <Paperclip className="w-2.5 h-2.5" /> {a.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {chat.isPending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-sm inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("models.assistant.thinking" as any)}
            </div>
          </div>
        )}
      </div>

      {lastSuggestion && (
        <div className="border-t border-emerald-200 bg-emerald-50/70 px-4 py-3 space-y-2" data-testid="panel-suggestion">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
            <Sparkles className="w-3.5 h-3.5" /> {t("models.assistant.suggestionTitle" as any)}
          </div>
          {lastSuggestion.userPrompt && (
            <p className="text-xs text-emerald-900 bg-white/70 rounded p-2 border border-emerald-200">{lastSuggestion.userPrompt}</p>
          )}
          {(lastSuggestion.focusVariableIds ?? []).length > 0 && (
            <div className="text-xs text-emerald-900">
              <span className="font-medium">{t("models.assistant.focusVars" as any)}:</span>{" "}
              {(lastSuggestion.focusVariableIds ?? []).map((id, i) => (
                <span key={id} className="inline-block bg-white border border-emerald-300 rounded px-1.5 py-0.5 mr-1 mb-1">
                  {variableNameById.get(id) ?? `#${id}`}
                </span>
              ))}
            </div>
          )}
          {(lastSuggestion.requiredOperators ?? []).length > 0 && (
            <div className="text-xs text-emerald-900">
              <span className="font-medium">{t("models.assistant.requiredOps" as any)}:</span>{" "}
              {(lastSuggestion.requiredOperators ?? []).map((op) => (
                <span key={op} className="inline-block bg-white border border-emerald-300 rounded px-1.5 py-0.5 mr-1 font-mono text-[10px]">
                  {op}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              const promptParts: string[] = [];
              if (lastSuggestion.userPrompt) promptParts.push(lastSuggestion.userPrompt);
              if ((lastSuggestion.requiredOperators ?? []).length > 0) {
                promptParts.push(`Use these structural operators where possible: ${lastSuggestion.requiredOperators!.join(", ")}.`);
              }
              onApplySuggestion({
                userPrompt: promptParts.join(" "),
                focusVariableIds: lastSuggestion.focusVariableIds ?? [],
              });
            }}
            data-testid="button-apply-suggestion"
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" /> {t("models.assistant.applySuggestion" as any)}
          </button>
        </div>
      )}

      <div className="border-t border-border p-3 space-y-2">
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pendingAttachments.map((a, i) => (
              <span key={i} className="text-xs bg-muted rounded px-2 py-1 inline-flex items-center gap-1.5">
                <Paperclip className="w-3 h-3" /> {a.name}
                <button onClick={() => setPendingAttachments((c) => c.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            data-testid="textarea-chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t("models.assistant.placeholder" as any)}
            rows={2}
            className="flex-1 text-sm rounded-md border border-input bg-background px-3 py-2 resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-col gap-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.txt,.md,.csv,.json"
              multiple
              hidden
              onChange={(e) => { handleFiles(e.target.files); if (fileRef.current) fileRef.current.value = ""; }}
            />
            <button
              data-testid="button-attach-file"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted h-9 w-9"
              title={t("models.assistant.attach" as any)}
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              data-testid="button-send-chat"
              onClick={send}
              disabled={chat.isPending || (!input.trim() && pendingAttachments.length === 0)}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 w-9 disabled:opacity-50"
              title={t("models.assistant.send" as any)}
            >
              {chat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
