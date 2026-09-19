// src/ui/App.tsx
// TavernLoom · 织忆酒馆 —— 现代计算极简主义 AI 角色扮演前端（Precision Canvas 纯白设计系统规范实装）
// 全功能增强版：
//   - 全局左侧主导航支持一键收起/展开（w-64 <-> w-16，支持快捷键 Ctrl+B / Cmd+B 与流畅 CSS 过渡）
//   - 会话内左右面板支持独立折叠/展开（可分别收起角色档案栏与结构化状态栏，获得超大沉浸叙事主画布）
//   - 完备的键盘快捷键（Ctrl+B 切换主侧栏，Enter 发送，Shift+Enter 换行）
//   - 视图分发：活跃会话 (Active Session)、角色库 (Characters)、世界书 (Lorebook)、引擎设置 (Engine & API)

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChatFloor, SessionState, CardListItem, SessionTreeProjection } from "./types.js";
import { sanitizeHtml } from "./sanitize.js";
import { AIRPEventSourceClient } from "./sse-client.js";
import { RegexPipeline, type StRegexScript } from "../core/pipeline/regex-pipeline.js";

const TOKEN = new URLSearchParams(window.location.search).get("token") ?? "";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (TOKEN) headers.set("X-AIRP-Token", TOKEN);
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${path} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function floorsFromTree(proj: SessionTreeProjection): ChatFloor[] {
  return Object.values(proj.tree.floors)
    .sort((a, b) => a.floorIndex - b.floorIndex)
    .map((f) => ({
      id: f.id,
      floorIndex: f.floorIndex,
      role: f.role,
      content: f.content,
      swipes: f.swipes && f.swipes.length > 0 ? f.swipes : [f.content],
      currentSwipeIndex: f.currentSwipeIndex ?? 0,
      createdAt: f.createdAt ?? Date.now(),
    }));
}

