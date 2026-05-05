import React, { useEffect, useRef, useState } from "react";
import { useChatModelAssistant, useSearchModelImages } from "@workspace/api-client-react";
import { BookPlus, ExternalLink, Image as ImageIcon, Loader2, MessageSquare, Paperclip, Search, Send, Sparkles, Trash2, X } from "lucide-react";
import { useT } from "@/lib/i18n";

type ImageHit = {
  title: string;
  thumbnailUrl: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceDomain: string;
  width?: number;
  height?: number;
};

type Attachment = { name: string; kind: "image" | "text"; data: string };
type ChatMsg = { role: "user" | "assistant"; content: string; attachments?: Attachment[] };
type Suggestion = { userPrompt?: string; focusVariableIds?: number[]; requiredOperators?: string[] };
type NeedsMore = { reason: string; searchQuery?: string; missingConstructs?: string[] };

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
  const [lastNeedsMore, setLastNeedsMore] = useState<NeedsMore | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Image search state
  const imageSearch = useSearchModelImages();
  const [imgPanelOpen, setImgPanelOpen] = useState(false);
  const [imgQuery, setImgQuery] = useState("");
  const [imgRawMode, setImgRawMode] = useState(false);
  const [imgResults, setImgResults] = useState<ImageHit[] | null>(null);
  const [imgActualQuery, setImgActualQuery] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<ImageHit | null>(null);

  const runImageSearch = (q: string, raw?: boolean) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setImgQuery(trimmed);
    setImgPanelOpen(true);
    setImgResults(null);
    setImgError(null);
    setImgActualQuery(null);
    const useRaw = raw ?? imgRawMode;
    imageSearch.mutate(
      { id: sessionId, data: { query: trimmed, count: 12, raw: useRaw } },
      {
        onSuccess: (resp) => {
          setImgResults((resp.results ?? []) as ImageHit[]);
          setImgActualQuery((resp as { query?: string }).query ?? null);
        },
        onError: () => setImgError(t("models.assistant.searchImages.failed" as any)),
      },
    );
  };

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
        if (resp.needsMorePapers && resp.needsMorePapers.reason) {
          setLastNeedsMore(resp.needsMorePapers as NeedsMore);
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
    setLastNeedsMore(null);
  };

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col" data-testid="panel-assistant">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30 gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="w-4 h-4 text-primary shrink-0" />
          <h3 className="text-sm font-semibold truncate">{t("models.assistant.title" as any)}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setImgPanelOpen((v) => !v); }}
            data-testid="button-toggle-image-search"
            className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-md border border-sky-300 bg-sky-50 hover:bg-sky-100 text-sky-800 px-2.5 py-1.5"
          >
            <ImageIcon className="w-3.5 h-3.5" /> {t("models.assistant.searchImages.cta" as any)}
          </button>
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

      {lastNeedsMore && (
        <div className="border-t border-amber-200 bg-amber-50/80 px-4 py-3 space-y-2" data-testid="panel-needs-more-papers">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
            <BookPlus className="w-3.5 h-3.5" /> {t("models.assistant.needsMore.title" as any)}
          </div>
          <p className="text-xs text-amber-900 bg-white/70 rounded p-2 border border-amber-200">{lastNeedsMore.reason}</p>
          {(lastNeedsMore.missingConstructs ?? []).length > 0 && (
            <div className="text-xs text-amber-900">
              <span className="font-medium">{t("models.assistant.needsMore.missing" as any)}:</span>{" "}
              {(lastNeedsMore.missingConstructs ?? []).map((c) => (
                <span key={c} className="inline-block bg-white border border-amber-300 rounded px-1.5 py-0.5 mr-1 mb-1">{c}</span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <a
              data-testid="link-add-more-papers"
              href={`/sessions/${sessionId}/papers${lastNeedsMore.searchQuery ? `?q=${encodeURIComponent(lastNeedsMore.searchQuery)}` : ""}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-3 py-1.5"
            >
              <BookPlus className="w-3.5 h-3.5" /> {t("models.assistant.needsMore.cta" as any)}
            </a>
            <button
              type="button"
              data-testid="button-search-model-images-from-needs"
              onClick={() => runImageSearch(lastNeedsMore.searchQuery ?? (lastNeedsMore.missingConstructs ?? []).join(" "))}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500 bg-white hover:bg-amber-50 text-amber-800 text-xs font-semibold px-3 py-1.5"
            >
              <ImageIcon className="w-3.5 h-3.5" /> {t("models.assistant.searchImages.cta" as any)}
            </button>
          </div>
        </div>
      )}

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

      {imgPanelOpen && (
        <div className="border-t-2 border-sky-300 bg-sky-50/60 px-4 py-3 space-y-2" data-testid="panel-image-search">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-900">
              <ImageIcon className="w-3.5 h-3.5" /> {t("models.assistant.searchImages.title" as any)}
            </div>
            <button
              type="button"
              onClick={() => { setImgPanelOpen(false); setImgResults(null); setImgError(null); }}
              data-testid="button-close-image-search"
              className="text-sky-700 hover:text-sky-900"
              title={t("models.assistant.searchImages.close" as any)}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              data-testid="input-image-search-query"
              value={imgQuery}
              onChange={(e) => setImgQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runImageSearch(imgQuery); } }}
              placeholder={t("models.assistant.searchImages.placeholder" as any)}
              className="flex-1 text-sm rounded-md border border-sky-300 bg-white px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            />
            <button
              type="button"
              data-testid="button-run-image-search"
              onClick={() => runImageSearch(imgQuery)}
              disabled={!imgQuery.trim() || imageSearch.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
            >
              {imageSearch.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              {t("models.assistant.searchImages.searchBtn" as any)}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] text-sky-800">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="checkbox-raw-mode"
                checked={imgRawMode}
                onChange={(e) => setImgRawMode(e.target.checked)}
                className="rounded border-sky-400"
              />
              {t("models.assistant.searchImages.rawMode" as any)}
            </label>
            {imgActualQuery && (
              <span className="text-sky-700 truncate max-w-full" title={imgActualQuery}>
                {t("models.assistant.searchImages.actualQuery" as any)}: <code className="bg-white border border-sky-200 rounded px-1 py-0.5 font-mono">{imgActualQuery}</code>
              </span>
            )}
          </div>
          <p className="text-[11px] text-sky-700/90 leading-relaxed">{t("models.assistant.searchImages.tip" as any)}</p>
          {imageSearch.isPending && (
            <div className="text-xs text-sky-800 inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("models.assistant.searchImages.loading" as any)}
            </div>
          )}
          {imgError && <div className="text-xs text-red-700 bg-white rounded p-2 border border-red-200">{imgError}</div>}
          {imgResults && imgResults.length === 0 && !imageSearch.isPending && (
            <div className="text-xs text-sky-800">{t("models.assistant.searchImages.empty" as any)}</div>
          )}
          {imgResults && imgResults.length > 0 && (
            <>
              <p className="text-[11px] text-sky-700">{t("models.assistant.searchImages.hint" as any)}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {imgResults.map((r, i) => (
                  <div key={i} data-testid={`image-result-${i}`} className="bg-white border border-sky-200 rounded-md overflow-hidden flex flex-col">
                    <button
                      type="button"
                      onClick={() => setLightbox(r)}
                      className="block w-full aspect-[4/3] bg-muted overflow-hidden"
                    >
                      <img
                        src={r.thumbnailUrl}
                        alt={r.title}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover hover:scale-105 transition-transform"
                      />
                    </button>
                    <div className="p-1.5 flex flex-col gap-1 min-h-0">
                      <div className="text-[11px] leading-tight line-clamp-2 text-foreground" title={r.title}>{r.title}</div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground truncate" title={r.sourceDomain}>{r.sourceDomain}</span>
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-image-source-${i}`}
                          className="inline-flex items-center gap-0.5 text-[10px] text-sky-700 hover:text-sky-900 font-semibold whitespace-nowrap"
                        >
                          {t("models.assistant.searchImages.openSource" as any)} <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
          data-testid="lightbox-image"
        >
          <div className="max-w-5xl w-full max-h-full flex flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightbox.imageUrl ?? lightbox.thumbnailUrl}
              alt={lightbox.title}
              referrerPolicy="no-referrer"
              className="max-h-[80vh] max-w-full object-contain rounded shadow-2xl bg-white"
            />
            <div className="flex items-center gap-3 bg-white rounded-md px-3 py-2 max-w-full">
              <span className="text-xs text-foreground line-clamp-2 flex-1 min-w-0" title={lightbox.title}>{lightbox.title}</span>
              <a
                href={lightbox.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-sky-700 hover:text-sky-900 font-semibold whitespace-nowrap"
              >
                {t("models.assistant.searchImages.openSource" as any)} <ExternalLink className="w-3 h-3" />
              </a>
              <button
                type="button"
                onClick={() => setLightbox(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
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
              data-testid="button-search-model-images"
              onClick={() => runImageSearch(input.trim() || imgQuery)}
              disabled={!input.trim() && !imgQuery}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background hover:bg-sky-50 hover:border-sky-300 h-9 w-9 disabled:opacity-50"
              title={t("models.assistant.searchImages.cta" as any)}
            >
              <ImageIcon className="w-4 h-4 text-sky-700" />
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
