import React, { useEffect, useMemo, useRef, useState } from "react";
import { useChatModelAssistant, useSearchModelImages, useSearchModelPapers, useAddImageBlocklistEntry, useGetModelAssistantMessages, useClearModelAssistantMessages, getGetModelAssistantMessagesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, BookPlus, ChevronDown, ChevronUp, Download, ExternalLink, FileText, Heart, Image as ImageIcon, LayoutGrid, Loader2, MessageSquare, Paperclip, RefreshCw, RotateCcw, Search, Send, Sparkles, Trash2, X } from "lucide-react";
import { useT } from "@/lib/i18n";

type ImageHit = {
  title: string;
  thumbnailUrl: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceDomain: string;
  width?: number;
  height?: number;
  category?: "conceptual_model" | "sem_path" | "framework";
  why?: string;
};

type PaperHit = {
  externalId: string;
  title: string;
  abstract?: string | null;
  authors: string[];
  year?: number | null;
  venue?: string | null;
  citationCount?: number | null;
  openAccessUrl?: string | null;
  url: string;
  modelFigureLikelihood: "high" | "medium" | "low";
  modelFigureReason?: string;
};

type SearchMode = "images" | "papers" | "all";

type SavedImage = { kind: "image"; id: string; data: ImageHit; query: string; addedAt: number };
type SavedPaper = { kind: "paper"; id: string; data: PaperHit; query: string; addedAt: number };
type SavedItem = SavedImage | SavedPaper;
const SAVED_KEY = (sid: number) => `model-refs-saved-${sid}`;

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
  const qc = useQueryClient();
  const historyQ = useGetModelAssistantMessages(sessionId);
  const clearHistoryMut = useClearModelAssistantMessages();

  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: t("models.assistant.greeting" as any) },
  ]);
  // Hydrate from persisted history once it loads (or session changes).
  // Race-safe: if the user already started typing/sending before the GET
  // resolved, `messages` will have more than the initial greeting — skip the
  // overwrite so we never lose their in-flight turn.
  const lastHydratedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!historyQ.data) return;
    if (lastHydratedRef.current === sessionId) return;
    const rows = historyQ.data.messages ?? [];
    const userHasInteracted = messages.length > 1 || (messages[0]?.role === "user");
    if (rows.length > 0 && !userHasInteracted) {
      setMessages(rows.map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
        attachments: (r.attachments ?? undefined) as Attachment[] | undefined,
      })));
    }
    lastHydratedRef.current = sessionId;
  }, [historyQ.data, sessionId, messages]);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [lastSuggestion, setLastSuggestion] = useState<Suggestion | null>(null);
  const [lastNeedsMore, setLastNeedsMore] = useState<NeedsMore | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Image / paper search state
  const imageSearch = useSearchModelImages();
  const paperSearch = useSearchModelPapers();
  const addBlocklist = useAddImageBlocklistEntry();
  const [blockedUrls, setBlockedUrls] = useState<Set<string>>(new Set());

  const blockImage = (img: ImageHit) => {
    if (blockedUrls.has(img.sourceUrl)) return;
    setBlockedUrls((prev) => new Set(prev).add(img.sourceUrl));
    setImgResults((cur) => (cur ? cur.filter((r) => r.sourceUrl !== img.sourceUrl) : cur));
    addBlocklist.mutate({
      id: sessionId,
      data: {
        sourceUrl: img.sourceUrl,
        sourceDomain: img.sourceDomain,
        title: img.title || null,
        reason: "user-dismissed",
      },
    });
  };
  const [imgPanelOpen, setImgPanelOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("images");
  const [imgQuery, setImgQuery] = useState("");
  const [imgRawMode, setImgRawMode] = useState(false);
  const [imgResults, setImgResults] = useState<ImageHit[] | null>(null);
  const [imgProvider, setImgProvider] = useState<string | null>(null);
  const [imgActualQuery, setImgActualQuery] = useState<string | null>(null);
  const [imgExpandedQueries, setImgExpandedQueries] = useState<string[]>([]);
  const [imgError, setImgError] = useState<string | null>(null);
  const [imgPage, setImgPage] = useState(1);
  const [imgHasMore, setImgHasMore] = useState(false);
  const [lightbox, setLightbox] = useState<ImageHit | null>(null);

  const [paperResults, setPaperResults] = useState<PaperHit[] | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperExpandedQueries, setPaperExpandedQueries] = useState<string[]>([]);
  const [paperPage, setPaperPage] = useState(1);
  const [paperHasMore, setPaperHasMore] = useState(false);
  // Retry context — captures the last attempted query/page/raw for each lane
  // so the user can hit "重试" without re-typing.
  type RetryCtx = { query: string; page: number; raw: boolean; mode: SearchMode };
  const [paperLastAttempt, setPaperLastAttempt] = useState<RetryCtx | null>(null);
  const [imgLastAttempt, setImgLastAttempt] = useState<RetryCtx | null>(null);

  // Saved collection (per session, persisted in localStorage)
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  // Hydrate from localStorage on mount / sessionId change
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY(sessionId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSaved(parsed as SavedItem[]);
        else setSaved([]);
      } else setSaved([]);
    } catch { setSaved([]); }
  }, [sessionId]);
  // Persist on change
  useEffect(() => {
    try { localStorage.setItem(SAVED_KEY(sessionId), JSON.stringify(saved)); } catch { /* quota */ }
  }, [saved, sessionId]);

  const savedIds = useMemo(() => new Set(saved.map((s) => `${s.kind}:${s.id}`)), [saved]);
  const isSaved = (kind: "image" | "paper", id: string) => savedIds.has(`${kind}:${id}`);
  const toggleSavedImage = (img: ImageHit) => {
    const id = img.sourceUrl;
    setSaved((cur) => {
      if (cur.some((s) => s.kind === "image" && s.id === id)) {
        return cur.filter((s) => !(s.kind === "image" && s.id === id));
      }
      return [...cur, { kind: "image", id, data: img, query: imgQuery, addedAt: Date.now() }];
    });
  };
  const toggleSavedPaper = (p: PaperHit) => {
    const id = p.externalId;
    setSaved((cur) => {
      if (cur.some((s) => s.kind === "paper" && s.id === id)) {
        return cur.filter((s) => !(s.kind === "paper" && s.id === id));
      }
      return [...cur, { kind: "paper", id, data: p, query: imgQuery, addedAt: Date.now() }];
    });
  };
  const clearSaved = () => {
    if (saved.length === 0) return;
    if (window.confirm(t("models.assistant.saved.clearConfirm" as any))) setSaved([]);
  };
  const exportSaved = () => {
    const imgs = saved.filter((s): s is SavedImage => s.kind === "image");
    const papers = saved.filter((s): s is SavedPaper => s.kind === "paper");
    const lines: string[] = ["# 收藏的研究模型参考资料 / Saved model references", ""];
    if (imgs.length > 0) {
      lines.push("## 收藏的图片 / Saved images", "");
      for (const it of imgs) {
        lines.push(`- **${it.data.title || "(untitled)"}** — [${it.data.sourceDomain}](${it.data.sourceUrl})  `);
        lines.push(`  ![](${it.data.thumbnailUrl})  `);
        if (it.query) lines.push(`  _搜索词 / query_: ${it.query}`);
        lines.push("");
      }
    }
    if (papers.length > 0) {
      lines.push("## 收藏的论文 / Saved papers", "");
      for (const it of papers) {
        const p = it.data;
        const meta = [p.authors.slice(0, 3).join(", "), p.year, p.venue].filter(Boolean).join(" · ");
        lines.push(`- **${p.title}**`);
        if (meta) lines.push(`  ${meta}`);
        lines.push(`  Likelihood: **${p.modelFigureLikelihood}** — ${p.modelFigureReason ?? ""}`);
        lines.push(`  [打开论文 / Open paper](${p.url})${p.openAccessUrl ? ` · [PDF](${p.openAccessUrl})` : ""}`);
        lines.push("");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `saved-model-refs-session-${sessionId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Request sequencing — ignore stale onSuccess responses if a newer request was issued.
  const imgReqRef = useRef(0);
  const paperReqRef = useRef(0);

  const runImageSearch = (q: string, opts?: { raw?: boolean; page?: number; mode?: SearchMode }) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setImgQuery(trimmed);
    setImgPanelOpen(true);
    if (opts?.mode) setSearchMode(opts.mode); else setSearchMode("images");
    const page = opts?.page ?? 1;
    // Only clear visible results on a fresh (page=1) query so pagination keeps the
    // previous batch visible until the new one arrives or fails. Do NOT optimistically
    // change imgPage/imgHasMore — those should only commit on success.
    if (page === 1) { setImgResults(null); setImgPage(1); setImgHasMore(false); }
    setImgError(null);
    setImgActualQuery(null);
    setImgExpandedQueries([]);
    setImgProvider(null);
    const useRaw = opts?.raw ?? imgRawMode;
    setImgLastAttempt({ query: trimmed, page, raw: useRaw, mode: opts?.mode ?? "images" });
    const reqId = ++imgReqRef.current;
    imageSearch.mutate(
      { id: sessionId, data: { query: trimmed, count: 12, raw: useRaw, page } },
      {
        onSuccess: (resp) => {
          if (reqId !== imgReqRef.current) return; // stale
          setImgResults((resp.results ?? []) as ImageHit[]);
          setImgActualQuery((resp as { query?: string }).query ?? null);
          setImgExpandedQueries(((resp as { expandedQueries?: string[] }).expandedQueries ?? []));
          setImgProvider((resp as { provider?: string }).provider ?? null);
          setImgHasMore(Boolean((resp as { hasMore?: boolean }).hasMore));
          setImgPage(Number((resp as { page?: number }).page) || page);
        },
        onError: () => {
          if (reqId !== imgReqRef.current) return;
          setImgError(t("models.assistant.searchImages.failed" as any));
          // Preserve previous imgPage/imgHasMore so user can retry next batch.
        },
      },
    );
  };

  const runPaperSearch = (q: string, opts?: { raw?: boolean; page?: number; mode?: SearchMode }) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setImgQuery(trimmed);
    setImgPanelOpen(true);
    if (opts?.mode) setSearchMode(opts.mode); else setSearchMode("papers");
    const page = opts?.page ?? 1;
    if (page === 1) { setPaperResults(null); setPaperPage(1); setPaperHasMore(false); }
    setPaperError(null);
    setPaperExpandedQueries([]);
    const useRaw = opts?.raw ?? imgRawMode;
    setPaperLastAttempt({ query: trimmed, page, raw: useRaw, mode: opts?.mode ?? "papers" });
    const reqId = ++paperReqRef.current;
    paperSearch.mutate(
      { id: sessionId, data: { query: trimmed, count: 10, raw: useRaw, page } },
      {
        onSuccess: (resp) => {
          if (reqId !== paperReqRef.current) return;
          setPaperResults((resp.papers ?? []) as PaperHit[]);
          setPaperExpandedQueries(((resp as { expandedQueries?: string[] }).expandedQueries ?? []));
          setPaperHasMore(Boolean((resp as { hasMore?: boolean }).hasMore));
          setPaperPage(Number((resp as { page?: number }).page) || page);
        },
        onError: () => {
          if (reqId !== paperReqRef.current) return;
          setPaperError(t("models.assistant.searchPapers.failed" as any));
        },
      },
    );
  };

  // "全部" mode runs both in parallel (each updates its own state).
  const runAllSearch = (q: string, opts?: { raw?: boolean; page?: number }) => {
    runImageSearch(q, { ...opts, mode: "all" });
    runPaperSearch(q, { ...opts, mode: "all" });
  };

  const runActiveSearch = (q: string, opts?: { raw?: boolean; page?: number }) => {
    if (searchMode === "papers") runPaperSearch(q, opts);
    else if (searchMode === "all") runAllSearch(q, opts);
    else runImageSearch(q, opts);
  };

  const nextBatch = () => {
    if (searchMode === "papers") runPaperSearch(imgQuery, { page: paperPage + 1 });
    else if (searchMode === "all") runAllSearch(imgQuery, { page: Math.max(imgPage, paperPage) + 1 });
    else runImageSearch(imgQuery, { page: imgPage + 1 });
  };

  const showImagesSection = searchMode === "images" || searchMode === "all";
  const showPapersSection = searchMode === "papers" || searchMode === "all";
  const isAnyPending = imageSearch.isPending || paperSearch.isPending;
  const canShowNextBatch = searchMode === "papers"
    ? Boolean(paperResults) && paperHasMore && !isAnyPending
    : searchMode === "all"
      ? Boolean(imgResults || paperResults) && (imgHasMore || paperHasMore) && !isAnyPending
      : Boolean(imgResults) && imgHasMore && !isAnyPending;

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
        // Refresh persisted history so refresh-after-send shows the new turn.
        qc.invalidateQueries({ queryKey: getGetModelAssistantMessagesQueryKey(sessionId) });
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
    clearHistoryMut.mutate({ id: sessionId }, {
      onSettled: () => {
        qc.invalidateQueries({ queryKey: getGetModelAssistantMessagesQueryKey(sessionId) });
      },
    });
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
          {saved.length > 0 && (
            <button
              onClick={() => { setImgPanelOpen(true); setSavedOpen((v) => !v); }}
              data-testid="button-toggle-saved"
              title={t("models.assistant.saved.expand" as any)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-md border border-pink-300 bg-pink-50 hover:bg-pink-100 text-pink-800 px-2.5 py-1.5"
            >
              <Heart className="w-3.5 h-3.5 fill-pink-500 text-pink-500" /> {t("models.assistant.saved.title" as any)} ({saved.length})
            </button>
          )}
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
              {searchMode === "papers"
                ? (<><BookOpen className="w-3.5 h-3.5" /> {t("models.assistant.searchPapers.title" as any)}</>)
                : searchMode === "all"
                  ? (<><LayoutGrid className="w-3.5 h-3.5" /> {t("models.assistant.tab.all" as any)}</>)
                  : (<><ImageIcon className="w-3.5 h-3.5" /> {t("models.assistant.searchImages.title" as any)}</>)}
            </div>
            <button
              type="button"
              onClick={() => { setImgPanelOpen(false); setImgResults(null); setImgError(null); setPaperResults(null); setPaperError(null); setSavedOpen(false); }}
              data-testid="button-close-image-search"
              className="text-sky-700 hover:text-sky-900"
              title={t("models.assistant.searchImages.close" as any)}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Saved collection drawer (collapsible) */}
          {(saved.length > 0 || savedOpen) && (
            <div className="bg-white border border-pink-200 rounded-md">
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setSavedOpen((v) => !v)}
                  data-testid="button-saved-toggle-collapse"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-pink-800"
                >
                  <Heart className="w-3.5 h-3.5 fill-pink-500 text-pink-500" />
                  {t("models.assistant.saved.title" as any)} ({saved.length})
                  {savedOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {savedOpen && saved.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={exportSaved}
                      data-testid="button-saved-export"
                      className="text-[11px] text-pink-700 hover:text-pink-900 inline-flex items-center gap-1"
                    >
                      <Download className="w-3 h-3" /> {t("models.assistant.saved.export" as any)}
                    </button>
                    <button
                      type="button"
                      onClick={clearSaved}
                      data-testid="button-saved-clear"
                      className="text-[11px] text-red-600 hover:text-red-800 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" /> {t("models.assistant.saved.clear" as any)}
                    </button>
                  </div>
                )}
              </div>
              {savedOpen && (
                <div className="border-t border-pink-100 p-2 space-y-2 max-h-64 overflow-y-auto">
                  {saved.length === 0 && (
                    <p className="text-[11px] text-pink-700">{t("models.assistant.saved.empty" as any)}</p>
                  )}
                  {saved.filter((s): s is SavedImage => s.kind === "image").length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold text-pink-800 mb-1">{t("models.assistant.saved.imagesSection" as any)}</div>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                        {saved.filter((s): s is SavedImage => s.kind === "image").map((it) => (
                          <div key={`s-img-${it.id}`} className="relative bg-muted border border-pink-100 rounded overflow-hidden group">
                            <button type="button" onClick={() => setLightbox(it.data)} className="block w-full aspect-[4/3]">
                              <img src={it.data.thumbnailUrl} alt={it.data.title} loading="lazy" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleSavedImage(it.data)}
                              data-testid={`button-saved-remove-img-${it.id}`}
                              title={t("models.assistant.saved.remove" as any)}
                              className="absolute top-0.5 right-0.5 bg-white/90 rounded p-0.5 text-pink-600 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {saved.filter((s): s is SavedPaper => s.kind === "paper").length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold text-pink-800 mb-1 mt-1">{t("models.assistant.saved.papersSection" as any)}</div>
                      <ul className="space-y-1">
                        {saved.filter((s): s is SavedPaper => s.kind === "paper").map((it) => (
                          <li key={`s-p-${it.id}`} className="text-[11px] flex items-start gap-1.5">
                            <span className={
                              "shrink-0 inline-block rounded px-1 text-[9px] font-semibold mt-0.5 " +
                              (it.data.modelFigureLikelihood === "high" ? "bg-emerald-100 text-emerald-900"
                                : it.data.modelFigureLikelihood === "medium" ? "bg-amber-100 text-amber-900"
                                : "bg-slate-100 text-slate-700")
                            }>
                              {it.data.modelFigureLikelihood}
                            </span>
                            <a href={it.data.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-foreground hover:text-sky-700 leading-snug line-clamp-2">
                              {it.data.title}
                            </a>
                            <button
                              type="button"
                              onClick={() => toggleSavedPaper(it.data)}
                              data-testid={`button-saved-remove-paper-${it.id}`}
                              title={t("models.assistant.saved.remove" as any)}
                              className="shrink-0 text-pink-600 hover:text-red-600"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Mode tabs (3 options) */}
          <div className="flex bg-white border border-sky-200 rounded-md p-0.5 text-xs font-medium">
            <button
              type="button"
              data-testid="tab-search-images"
              onClick={() => setSearchMode("images")}
              className={
                "flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded transition " +
                (searchMode === "images" ? "bg-sky-600 text-white" : "text-sky-800 hover:bg-sky-50")
              }
            >
              <ImageIcon className="w-3.5 h-3.5" /> {t("models.assistant.tab.images" as any)}
            </button>
            <button
              type="button"
              data-testid="tab-search-papers"
              onClick={() => setSearchMode("papers")}
              className={
                "flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded transition " +
                (searchMode === "papers" ? "bg-sky-600 text-white" : "text-sky-800 hover:bg-sky-50")
              }
            >
              <BookOpen className="w-3.5 h-3.5" /> {t("models.assistant.tab.papers" as any)}
            </button>
            <button
              type="button"
              data-testid="tab-search-all"
              onClick={() => setSearchMode("all")}
              title={t("models.assistant.tab.allHint" as any)}
              className={
                "flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded transition " +
                (searchMode === "all" ? "bg-sky-600 text-white" : "text-sky-800 hover:bg-sky-50")
              }
            >
              <LayoutGrid className="w-3.5 h-3.5" /> {t("models.assistant.tab.all" as any)}
            </button>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              data-testid="input-image-search-query"
              value={imgQuery}
              onChange={(e) => setImgQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runActiveSearch(imgQuery); } }}
              placeholder={t((searchMode === "papers" ? "models.assistant.searchPapers.placeholder" : "models.assistant.searchImages.placeholder") as any)}
              className="flex-1 text-sm rounded-md border border-sky-300 bg-white px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            />
            <button
              type="button"
              data-testid="button-run-image-search"
              onClick={() => runActiveSearch(imgQuery)}
              disabled={!imgQuery.trim() || imageSearch.isPending || paperSearch.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
            >
              {(imageSearch.isPending || paperSearch.isPending) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
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
            {searchMode === "images" && imgProvider && (
              <span className="inline-flex items-center gap-1 text-[10px] bg-white border border-sky-200 rounded px-1.5 py-0.5">
                {t("models.assistant.searchImages.providerLabel" as any)}:{" "}
                <strong className="text-sky-900">
                  {imgProvider === "serpapi"
                    ? t("models.assistant.searchImages.providerSerp" as any)
                    : t("models.assistant.searchImages.providerBrave" as any)}
                </strong>
              </span>
            )}
          </div>

          {/* Expanded queries (shared between modes; uses correct list) */}
          {(() => {
            const list = searchMode === "papers" ? paperExpandedQueries : imgExpandedQueries;
            if (list.length === 0 || imgRawMode) return null;
            return (
              <div className="bg-white border border-sky-200 rounded p-2 space-y-1">
                <div className="text-[11px] font-medium text-sky-800">{t("models.assistant.searchImages.expandedTitle" as any)}</div>
                <ul className="text-[11px] text-sky-900 space-y-0.5 list-disc list-inside">
                  {list.map((q, i) => (
                    <li key={i}><code className="font-mono">{q}</code></li>
                  ))}
                </ul>
              </div>
            );
          })()}
          {searchMode === "images" && imgRawMode && imgActualQuery && (
            <span className="text-[11px] text-sky-700 truncate max-w-full block" title={imgActualQuery}>
              {t("models.assistant.searchImages.actualQuery" as any)}: <code className="bg-white border border-sky-200 rounded px-1 py-0.5 font-mono">{imgActualQuery}</code>
            </span>
          )}
          <p className="text-[11px] text-sky-700/90 leading-relaxed">
            {t((searchMode === "papers" ? "models.assistant.searchPapers.tip" : "models.assistant.searchImages.tip") as any)}
          </p>

          {/* IMAGES section (shown in images + all modes) */}
          {showImagesSection && (
            <>
              {searchMode === "all" && (
                <div className="text-[11px] font-semibold text-sky-900 inline-flex items-center gap-1 mt-1">
                  <ImageIcon className="w-3 h-3" /> {t("models.assistant.searchImages.title" as any)}
                </div>
              )}
              {imageSearch.isPending && (
                <div className="text-xs text-sky-800 inline-flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("models.assistant.searchImages.loading" as any)}
                </div>
              )}
              {imgError && (
                <div className="text-xs text-red-700 bg-white rounded p-2 border border-red-200 flex items-center justify-between gap-2">
                  <span>{imgError}</span>
                  {imgLastAttempt && !imageSearch.isPending && (
                    <button
                      type="button"
                      onClick={() => runImageSearch(imgLastAttempt.query, { page: imgLastAttempt.page, raw: imgLastAttempt.raw, mode: imgLastAttempt.mode })}
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-300 text-red-700 hover:bg-red-50 font-medium"
                    >
                      <RotateCcw className="w-3 h-3" /> {t("models.assistant.searchImages.retry" as any)}
                    </button>
                  )}
                </div>
              )}
              {imgResults && imgResults.length === 0 && !imageSearch.isPending && (
                <div className="text-xs text-sky-800">{t("models.assistant.searchImages.empty" as any)}</div>
              )}
              {imgResults && imgResults.length > 0 && (
                <>
                  <p className="text-[11px] text-sky-700">
                    {t("models.assistant.searchImages.hint" as any)}
                    {imgPage > 1 && <span className="ml-1 text-sky-500">· {t("models.assistant.page" as any).replace("{n}", String(imgPage))}</span>}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {imgResults.map((r, i) => {
                      const liked = isSaved("image", r.sourceUrl);
                      return (
                      <div key={`${r.sourceUrl}-${i}`} data-testid={`image-result-${i}`} className="bg-white border border-sky-200 rounded-md overflow-hidden flex flex-col relative group">
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
                        <div className="absolute top-1 right-1 flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleSavedImage(r); }}
                            data-testid={`button-save-image-${i}`}
                            aria-pressed={liked}
                            aria-label={liked ? t("models.assistant.saved.toggle" as any) : t("models.assistant.save" as any)}
                            title={liked ? t("models.assistant.saved.toggle" as any) : t("models.assistant.save" as any)}
                            className={
                              "rounded-full p-1 backdrop-blur transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:opacity-100 " +
                              (liked
                                ? "bg-pink-500/95 text-white opacity-100"
                                : "bg-white/85 text-pink-500 opacity-0 group-hover:opacity-100 hover:bg-white")
                            }
                          >
                            <Heart className={"w-3.5 h-3.5 " + (liked ? "fill-white" : "")} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); blockImage(r); }}
                            data-testid={`button-block-image-${i}`}
                            aria-label={t("models.assistant.searchImages.block" as any)}
                            title={t("models.assistant.searchImages.blockTip" as any)}
                            className="rounded-full p-1 backdrop-blur transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 bg-white/85 text-red-600 opacity-0 group-hover:opacity-100 hover:bg-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {r.category && (
                          <div
                            data-testid={`badge-image-category-${i}`}
                            title={t(`models.assistant.searchImages.category.${r.category}.tip` as any)}
                            className={
                              "absolute top-1 left-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur " +
                              (r.category === "conceptual_model"
                                ? "bg-emerald-600/95 text-white"
                                : r.category === "sem_path"
                                  ? "bg-violet-600/95 text-white"
                                  : "bg-sky-600/95 text-white")
                            }
                          >
                            ✓ {t(`models.assistant.searchImages.category.${r.category}.label` as any)}
                          </div>
                        )}
                        <div className="p-1.5 flex flex-col gap-1 min-h-0">
                          <div className="text-[11px] leading-tight line-clamp-2 text-foreground" title={r.title}>{r.title}</div>
                          {r.why && (
                            <div
                              data-testid={`text-image-why-${i}`}
                              className="text-[10px] leading-snug text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-1 italic line-clamp-2"
                              title={r.why}
                            >
                              {r.why}
                            </div>
                          )}
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
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {/* PAPERS section (shown in papers + all modes) */}
          {showPapersSection && (
            <>
              {searchMode === "all" && (
                <div className="text-[11px] font-semibold text-sky-900 inline-flex items-center gap-1 mt-2">
                  <BookOpen className="w-3 h-3" /> {t("models.assistant.searchPapers.title" as any)}
                </div>
              )}
              {paperSearch.isPending && (
                <div className="text-xs text-sky-800 inline-flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("models.assistant.searchPapers.loading" as any)}
                </div>
              )}
              {paperError && (
                <div className="text-xs text-red-700 bg-white rounded p-2 border border-red-200 flex items-center justify-between gap-2">
                  <span>{paperError}</span>
                  {paperLastAttempt && !paperSearch.isPending && (
                    <button
                      type="button"
                      onClick={() => runPaperSearch(paperLastAttempt.query, { page: paperLastAttempt.page, raw: paperLastAttempt.raw, mode: paperLastAttempt.mode })}
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-300 text-red-700 hover:bg-red-50 font-medium"
                    >
                      <RotateCcw className="w-3 h-3" /> {t("models.assistant.searchPapers.retry" as any)}
                    </button>
                  )}
                </div>
              )}
              {paperResults && paperResults.length === 0 && !paperSearch.isPending && (
                <div className="text-xs text-sky-800">{t("models.assistant.searchPapers.empty" as any)}</div>
              )}
              {paperResults && paperResults.length > 0 && (
                <div className="space-y-2 max-h-[480px] overflow-y-auto">
                  {paperPage > 1 && (
                    <p className="text-[11px] text-sky-500">{t("models.assistant.page" as any).replace("{n}", String(paperPage))}</p>
                  )}
                  {paperResults.map((p, i) => {
                    const lkClass =
                      p.modelFigureLikelihood === "high"
                        ? "bg-emerald-100 text-emerald-900 border-emerald-300"
                        : p.modelFigureLikelihood === "medium"
                          ? "bg-amber-100 text-amber-900 border-amber-300"
                          : "bg-slate-100 text-slate-700 border-slate-300";
                    const lkLabel = t((`models.assistant.searchPapers.likelihood.${p.modelFigureLikelihood}`) as any);
                    const liked = isSaved("paper", p.externalId);
                    return (
                      <div
                        key={p.externalId}
                        data-testid={`paper-result-${i}`}
                        className="bg-white border border-sky-200 rounded-md p-2.5 flex flex-col gap-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-[13px] font-semibold leading-snug text-foreground flex-1" title={p.title}>
                            {p.title}
                          </h4>
                          <button
                            type="button"
                            onClick={() => toggleSavedPaper(p)}
                            data-testid={`button-save-paper-${i}`}
                            aria-pressed={liked}
                            aria-label={liked ? t("models.assistant.saved.toggle" as any) : t("models.assistant.save" as any)}
                            title={liked ? t("models.assistant.saved.toggle" as any) : t("models.assistant.save" as any)}
                            className={
                              "shrink-0 rounded p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 " +
                              (liked ? "bg-pink-500 text-white" : "text-pink-500 hover:bg-pink-50")
                            }
                          >
                            <Heart className={"w-3.5 h-3.5 " + (liked ? "fill-white" : "")} />
                          </button>
                          <span
                            className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold rounded border px-1.5 py-0.5 ${lkClass}`}
                            title={p.modelFigureReason || ""}
                          >
                            <FileText className="w-2.5 h-2.5" /> {lkLabel}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                          {p.authors.length > 0 && <span className="truncate max-w-[55%]">{p.authors.slice(0, 3).join(", ")}{p.authors.length > 3 ? " et al." : ""}</span>}
                          {p.year && <span>· {p.year}</span>}
                          {p.venue && <span className="truncate max-w-[40%]">· {p.venue}</span>}
                          {typeof p.citationCount === "number" && p.citationCount > 0 && (
                            <span>· {t("models.assistant.searchPapers.cited" as any)} {p.citationCount}</span>
                          )}
                        </div>
                        {p.modelFigureReason && (
                          <p className="text-[11px] text-sky-900 bg-sky-50 border border-sky-100 rounded px-1.5 py-1 leading-snug">
                            <span className="font-medium">{t("models.assistant.searchPapers.likelihood" as any)}:</span> {p.modelFigureReason}
                          </p>
                        )}
                        {p.abstract && (
                          <p className="text-[11px] text-foreground/80 line-clamp-3 leading-relaxed">{p.abstract}</p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-paper-${i}`}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 hover:text-sky-900"
                          >
                            <ExternalLink className="w-3 h-3" /> {t("models.assistant.searchPapers.openPaper" as any)}
                          </a>
                          {p.openAccessUrl && (
                            <a
                              href={p.openAccessUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`link-paper-pdf-${i}`}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                            >
                              <Download className="w-3 h-3" /> {t("models.assistant.searchPapers.openPdf" as any)}
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {canShowNextBatch && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={nextBatch}
                data-testid="button-next-batch"
                disabled={isAnyPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-white hover:bg-sky-50 text-sky-800 text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
              >
                {isAnyPending
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("models.assistant.nextBatch.loading" as any)}</>
                  : <><RefreshCw className="w-3.5 h-3.5" /> {t("models.assistant.nextBatch" as any)}</>}
              </button>
            </div>
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
