// src/ui/App.tsx
// TavernLoom · 织忆酒馆 —— 永不遗忘的酒馆角色扮演引擎
// 纯白高品质极简三栏风格（复用原版纯白配色与细边框设计，深度融入新品牌与全量交互功能）。

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

  const sseRef = useRef<AIRPEventSourceClient | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          `/api/cards/${encodeURIComponent(card.cardId)}/st-original`
        )
          .then((orig) => {
            const scripts = orig?.data?.extensions?.regex_scripts;
            setRegexScripts(Array.isArray(scripts) ? scripts : []);
          })
          .catch(() => setRegexScripts([]));

        await refreshSession(card.cardId, sessionId, card.name);
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
    <div className="layout-root text-[13px] bg-white text-[#0D0D0D]">
      {/* 1. 顶栏：纯白底色、高对比文字与极简徽标 */}
      <header className="layout-header border-b border-[#E5E5E5] bg-white">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img src="/src/ui/logo.svg" alt="TavernLoom Logo" className="w-5 h-5" />
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs tracking-tight text-[#0D0D0D]">
                TavernLoom
              </span>
              <span className="text-[10px] text-[#8E8E8E] font-normal">织忆酒馆</span>
            </div>
          </div>

          <span className="text-[#E5E5E5]">/</span>
          <div className="flex items-center gap-1.5 text-xs text-[#5D5D5D] font-medium">
            <span
              className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#1075E3]" : "bg-amber-500"}`}
            ></span>
            <span className="text-[#0D0D0D]">{session.sessionTitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-[11px] font-mono">
          {importNotice && (
            <span className="text-[#1075E3] bg-[#EFF6FF] border border-[#BFDBFE] px-2.5 py-0.5 rounded-full text-[10px]">
              {importNotice}
            </span>
          )}
          <div className="flex items-center gap-1.5 text-[#5D5D5D]">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                generating ? "bg-[#10A37F] animate-pulse" : connected ? "bg-[#10A37F]" : "bg-amber-500"
              }`}
            ></span>
            <span className="font-sans">{generating ? "生成中" : connected ? "就绪" : "未连接"}</span>
          </div>
          <span className="text-[#E5E5E5]">·</span>
          <div className="text-[#5D5D5D]">
            <span>{session.floors.length} 楼</span>
          </div>
        </div>
      </header>

      {/* 2. 主体三栏布局 */}
      <div className="layout-body">
        {/* 左栏：角色记忆库与导入按钮 */}
        <aside className="layout-sidebar-left">
          <div className="p-3 border-b border-[#E5E5E5] flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#8E8E8E] uppercase tracking-wider">
              角色卡 ({cards.length})
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="px-2 py-1 text-[11px] rounded bg-[#0D0D0D] hover:bg-black text-white font-medium flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
            >
              <span>+ 导入卡片</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.json"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {cards.map((c) => {
              const active = c.cardId === session.cardId;
              return (
                <div
                  key={c.cardId}
                  onClick={() => openSession(c)}
                  className={`p-2.5 rounded-lg cursor-pointer transition border ${
                    active
                      ? "bg-white border-[#0D0D0D] shadow-sm text-[#0D0D0D]"
                      : "border-transparent hover:bg-[#F4F4F4] text-[#5D5D5D]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-[#0D0D0D]">{c.name}</span>
                    {active && (
                      <span className="text-[9px] bg-[#E5E5E5] text-[#0D0D0D] px-1.5 py-0.2 rounded font-mono">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-[#8E8E8E] truncate mt-0.5 font-mono">{c.cardId}</div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* 中栏：会话流视口 */}
        <main className="layout-main">
          <div className="h-10 border-b border-[#E5E5E5] bg-white px-6 flex items-center justify-between shrink-0 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#8E8E8E]">分支 {session.sessionBranch} · JSONL 物理落盘</span>
            </div>

            {session.undoCheckpointAvailable && (
              <button
                onClick={() => void handleUndoRollback()}
                className="px-2.5 py-0.5 text-[11px] rounded bg-[#FEF3C7] border border-amber-300 hover:bg-amber-100 text-[#B45309] font-medium cursor-pointer transition"
              >
                ↺ 撤销回退
              </button>
            )}
          </div>

          {/* 虚拟化楼层 */}
          <div ref={parentRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-7 flex flex-col items-center">
            <div className="w-full max-w-[820px] space-y-7">
              {session.rollingSummary && (
                <div className="flex justify-center">
                  <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#F4F4F4] border border-[#E5E5E5] text-[11px] text-[#5D5D5D] font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#1075E3]"></span>
                    <span>记忆摘要 · {session.summaryCoverage}</span>
                  </div>
                </div>
              )}

              {displayFloors.map((floor) => {
                const isUser = floor.role === "user";
                return (
                  <div key={floor.id} className="group relative space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-[#8E8E8E] font-mono">
                      <span className={isUser ? "text-[#0D0D0D] font-bold" : "text-[#1075E3] font-bold"}>
                        {isUser ? "旅行者 (你)" : session.cardName || "助手"} · #{floor.floorIndex}
                      </span>
                      {!isUser && floor.id !== "streaming" && (
                        <div className="opacity-0 group-hover:opacity-100 transition flex items-center gap-2">
                          <button
                            onClick={() => handleStartEdit(floor)}
                            className="hover:text-[#0D0D0D] cursor-pointer"
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

                    {editingFloorId === floor.id ? (
                      <div className="space-y-2 bg-[#F4F4F4] p-3 rounded-xl border border-[#E5E5E5]">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={4}
                          className="w-full bg-white text-[#0D0D0D] p-2 text-xs rounded border border-[#E5E5E5] focus:outline-none"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setEditingFloorId(null)}
                            className="px-2 py-1 text-xs text-[#8E8E8E] hover:text-[#0D0D0D] cursor-pointer"
                          >
                            取消
                          </button>
                          <button
                            onClick={() => void saveEdit(floor.id)}
                            className="px-3 py-1 text-xs bg-[#0D0D0D] text-white font-semibold rounded cursor-pointer"
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="pl-2 text-[15px] leading-7 text-[#0D0D0D] space-y-2"
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
          <div className="p-5 border-t border-[#E5E5E5] bg-white flex justify-center">
            <div className="w-full max-w-[820px] flex gap-3">
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="与角色交谈…… (Enter 发送, Shift+Enter 换行)"
                rows={2}
                disabled={generating || !session.cardId}
                className="flex-1 bg-[#F4F4F4] border border-[#E5E5E5] rounded-xl p-3 text-sm text-[#0D0D0D] placeholder-[#8E8E8E] focus:outline-none focus:bg-white focus:border-[#0D0D0D] resize-none transition"
              />
              <button
                onClick={() => void handleSend()}
                disabled={generating || !inputText.trim() || !session.cardId}
                className="px-6 bg-[#0D0D0D] hover:bg-black disabled:bg-[#E5E5E5] disabled:text-[#8E8E8E] text-white font-medium text-xs rounded-xl transition flex items-center justify-center cursor-pointer shadow-sm"
              >
                {generating ? "生成中…" : "发送 ↵"}
              </button>
            </div>
          </div>
        </main>

        {/* 右栏：结构化事实与后端管家 */}
        <aside className="layout-sidebar-right p-5 flex flex-col gap-6 overflow-y-auto">
          <div>
            <div className="text-[11px] font-bold text-[#8E8E8E] uppercase tracking-wider mb-2">
              结构化事实 (StateSnapshot)
            </div>
            {Object.keys(session.currentState).length === 0 ? (
              <div className="text-xs text-[#8E8E8E] bg-[#F4F4F4] p-3 rounded-lg border border-[#E5E5E5]">
                暂无状态提取记录。
              </div>
            ) : (
              <pre className="text-[11px] bg-[#F4F4F4] p-3 rounded-lg border border-[#E5E5E5] text-[#0D0D0D] font-mono overflow-x-auto">
                {JSON.stringify(session.currentState, null, 2)}
              </pre>
            )}
          </div>

          <div>
            <div className="text-[11px] font-bold text-[#8E8E8E] uppercase tracking-wider mb-2">
              后端管家 (ButlerService)
            </div>
            <div className="text-xs text-[#5D5D5D] bg-[#F4F4F4] p-3 rounded-lg border border-[#E5E5E5] space-y-1.5">
              <div className="flex justify-between items-center">
                <span>状态:</span>
                <span className="font-mono text-[#10A37F] font-semibold">空闲 (idle)</span>
              </div>
              <div className="flex justify-between items-center">
                <span>降级阶梯:</span>
                <span className="font-mono text-[#1075E3]">Tier 4 活跃</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
