import React, { createContext, useContext, useEffect, useState } from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "rmb.lang";

const dict = {
  zh: {
    "brand.name": "学术模型构建器",
    "brand.tagline": "从文献到原创模型，AI 帮你一站式完成",

    "nav.sessions": "我的项目",
    "nav.settings": "设置",
    "nav.lang.zh": "中文",
    "nav.lang.en": "English",

    "common.back": "返回",
    "common.loading": "加载中…",
    "common.open": "打开",
    "common.next": "下一步",
    "common.add": "添加",
    "common.added": "已添加",
    "common.remove": "移除",
    "common.search": "搜索",
    "common.cancel": "取消",
    "common.save": "保存",
    "common.error": "出错了",
    "common.tryAgain": "请稍后重试",
    "common.papers": "论文",
    "common.variables": "变量",
    "common.models": "模型",
    "common.status": "状态",
    "common.citations": "引用",
    "common.evidence": "证据",
    "common.rationale": "理论依据",
    "common.viewDetails": "查看详情",
    "common.select": "选用",
    "common.selected": "已选用",

    "home.title": "我的研究项目",
    "home.subtitle": "管理你的文献综述与模型构建项目，每一步都有 AI 协助。",
    "home.newSession": "新建项目",
    "home.empty.title": "还没有研究项目",
    "home.empty.body": "新建一个项目，开始搜索论文、提取研究变量、生成原创理论模型。",
    "home.empty.cta": "创建第一个项目",
    "home.failedLoad": "项目加载失败，请刷新页面重试。",

    "gs.title": "三分钟上手指南",
    "gs.subtitle": "不知道从哪开始？跟着这 4 步走一遍：",
    "gs.step1.title": "1. 新建项目",
    "gs.step1.body": "用一句话描述你想研究的题目，例如『远程办公对员工创新行为的影响』。",
    "gs.step2.title": "2. 搜索并添加论文",
    "gs.step2.body": "输入关键词，从 OpenAlex 学术库挑出 5–10 篇高被引相关论文加入项目。",
    "gs.step3.title": "3. 一键提取研究变量",
    "gs.step3.body": "AI 会自动从每篇论文中识别出自变量、中介、调节、因变量及定义。",
    "gs.step4.title": "4. 生成原创研究模型",
    "gs.step4.body": "AI 会把所有变量重新组合，给你 3 个新颖的研究模型方案，并附原文引用。",
    "gs.cta": "立即开始",

    "new.back": "返回项目列表",
    "new.title": "新建研究项目",
    "new.subtitle": "用一两句话告诉 AI 你要研究什么，越具体越好，我们会用它来帮你找文献、搭模型。",
    "new.field.name": "项目名称",
    "new.field.name.ph": "例如：医护人员对 AI 工具的接受度…",
    "new.field.name.required": "请填写项目名称",
    "new.field.topic": "研究题目",
    "new.field.topic.hint": "请尽量具体：研究的对象是谁？想看哪些变量之间的关系？参考下面的示例。",
    "new.field.topic.ph": "我想研究医护人员采用生成式 AI 工具的影响因素，重点关注信任、感知风险、组织支持这几个变量…",
    "new.field.topic.required": "题目至少需要 10 个字，写得越具体 AI 推荐的论文越准。",
    "new.examples.title": "不知道怎么写？参考这些示例：",
    "new.examples.1": "远程办公强度对员工创新行为的影响：心理安全感的中介作用",
    "new.examples.2": "短视频沉浸感如何影响青少年的购买意愿：情绪卷入的调节作用",
    "new.examples.3": "高校教师采用生成式 AI 教学工具的影响因素研究",
    "new.submit": "创建项目并开始",
    "new.submitting": "正在初始化工作台…",
    "new.toast.created": "项目已创建",
    "new.toast.createdDesc": "你的研究工作台已就绪。",
    "new.toast.failed": "创建失败",

    "ws.crumb.home": "我的项目",
    "ws.notFound": "找不到该项目",
    "ws.toDashboard": "返回工作台",
    "ws.tab.papers": "1. 添加论文",
    "ws.tab.variables": "2. 提取变量",
    "ws.tab.models": "3. 生成模型",

    "step.label": "进度",
    "step.papers.title": "添加论文",
    "step.papers.desc": "先收集 5–10 篇相关文献",
    "step.variables.title": "提取变量",
    "step.variables.desc": "AI 自动识别研究变量",
    "step.models.title": "生成模型",
    "step.models.desc": "AI 组合出新研究模型",
    "step.select.title": "选定方案",
    "step.select.desc": "挑出你最满意的模型",
    "step.status.done": "已完成",
    "step.status.current": "进行中",
    "step.status.todo": "待开始",

    "papers.search.title": "第 1 步：搜索学术论文",
    "papers.search.hint": "输入英文关键词更准（OpenAlex 主要收录英文文献）。例：technology acceptance healthcare。结果按相关度排序。",

    "papers.lookup.title": "或：粘贴 DOI / 论文链接直接添加",
    "papers.lookup.hint": "在谷歌学术、知网、Web of Science 等数据库找到论文后，把它的 DOI（如 10.1234/abcd）或 doi.org / arxiv 链接粘贴进来，系统会自动抓取信息加入项目。",
    "papers.lookup.ph": "例：10.1016/j.chb.2023.107890 或 https://doi.org/10.xxxx/yyyy",
    "papers.lookup.button": "查找并添加",
    "papers.lookup.uniNote": "为什么不能直连知网/WoS/Scopus？这些数据库通过校园网 IP 授权，云端服务器无法直接访问。最稳妥的办法：在校内打开数据库找到论文，把 DOI 复制过来粘贴在这里。",
    "papers.lookup.toast.added": "论文已通过 DOI 添加",
    "papers.lookup.toast.notFound": "找不到这篇论文",
    "papers.lookup.toast.failed": "查找失败，请检查 DOI 或链接是否正确",
    "papers.search.ph": "输入研究关键词，例如：technology acceptance model healthcare…",
    "papers.search.button": "搜索",
    "papers.search.empty": "还没搜索。输入关键词后点搜索。",
    "papers.results.count": "找到 {count} 篇论文（按相关度排序）",
    "papers.results.from": "数据来源：OpenAlex 开放学术库",
    "papers.session.title": "已加入本项目的论文",
    "papers.session.empty.title": "还没添加任何论文",
    "papers.session.empty.body": "在上方搜索后，点击 ➕ 把感兴趣的论文加进来。建议先加 5–10 篇。",
    "papers.tip.next.title": "已经加好论文了？",
    "papers.tip.next.body": "点击每篇论文的『提取变量』按钮，AI 会自动读取摘要并识别研究变量。全部提取完后再去『生成模型』。",
    "papers.extract.btn": "提取变量",
    "papers.extract.done": "已提取",
    "papers.toast.added": "论文已添加",
    "papers.toast.removed": "已移除",
    "papers.toast.searchFailed": "搜索失败",
    "papers.toast.searchFailedDesc": "无法连接学术数据库，请稍后重试。",
    "papers.toast.addFailed": "添加失败",
    "papers.toast.extracted": "变量提取完成",
    "papers.toast.extractedDesc": "在《{title}》中识别出 {count} 个变量",
    "papers.toast.extractFailed": "提取失败",
    "papers.toast.extractFailedDesc": "AI 无法从这篇论文中提取变量，可能是摘要过短。",

    "vars.empty.title": "还没有提取到任何变量",
    "vars.empty.body": "请先到『添加论文』那一步，对每篇论文点击『提取变量』。",
    "vars.empty.cta": "去提取变量",
    "vars.graph.title": "变量关系图",
    "vars.tip.next.title": "变量已经齐了？",
    "vars.tip.next.body": "进入『生成模型』，AI 会把这些变量重新组合成 3 个新颖的研究模型方案。",
    "vars.goModels": "去生成模型",
    "vars.type.independent": "自变量",
    "vars.type.mediator": "中介变量",
    "vars.type.moderator": "调节变量",
    "vars.type.dependent": "因变量",
    "vars.type.suffix": "（{n} 个）",

    "models.intro": "AI 会综合本项目所有变量，生成 3 个原创研究模型方案，每条关系都附原文引用。",
    "models.generate": "生成模型方案",
    "models.generating": "AI 正在思考…（约 20 秒）",
    "models.empty.title": "还没生成任何模型",
    "models.empty.body": "请先在『添加论文』里把至少几篇论文的变量提取出来，再回来点击『生成模型』。",
    "models.evidence.title": "证据来源",
    "models.evidence.more": "还有 {n} 条证据，查看详情",
    "models.toast.generated": "模型生成成功",
    "models.toast.generatedDesc": "AI 为你生成了 {count} 个研究模型方案。",
    "models.toast.failed": "生成失败",
    "models.toast.failedDesc": "请确认已经提取过变量。",
    "models.toast.selected": "已选用此模型",
    "models.toast.selectedDesc": "「{name}」已设为当前研究模型。",

    "md.back": "返回",
    "md.select": "选用此模型",
    "md.selected": "已选用",
    "md.rationale": "理论依据",
    "md.variables": "模型变量",
    "md.relations": "变量关系与原文证据",
    "md.notFound": "找不到该模型",
    "md.backToList": "返回模型列表",
  },
  en: {
    "brand.name": "Research Model Builder",
    "brand.tagline": "From literature to a novel model, end-to-end with AI",

    "nav.sessions": "Sessions",
    "nav.settings": "Settings",
    "nav.lang.zh": "中文",
    "nav.lang.en": "English",

    "common.back": "Back",
    "common.loading": "Loading…",
    "common.open": "Open",
    "common.next": "Next",
    "common.add": "Add",
    "common.added": "Added",
    "common.remove": "Remove",
    "common.search": "Search",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.error": "Error",
    "common.tryAgain": "Please try again later",
    "common.papers": "Papers",
    "common.variables": "Variables",
    "common.models": "Models",
    "common.status": "Status",
    "common.citations": "citations",
    "common.evidence": "Evidence",
    "common.rationale": "Rationale",
    "common.viewDetails": "View details",
    "common.select": "Select",
    "common.selected": "Selected",

    "home.title": "Research Sessions",
    "home.subtitle": "Manage your literature reviews and model-building sessions with AI assistance at every step.",
    "home.newSession": "New Session",
    "home.empty.title": "No sessions yet",
    "home.empty.body": "Start a new session to discover papers, extract variables, and generate novel theoretical models.",
    "home.empty.cta": "Create First Session",
    "home.failedLoad": "Failed to load sessions. Please refresh.",

    "gs.title": "Get started in 3 minutes",
    "gs.subtitle": "Not sure where to begin? Just follow these 4 steps:",
    "gs.step1.title": "1. Create a session",
    "gs.step1.body": "Describe your research topic in one sentence (e.g., \"How remote work affects employee innovation\").",
    "gs.step2.title": "2. Search & add papers",
    "gs.step2.body": "Use keywords to find 5–10 highly cited papers from OpenAlex and add them to your session.",
    "gs.step3.title": "3. Extract variables with AI",
    "gs.step3.body": "AI reads each paper and identifies independent, mediator, moderator, and dependent variables.",
    "gs.step4.title": "4. Generate novel models",
    "gs.step4.body": "AI recombines all variables into 3 novel research model proposals, each backed by paper citations.",
    "gs.cta": "Start now",

    "new.back": "Back to sessions",
    "new.title": "New Research Session",
    "new.subtitle": "Tell AI what you want to study — the more specific, the better. We'll use this to help you find literature and build your model.",
    "new.field.name": "Session name",
    "new.field.name.ph": "e.g., AI tool acceptance among healthcare staff…",
    "new.field.name.required": "Please enter a session name",
    "new.field.topic": "Research topic",
    "new.field.topic.hint": "Be specific: who is the subject, and which relationships do you want to explore? See examples below.",
    "new.field.topic.ph": "I'm researching factors influencing healthcare professionals' adoption of generative AI tools, focusing on trust, perceived risk, and institutional support…",
    "new.field.topic.required": "At least 10 characters. The more specific, the better the AI's paper recommendations.",
    "new.examples.title": "Not sure how to phrase it? Try these examples:",
    "new.examples.1": "How remote work intensity affects employee innovation behavior: the mediating role of psychological safety",
    "new.examples.2": "How short-video immersion shapes adolescent purchase intention: the moderating role of emotional involvement",
    "new.examples.3": "Factors influencing university teachers' adoption of generative AI teaching tools",
    "new.submit": "Create session & start",
    "new.submitting": "Initializing workspace…",
    "new.toast.created": "Session created",
    "new.toast.createdDesc": "Your research workspace is ready.",
    "new.toast.failed": "Failed to create",

    "ws.crumb.home": "Sessions",
    "ws.notFound": "Session not found",
    "ws.toDashboard": "Back to dashboard",
    "ws.tab.papers": "1. Add Papers",
    "ws.tab.variables": "2. Extract Variables",
    "ws.tab.models": "3. Generate Models",

    "step.label": "Progress",
    "step.papers.title": "Add Papers",
    "step.papers.desc": "Collect 5–10 relevant papers",
    "step.variables.title": "Extract Variables",
    "step.variables.desc": "AI identifies research variables",
    "step.models.title": "Generate Models",
    "step.models.desc": "AI composes novel models",
    "step.select.title": "Pick One",
    "step.select.desc": "Choose your favorite model",
    "step.status.done": "Done",
    "step.status.current": "Current",
    "step.status.todo": "To do",

    "papers.search.title": "Step 1: Search academic papers",
    "papers.search.hint": "English keywords work best (OpenAlex is mostly English). e.g., technology acceptance healthcare. Results are sorted by relevance.",

    "papers.lookup.title": "Or: paste a DOI / paper URL to add directly",
    "papers.lookup.hint": "Found a paper on Google Scholar, CNKI, Web of Science, or your library? Paste its DOI (e.g. 10.1234/abcd) or doi.org / arxiv URL and we'll fetch the metadata.",
    "papers.lookup.ph": "e.g. 10.1016/j.chb.2023.107890 or https://doi.org/10.xxxx/yyyy",
    "papers.lookup.button": "Look up & add",
    "papers.lookup.uniNote": "Why can't we connect to CNKI/WoS/Scopus directly? Those databases use campus-IP authentication and don't allow programmatic access from cloud servers. The reliable workaround: find the paper on campus, copy the DOI, and paste it here.",
    "papers.lookup.toast.added": "Paper added by DOI",
    "papers.lookup.toast.notFound": "Paper not found",
    "papers.lookup.toast.failed": "Lookup failed — please check the DOI or URL",
    "papers.search.ph": "Type research keywords, e.g., technology acceptance model healthcare…",
    "papers.search.button": "Search",
    "papers.search.empty": "No search yet. Type keywords and click Search.",
    "papers.results.count": "{count} papers found (sorted by relevance)",
    "papers.results.from": "Source: OpenAlex open academic database",
    "papers.session.title": "Papers in this session",
    "papers.session.empty.title": "No papers added yet",
    "papers.session.empty.body": "Search above and click ➕ to add papers. We recommend 5–10 to start.",
    "papers.tip.next.title": "Done adding papers?",
    "papers.tip.next.body": "Click \"Extract Variables\" on each paper. AI will read the abstract and identify the variables. Once you've extracted from a few, head to \"Generate Models\".",
    "papers.extract.btn": "Extract Variables",
    "papers.extract.done": "Extracted",
    "papers.toast.added": "Paper added",
    "papers.toast.removed": "Paper removed",
    "papers.toast.searchFailed": "Search failed",
    "papers.toast.searchFailedDesc": "Could not reach the academic database. Please try again.",
    "papers.toast.addFailed": "Failed to add paper",
    "papers.toast.extracted": "Variables extracted",
    "papers.toast.extractedDesc": "Found {count} variables in \"{title}\"",
    "papers.toast.extractFailed": "Extraction failed",
    "papers.toast.extractFailedDesc": "AI couldn't extract variables — abstract may be too short.",

    "vars.empty.title": "No variables extracted yet",
    "vars.empty.body": "Go back to \"Add Papers\" and click \"Extract Variables\" on each one.",
    "vars.empty.cta": "Go extract variables",
    "vars.graph.title": "Variable relationship graph",
    "vars.tip.next.title": "Got enough variables?",
    "vars.tip.next.body": "Head to \"Generate Models\" — AI will recombine these into 3 novel research model proposals.",
    "vars.goModels": "Go generate models",
    "vars.type.independent": "Independent",
    "vars.type.mediator": "Mediator",
    "vars.type.moderator": "Moderator",
    "vars.type.dependent": "Dependent",
    "vars.type.suffix": "({n})",

    "models.intro": "AI synthesizes all variables in this session into 3 novel research model proposals, each edge backed by paper citations.",
    "models.generate": "Generate Models",
    "models.generating": "AI is thinking… (~20s)",
    "models.empty.title": "No models generated yet",
    "models.empty.body": "Extract variables from a few papers first, then come back and click \"Generate Models\".",
    "models.evidence.title": "Evidence sources",
    "models.evidence.more": "+{n} more evidence sources",
    "models.toast.generated": "Models generated",
    "models.toast.generatedDesc": "AI generated {count} model proposals for you.",
    "models.toast.failed": "Generation failed",
    "models.toast.failedDesc": "Make sure you've extracted variables first.",
    "models.toast.selected": "Model selected",
    "models.toast.selectedDesc": "\"{name}\" is now your selected research model.",

    "md.back": "Back",
    "md.select": "Select this model",
    "md.selected": "Selected",
    "md.rationale": "Theoretical Rationale",
    "md.variables": "Model Variables",
    "md.relations": "Variable relationships & evidence",
    "md.notFound": "Model not found",
    "md.backToList": "Back to models",
  },
} as const;

type Key = keyof typeof dict.zh;

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: Key, vars?: Record<string, string | number>) => string };

const LangCtx = createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") return "zh";
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    return saved === "en" || saved === "zh" ? saved : "zh";
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    }
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, l);
  };

  const t = (key: Key, vars?: Record<string, string | number>) => {
    const table = dict[lang] as Record<string, string>;
    let s = table[key] ?? (dict.en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return s;
  };

  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export function useT() {
  const ctx = useContext(LangCtx);
  if (!ctx) throw new Error("useT must be used within LanguageProvider");
  return ctx;
}