export const App: React.FC = () => {
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [connected, setConnected] = useState(TOKEN !== "");
  const [connError, setConnError] = useState<string | null>(null);

  const [session, setSession] = useState<SessionState>({
    cardId: "",
    sessionId: "",
    cardName: "",
    cardSubtitle: "",
    sessionTitle: "请选择角色卡",
    sessionBranch: "main",
    floors: [],
    currentState: {},
    rollingSummary: null,
    summaryCoverage: "无摘要",
    cacheHitRate: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    estimatedCost: "—",
    butlerStatus: "idle",
    undoCheckpointAvailable: false,
  });

  const [inputText, setInputText] = useState("");
  const [editingFloorId, setEditingFloorId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [regexScripts, setRegexScripts] = useState<StRegexScript[]>([]);
  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"session" | "characters" | "lorebook" | "engine">("session");

  // 侧边栏折叠状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

  const sseRef = useRef<AIRPEventSourceClient | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 注册全局快捷键 Ctrl+B / Cmd+B 切换主侧边栏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: session.floors.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 5,
  });

  // 刷新会话树
  const refreshSession = useCallback(async (cardId: string, sessionId: string, cardName: string) => {
    try {
      const proj = await api<SessionTreeProjection>(
        `/api/sessions/${sessionId}/tree?cardId=${encodeURIComponent(cardId)}`
      );
      const floors = floorsFromTree(proj);
      setSession((prev) => ({
        ...prev,
        cardId,
        sessionId,
        cardName,
        floors,
        currentState: proj.state ?? {},
        rollingSummary: proj.summary,
        undoCheckpointAvailable: proj.tree.undoCheckpointFloorId !== null,
        sessionTitle: `${cardName} · 会话 ${sessionId.slice(0, 12)}`,
        summaryCoverage: proj.summary ? `${proj.summary.length} 字摘要` : "无摘要",
      }));
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  }, []);

  // 加载卡片列表
  const loadCards = useCallback(() => {
    if (!TOKEN) {
      setConnError("缺少 ?token= 启动令牌——请从控制台输出的真实 URL 进入。");
      return;
    }
    api<{ cards: CardListItem[] }>("/api/cards")
      .then((res) => {
        setCards(res.cards);
        setConnected(true);
      })
      .catch((err) => setConnError(String(err.message ?? err)));
  }, []);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  // 打开会话
  const openSession = useCallback(
    async (card: CardListItem) => {
      try {
        const storageKey = `tavernloom:session:${card.cardId}`;
        let sessionId: string | null = null;
        try {
          sessionId = window.localStorage.getItem(storageKey);
        } catch {}

        if (!sessionId) {
          const res = await api<{ sessions: string[] }>(
            `/api/sessions?cardId=${encodeURIComponent(card.cardId)}`
          );
          sessionId = res.sessions[res.sessions.length - 1] ?? null;
        }

        if (!sessionId) {
          const created = await api<{ sessionId: string }>("/api/sessions", {
            method: "POST",
            body: JSON.stringify({ cardId: card.cardId }),
          });
          sessionId = created.sessionId;
        }

        try {
          window.localStorage.setItem(storageKey, sessionId);
        } catch {}

        // 读取卡内 ST 正则脚本用于展示侧渲染
        api<{ data?: { extensions?: { regex_scripts?: StRegexScript[] } } }>(
          `/api/cards/${encodeURIComponent(card.cardId)}/st/original`
        )
          .then((orig) => {
            const scripts = orig?.data?.extensions?.regex_scripts;
            setRegexScripts(Array.isArray(scripts) ? scripts : []);
          })
          .catch(() => setRegexScripts([]));

        await refreshSession(card.cardId, sessionId, card.name);
        setActiveTab("session");
      } catch (err) {
        setConnError(String((err as Error).message ?? err));
      }
    },
    [refreshSession]
  );

  // SSE 订阅
  const subscribeRun = useCallback(
    (runId: string, cardId: string, sessionId: string, cardName: string) => {
      sseRef.current?.close();
      const client = new AIRPEventSourceClient({
        url: `/api/runs/${runId}/events`,
        token: TOKEN,
        onEvent: (event) => {
          if (
            event.type === "run_delta" &&
            event.payload &&
            typeof event.payload === "object" &&
            "text" in event.payload
          ) {
            setStreamText((prev) => prev + String(event.payload.text ?? ""));
          }
        },
        onEnd: () => {
          setGenerating(false);
          setStreamText("");
          void refreshSession(cardId, sessionId, cardName);
        },
        onError: () => {
          setGenerating(false);
          setStreamText("");
          void refreshSession(cardId, sessionId, cardName);
        },
      });
      client.connect();
      sseRef.current = client;
    },
    [refreshSession]
  );

  // 发送消息
  const handleSend = async () => {
    if (!inputText.trim() || !session.cardId || !session.sessionId || generating) return;
    const userText = inputText;
    setGenerating(true);
    setStreamText("");
    setInputText("");

    try {
      const { run } = await api<{ run: { runId: string } }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          cardId: session.cardId,
          sessionId: session.sessionId,
          prompt: userText,
        }),
      });

      // 乐观追加用户楼
      setSession((prev) => ({
        ...prev,
        floors: [
          ...prev.floors,
          {
            id: `pending_${Date.now()}`,
            floorIndex: (prev.floors[prev.floors.length - 1]?.floorIndex ?? 0) + 1,
            role: "user",
            content: userText,
            swipes: [userText],
            currentSwipeIndex: 0,
            createdAt: Date.now(),
          },
        ],
      }));

      subscribeRun(run.runId, session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setGenerating(false);
      setConnError(String((err as Error).message ?? err));
    }
  };

  // 回退操作
  const handleRollback = async (floorId: string) => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(
        `/api/sessions/${session.sessionId}/rollback?cardId=${encodeURIComponent(session.cardId)}`,
        {
          method: "POST",
          body: JSON.stringify({ toFloorId: floorId }),
        }
      );
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  // 撤销回退
  const handleUndoRollback = async () => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(
        `/api/sessions/${session.sessionId}/undo-rollback?cardId=${encodeURIComponent(session.cardId)}`,
        {
          method: "POST",
        }
      );
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  // 编辑楼层
  const handleStartEdit = (floor: ChatFloor) => {
    setEditingFloorId(floor.id);
    setEditText(floor.content);
  };

  const saveEdit = async (floorId: string) => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(
        `/api/sessions/${session.sessionId}/floors/${floorId}/edit?cardId=${encodeURIComponent(session.cardId)}`,
        {
          method: "POST",
          body: JSON.stringify({ content: editText }),
        }
      );
      setEditingFloorId(null);
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  // 导入卡片处理（支持 JSON 与 PNG）
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportNotice(null);
    try {
      let res: { compat?: { spec?: string }; worldbookEntries?: number };
      if (file.name.endsWith(".png")) {
        const formData = new FormData();
        formData.append("file", file);
        res = await api<{ compat?: { spec?: string }; worldbookEntries?: number }>("/api/cards/import-st", {
          method: "POST",
          body: formData,
        });
      } else {
        const text = await file.text();
        const json = JSON.parse(text);
        res = await api<{ compat?: { spec?: string }; worldbookEntries?: number }>("/api/cards/import-st", {
          method: "POST",
          body: JSON.stringify(json),
        });
      }
      setImportNotice(`导入成功！规范: ${res.compat?.spec ?? "v2"} · 世界书条目: ${res.worldbookEntries ?? 0}`);
      loadCards();
    } catch (err) {
      setImportNotice(`导入失败: ${String((err as Error).message ?? err)}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const displayFloors: ChatFloor[] = generating && streamText
    ? [
        ...session.floors,
        {
          id: "streaming",
          floorIndex: (session.floors[session.floors.length - 1]?.floorIndex ?? 0) + 1,
          role: "assistant" as const,
          content: streamText,
          swipes: [streamText],
          currentSwipeIndex: 0,
          createdAt: Date.now(),
        },
      ]
    : session.floors;

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-[#FFFFFF] text-[#111827] font-sans antialiased">
      {/* 1. 左侧持久化系统导航 (支持折叠与动画过渡，遵循 Precision Canvas 规范) */}
      <aside
        style={{ width: sidebarCollapsed ? "4rem" : "16rem", minWidth: sidebarCollapsed ? "4rem" : "16rem", maxWidth: sidebarCollapsed ? "4rem" : "16rem" }}
        className="bg-[#FFFFFF] border-r border-[#E5E7EB] flex flex-col justify-between shrink-0 select-none z-30 transition-all duration-200 overflow-hidden"
      >
        <div className="flex flex-col overflow-hidden">
          {/* Logo 区域与折叠按钮 */}
          <div className="h-14 px-3 flex items-center justify-between border-b border-[#E5E7EB] overflow-hidden">
            <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
              <img src="/tavernloom_logo.svg" alt="TavernLoom Logo" className="h-7 w-7 rounded shrink-0" />
              {!sidebarCollapsed && (
                <span className="font-semibold text-[15px] tracking-tight text-[#111827] truncate">
                  TavernLoom · 织忆酒馆
                </span>
              )}
            </div>
            <button
              onClick={() => setSidebarCollapsed((prev) => !prev)}
              className="p-1 text-[#4B5563] hover:text-[#111827] hover:bg-[#F3F4F6] rounded transition-colors shrink-0 cursor-pointer flex items-center justify-center"
              title={sidebarCollapsed ? "展开侧栏 (Ctrl+B)" : "收起侧栏 (Ctrl+B)"}
            >
              <span className="material-symbols-outlined text-[18px]">
                {sidebarCollapsed ? "dock_to_right" : "dock_to_left"}
              </span>
            </button>
          </div>

          {/* 系统级导航标签 */}
          <nav className="p-2 flex flex-col gap-0.5">
            <button
              onClick={() => setActiveTab("characters")}
              title="角色库 / Characters"
              className={`flex items-center gap-2.5 px-3 py-2 rounded text-xs transition-colors cursor-pointer w-full text-left ${
                activeTab === "characters"
                  ? "bg-[#F3F4F6] text-[#111827] font-semibold"
                  : "text-[#4B5563] hover:bg-[#F9FAFB] hover:text-[#111827]"
              }`}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">group</span>
              {!sidebarCollapsed && <span className="truncate">角色库 / Characters</span>}
            </button>
            <button
              onClick={() => setActiveTab("session")}
              title="活跃会话 / Active Session"
              className={`flex items-center gap-2.5 px-3 py-2 rounded text-xs transition-colors cursor-pointer w-full text-left ${
                activeTab === "session"
                  ? "bg-[#F3F4F6] text-[#111827] font-semibold"
                  : "text-[#4B5563] hover:bg-[#F9FAFB] hover:text-[#111827]"
              }`}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">chat_bubble</span>
              {!sidebarCollapsed && <span className="truncate">活跃会话 / Active Session</span>}
            </button>
            <button
              onClick={() => setActiveTab("lorebook")}
              title="世界书 / Lorebook"
              className={`flex items-center gap-2.5 px-3 py-2 rounded text-xs transition-colors cursor-pointer w-full text-left ${
                activeTab === "lorebook"
                  ? "bg-[#F3F4F6] text-[#111827] font-semibold"
                  : "text-[#4B5563] hover:bg-[#F9FAFB] hover:text-[#111827]"
              }`}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">menu_book</span>
              {!sidebarCollapsed && <span className="truncate">世界书 / Lorebook</span>}
            </button>
            <button
              onClick={() => setActiveTab("engine")}
              title="引擎设置 / Engine & API"
              className={`flex items-center gap-2.5 px-3 py-2 rounded text-xs transition-colors cursor-pointer w-full text-left ${
                activeTab === "engine"
                  ? "bg-[#F3F4F6] text-[#111827] font-semibold"
                  : "text-[#4B5563] hover:bg-[#F9FAFB] hover:text-[#111827]"
              }`}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">tune</span>
              {!sidebarCollapsed && <span className="truncate">引擎设置 / Engine & API</span>}
            </button>
          </nav>
        </div>

        {/* 底部运行状态指示器 */}
        <div className="p-3 border-t border-[#E5E7EB] bg-[#F9FAFB] flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${connected ? "bg-[#047857]" : "bg-amber-500"}`}></span>
              {!sidebarCollapsed && (
                <span className="font-mono text-[11px] uppercase tracking-wider text-[#4B5563] truncate">
                  {connected ? "Ready" : "Offline"}
                </span>
              )}
            </div>
            {!sidebarCollapsed && <span className="font-mono text-[11px] text-[#9CA3AF]">v0.1.0</span>}
          </div>

          {!sidebarCollapsed && (
            <div className="flex items-center justify-between bg-[#FFFFFF] px-2.5 py-1 rounded border border-[#E5E7EB]">
              <div className="flex items-center gap-1.5 text-xs text-[#111827] min-w-0">
                <span className="material-symbols-outlined text-[14px] text-[#4B5563] shrink-0">dns</span>
                <span className="font-mono truncate">AIRP-Local</span>
              </div>
              <span className="font-mono text-[11px] text-[#4B5563] shrink-0">JSONL</span>
            </div>
          )}
        </div>
      </aside>

      {/* 2. 主体工作区容器 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 顶栏信息条 (Sticky Subheader) */}
        <header className="h-14 border-b border-[#E5E7EB] px-6 flex items-center justify-between bg-[#FFFFFF] shrink-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-xs uppercase tracking-wider text-[#4B5563]">Workspace</span>
            <span className="text-[#E5E7EB]">/</span>
            <span className="font-medium text-xs text-[#111827] truncate">
              {session.cardName ? `${session.cardName} · 织忆核心` : "TavernLoom 织忆核心"}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono">
            {importNotice && (
              <span className="text-[#047857] bg-[#ECFDF5] border border-[#A7F3D0] px-2.5 py-0.5 rounded text-[11px]">
                {importNotice}
              </span>
            )}

            {/* 会话内左右栏快速折叠控制 */}
            {activeTab === "session" && (
              <div className="flex items-center gap-1 bg-[#F9FAFB] p-0.5 rounded border border-[#E5E7EB]">
                <button
                  onClick={() => setLeftPanelCollapsed((prev) => !prev)}
                  className={`p-1 rounded text-[#4B5563] hover:text-[#111827] transition-colors cursor-pointer flex items-center ${
                    leftPanelCollapsed ? "bg-[#E5E7EB] text-[#111827]" : ""
                  }`}
                  title={leftPanelCollapsed ? "展开角色档案栏" : "收起角色档案栏"}
                >
                  <span className="material-symbols-outlined text-[16px]">side_navigation</span>
                </button>
                <button
                  onClick={() => setRightPanelCollapsed((prev) => !prev)}
                  className={`p-1 rounded text-[#4B5563] hover:text-[#111827] transition-colors cursor-pointer flex items-center ${
                    rightPanelCollapsed ? "bg-[#E5E7EB] text-[#111827]" : ""
                  }`}
                  title={rightPanelCollapsed ? "展开状态事实栏" : "收起状态事实栏"}
                >
                  <span className="material-symbols-outlined text-[16px]">right_panel_close</span>
                </button>
              </div>
            )}

            <div className="flex items-center gap-1.5 bg-[#F9FAFB] px-2.5 py-1 rounded border border-[#E5E7EB] text-[#4B5563]">
              <span className="material-symbols-outlined text-[14px]">bolt</span>
              <span>{generating ? "Streaming" : "Ready"}</span>
            </div>
            <span className="text-[#E5E7EB]">·</span>
            <div className="text-[#4B5563]">
              <span>{session.floors.length} 楼</span>
            </div>
          </div>
        </header>

        {/* 3. 视图分发 */}
        {activeTab === "characters" ? (
          <div className="flex-1 p-6 overflow-y-auto bg-[#F9FAFB]">
            <div className="max-w-6xl mx-auto space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-[#111827]">角色记忆库 / Tavern Characters</h1>
                  <p className="text-xs text-[#4B5563] mt-1">本地 SillyTavern V2/V3 规范角色卡物理目录与解析器</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    className="px-3 py-1.5 rounded bg-[#111827] hover:bg-black text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shadow-sm disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">file_upload</span>
                    <span>导入角色卡 (PNG/JSON)</span>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".png,.json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {cards.map((c) => {
                  const active = c.cardId === session.cardId;
                  return (
                    <div
                      key={c.cardId}
                      onClick={() => openSession(c)}
                      className={`p-4 rounded-xl border bg-[#FFFFFF] cursor-pointer transition hover:shadow-md ${
                        active ? "border-[#111827] ring-1 ring-[#111827]" : "border-[#E5E7EB] hover:border-[#D1D5DB]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-lg bg-[#F3F4F6] border border-[#E5E7EB] overflow-hidden flex items-center justify-center font-bold text-sm text-[#4B5563]">
                            {c.name.slice(0, 2)}
                          </div>
                          <div>
                            <div className="font-semibold text-sm text-[#111827]">{c.name}</div>
                            <div className="font-mono text-[10px] text-[#9CA3AF] mt-0.5">{c.cardId}</div>
                          </div>
                        </div>
                        {active && (
                          <span className="text-[10px] bg-[#111827] text-white px-1.5 py-0.5 rounded font-mono">
                            活跃
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#4B5563] mt-3 line-clamp-2 leading-relaxed">
                        {c.description || "暂无人设描述。"}
                      </p>
                      <div className="mt-4 pt-3 border-t border-[#F3F4F6] flex items-center justify-between text-[11px] text-[#9CA3AF] font-mono">
                        <span>SillyTavern Spec</span>
                        <span className="text-[#111827] font-medium">点击开启对话 ↵</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : activeTab === "lorebook" ? (
          <div className="flex-1 p-6 overflow-y-auto bg-[#F9FAFB]">
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <h1 className="text-xl font-bold text-[#111827]">世界书 / World Lorebook</h1>
                <p className="text-xs text-[#4B5563] mt-1">
                  当前角色卡（{session.cardName || "未选择"}）绑定的世界书条目与激活状态
                </p>
              </div>

              <div className="bg-[#FFFFFF] p-5 rounded-xl border border-[#E5E7EB] space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px] text-[#111827]">auto_stories</span>
                    <span className="font-semibold text-sm text-[#111827]">双模检索与确定性过滤</span>
                  </div>
                  <span className="font-mono text-xs text-[#047857] bg-[#ECFDF5] px-2 py-0.5 rounded">
                    Active
                  </span>
                </div>
                <p className="text-xs text-[#4B5563] leading-relaxed">
                  AIRP 遵循 SillyTavern 激活语义（clean-room 实现）：
                  常驻（constant）条目无条件激活；关键词条目按主键命中 + 副键（AND_ANY / NOT_ALL / NOT_ANY / AND_ALL）四种逻辑门过滤，支持 scan_depth 深度约束与概率门。
                </p>
                <div className="pt-2 text-[11px] font-mono text-[#9CA3AF]">
                  数据来源: card_store.readWorldbook(cardId)
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === "engine" ? (
          <div className="flex-1 p-6 overflow-y-auto bg-[#F9FAFB]">
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <h1 className="text-xl font-bold text-[#111827]">引擎与 API 设置 / Engine & API Gateway</h1>
                <p className="text-xs text-[#4B5563] mt-1">
                  TavernLoom 本地记忆引擎、模型接口与持久化层运行参数
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#FFFFFF] p-5 rounded-xl border border-[#E5E7EB] space-y-3">
                  <div className="font-semibold text-sm text-[#111827] flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px]">dns</span>
                    <span>存储与数据完整性 (Storage Ground)</span>
                  </div>
                  <ul className="text-xs text-[#4B5563] space-y-1.5 font-mono">
                    <li>· 存储模式: 一卡一目录物理独立</li>
                    <li>· 事件日志: JSONL (append-only + fsync)</li>
                    <li>· 快照机制: 每 N 事件原子落盘 checkpoint</li>
                    <li>· 单实例互斥: .lock PID 存活检测</li>
                  </ul>
                </div>

                <div className="bg-[#FFFFFF] p-5 rounded-xl border border-[#E5E7EB] space-y-3">
                  <div className="font-semibold text-sm text-[#111827] flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px]">smart_toy</span>
                    <span>模型与管家 (Model & Butler)</span>
                  </div>
                  <ul className="text-xs text-[#4B5563] space-y-1.5 font-mono">
                    <li>· 传输接口: ModelStreamPort / SSE</li>
                    <li>· 管家服务: ButlerService 四级降级阶梯</li>
                    <li>· 一致性协议: 楼层落地后推进状态提取</li>
                    <li>· 正则渲染: 双侧分离 (Display vs Prompt)</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* 主会话画布：三栏架构（支持左右栏自由折叠） */
          <div className="flex-1 flex overflow-hidden">
            {/* 栏 1：角色上下文与时间线（支持折叠） */}
            {!leftPanelCollapsed && (
              <aside className="w-64 border-r border-[#E5E7EB] bg-[#FFFFFF] flex flex-col shrink-0 overflow-y-auto select-none transition-all duration-200">
                {/* 角色档案卡片 */}
                <div className="p-4 border-b border-[#E5E7EB]">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 border border-[#E5E7EB] bg-[#F3F4F6]">
                      <img
                        src="/design-assets/avatar_sylvia.png"
                        alt={session.cardName || "角色"}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = "none";
                        }}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-[#111827] truncate">
                        {session.cardName || "未选择角色"}
                      </div>
                      <div className="text-[11px] text-[#4B5563] font-mono truncate">
                        {session.cardId ? `ID: ${session.cardId.slice(0, 12)}` : "请在列表开启"}
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#F9FAFB] p-2.5 rounded border border-[#E5E7EB] flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[#4B5563] text-[11px] font-mono">
                      <span className="uppercase">Persona Seed</span>
                      <span>v2 Spec</span>
                    </div>
                    <p className="text-xs text-[#374151] line-clamp-3 leading-relaxed">
                      {session.cardSubtitle || "角色设定与世界观已由事件溯源框架安全持久化。"}
                    </p>
                  </div>
                </div>

                {/* 故事时间线分支 (Branch Timelines) */}
                <div className="p-4 border-b border-[#E5E7EB]">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[11px] font-mono uppercase tracking-wider text-[#4B5563] flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">account_tree</span>
                      分支时间线 / Branches
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="p-2 rounded bg-[#F3F4F6] border border-[#111827]/20 flex flex-col gap-0.5 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-[#111827]">#main (当前活跃)</span>
                        <span className="text-[11px] font-mono text-[#4B5563]">{session.floors.length} 楼</span>
                      </div>
                      <span className="text-xs text-[#4B5563] truncate">事件潮汐已物理落盘</span>
                    </div>
                  </div>
                </div>

                {/* 挂载的世界书条目 */}
                <div className="p-4 flex-1 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-mono uppercase tracking-wider text-[#4B5563] flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">auto_stories</span>
                        世界书投影
                      </span>
                      <span className="text-[11px] font-mono text-[#4B5563]">双模激活</span>
                    </div>
                    <div className="p-2.5 rounded border border-[#E5E7EB] bg-[#F9FAFB] text-xs text-[#4B5563]">
                      世界书条目在会话中按关键词与常驻规则实时投影，保障上下文极简无泄漏。
                    </div>
                  </div>

                  {session.undoCheckpointAvailable && (
                    <div className="pt-3 border-t border-[#E5E7EB]">
                      <button
                        onClick={() => void handleUndoRollback()}
                        className="w-full py-1.5 rounded bg-[#FEF3C7] border border-amber-300 hover:bg-amber-100 text-[#B45309] font-medium text-xs flex items-center justify-center gap-1 cursor-pointer transition"
                      >
                        <span className="material-symbols-outlined text-[14px]">undo</span>
                        <span>撤销回退 (自包含恢复)</span>
                      </button>
                    </div>
                  )}
                </div>
              </aside>
            )}

            {/* 栏 2：中央沉浸对话流视口 */}
            <main className="flex-1 flex flex-col bg-[#FFFFFF] min-w-0 overflow-hidden relative">
              {/* 会话顶部辅助行 */}
              <div className="h-10 border-b border-[#E5E7EB] px-6 flex items-center justify-between shrink-0 bg-[#FFFFFF]">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-xs text-[#111827]">{session.cardName || "未开启"}</span>
                  <span className="text-[11px] font-mono text-[#4B5563] bg-[#F3F4F6] px-1.5 py-0.5 rounded border border-[#E5E7EB]">
                    Op: Active
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs font-mono text-[#4B5563]">
                  <span>状态物理遗忘已开启</span>
                </div>
              </div>

              {/* 虚拟化楼层渲染视口 */}
              <div ref={parentRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-7 flex flex-col items-center">
                <div className="w-full max-w-[780px] space-y-7">
                  {/* 滚动摘要胶囊 */}
                  {session.rollingSummary && (
                    <div className="flex justify-center">
                      <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#F9FAFB] border border-[#E5E7EB] text-xs text-[#4B5563] font-mono shadow-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#047857]"></span>
                        <span>滚动摘要 · {session.summaryCoverage}</span>
                      </div>
                    </div>
                  )}

                  {displayFloors.map((floor) => {
                    const isUser = floor.role === "user";
                    return (
                      <div key={floor.id} className="group relative space-y-2">
                        {/* 楼层元信息 */}
                        <div className="flex items-center justify-between text-xs text-[#9CA3AF] font-mono">
                          <span className={isUser ? "text-[#111827] font-semibold" : "text-[#111827] font-semibold"}>
                            {isUser ? "旅行者 (你)" : session.cardName || "角色"} · #{floor.floorIndex}
                          </span>
                          {!isUser && floor.id !== "streaming" && (
                            <div className="opacity-0 group-hover:opacity-100 transition flex items-center gap-2 text-[11px]">
                              <button
                                onClick={() => handleStartEdit(floor)}
                                className="hover:text-[#111827] cursor-pointer"
                              >
                                编辑
                              </button>
                              <span>·</span>
                              <button
                                onClick={() => handleRollback(floor.id)}
                                className="hover:text-[#DC2626] cursor-pointer"
                              >
                                回退到此
                              </button>
                            </div>
                          )}
                        </div>

                        {/* 楼层内容 */}
                        {editingFloorId === floor.id ? (
                          <div className="space-y-2 bg-[#F9FAFB] p-3 rounded border border-[#E5E7EB]">
                            <textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              rows={4}
                              className="w-full bg-[#FFFFFF] text-[#111827] p-2 text-xs rounded border border-[#E5E7EB] focus:outline-none focus:border-[#111827]"
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => setEditingFloorId(null)}
                                className="px-2 py-1 text-xs text-[#4B5563] hover:text-[#111827] cursor-pointer"
                              >
                                取消
                              </button>
                              <button
                                onClick={() => void saveEdit(floor.id)}
                                className="px-3 py-1 text-xs bg-[#111827] text-white font-medium rounded cursor-pointer"
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className={`text-[15px] leading-relaxed text-[#374151] pl-3 border-l-2 ${
                              isUser
                                ? "border-[#111827] bg-[#F9FAFB] p-3 rounded"
                                : "border-[#E5E7EB] py-1"
                            }`}
                            dangerouslySetInnerHTML={{
                              __html: sanitizeHtml(
                                new RegexPipeline(regexScripts).process(floor.content, {
                                  side: "display",
                                  placement: isUser ? 1 : 2,
                                })
                              ),
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 底部输入框 */}
              <div className="p-4 border-t border-[#E5E7EB] bg-[#FFFFFF] flex justify-center">
                <div className="w-full max-w-[780px] flex gap-2.5">
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder="输入叙事行动或对话…… (Enter 发送, Shift+Enter 换行)"
                    rows={2}
                    disabled={generating || !session.cardId}
                    className="flex-1 bg-[#FFFFFF] border border-[#E5E7EB] rounded p-3 text-sm text-[#111827] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111827] resize-none transition"
                  />
                  <button
                    onClick={() => void handleSend()}
                    disabled={generating || !inputText.trim() || !session.cardId}
                    className="px-6 bg-[#111827] hover:bg-black disabled:bg-[#E5E7EB] disabled:text-[#9CA3AF] text-white font-medium text-xs rounded transition flex items-center justify-center cursor-pointer"
                  >
                    {generating ? "生成中…" : "发送 ↵"}
                  </button>
                </div>
              </div>
            </main>

            {/* 栏 3：右侧状态事实与管家监控面板（支持折叠） */}
            {!rightPanelCollapsed && (
              <aside className="w-64 border-l border-[#E5E7EB] bg-[#FFFFFF] p-4 flex flex-col gap-6 overflow-y-auto shrink-0 select-none transition-all duration-200">
                <div>
                  <div className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#4B5563] mb-2 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">dataset</span>
                    结构化状态 (StateSnapshot)
                  </div>
                  {Object.keys(session.currentState).length === 0 ? (
                    <div className="text-xs text-[#9CA3AF] bg-[#F9FAFB] p-3 rounded border border-[#E5E7EB]">
                      尚无状态——由后台管家在每轮生成后按四级降级提取。
                    </div>
                  ) : (
                    <pre className="text-xs bg-[#F9FAFB] p-2.5 rounded border border-[#E5E7EB] text-[#111827] font-mono overflow-x-auto">
                      {JSON.stringify(session.currentState, null, 2)}
                    </pre>
                  )}
                </div>

                <div>
                  <div className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#4B5563] mb-2 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">smart_toy</span>
                    后台管家 (ButlerService)
                  </div>
                  <div className="text-xs text-[#4B5563] bg-[#F9FAFB] p-3 rounded border border-[#E5E7EB] space-y-2">
                    <div className="flex justify-between items-center">
                      <span>运行状态:</span>
                      <span className="font-mono text-[#047857] font-semibold">空闲 (idle)</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>一致性协议:</span>
                      <span className="font-mono text-[#111827]">楼层已同步</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>失败处理:</span>
                      <span className="font-mono text-[#9CA3AF]">显式降级</span>
                    </div>
                  </div>
                </div>
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
