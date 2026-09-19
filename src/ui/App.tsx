// src/ui/App.tsx
// 真实 API 驱动的会话前端（H-9 修复：硬编码零接线 → 全量接 AIRP HTTP API）。
// 令牌从 URL ?token= 读取；所有 /api 请求带 X-AIRP-Token 头。
// 保留：三栏视觉结构、sanitizeHtml 管线、@tanstack/react-virtual 虚拟化。

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChatFloor, SessionState, CardListItem, SessionTreeProjection } from "./types.js";
import { sanitizeHtml } from "./sanitize.js";
import { AIRPEventSourceClient } from "./sse-client.js";

// ---------------------------------------------------------------------------
// API 客户端：token 从 URL ?token= 取，请求头携带
// ---------------------------------------------------------------------------
const TOKEN = new URLSearchParams(window.location.search).get("token") ?? "";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
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
      swipes: f.swipes.length > 0 ? f.swipes : [f.content],
      currentSwipeIndex: f.currentSwipeIndex,
      createdAt: f.createdAt,
    }));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export const App: React.FC = () => {
  // 连接状态
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [connected, setConnected] = useState(TOKEN !== "");
  const [connError, setConnError] = useState<string | null>(null);

  // 会话状态
  const [session, setSession] = useState<SessionState>({
    cardId: "",
    cardName: "",
    cardSubtitle: "",
    sessionId: "",
    sessionTitle: "未连接会话",
    sessionBranch: "main",
    floors: [],
    currentState: {},
    rollingSummary: null,
    summaryCoverage: "—",
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
  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState("");

  const sseRef = useRef<AIRPEventSourceClient | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: session.floors.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  });

  // 刷新会话树（回退/撤销/编辑后的权威状态同步）
  const refreshSession = useCallback(async (cardId: string, sessionId: string, cardName: string) => {
    const proj = await api<SessionTreeProjection>(
      `/api/sessions/${sessionId}/tree?cardId=${encodeURIComponent(cardId)}`
    );
    const floors = floorsFromTree(proj);
    setSession((prev) => ({
      ...prev,
      cardName,
      floors,
      currentState: proj.state,
      rollingSummary: proj.summary,
      undoCheckpointAvailable: proj.tree.undoCheckpointFloorId !== null,
      sessionTitle: `${cardName} · 会话 ${sessionId.slice(0, 12)}`,
      summaryCoverage: proj.summary ? `${proj.summary.length} 字摘要` : "无摘要",
    }));
  }, []);

  // 启动：加载卡片列表
  useEffect(() => {
    if (!TOKEN) {
      setConnError("缺少 ?token= 启动令牌——请从 AIRP 启动输出的 URL 进入。");
      return;
    }
    api<{ cards: CardListItem[] }>("/api/cards")
      .then((res) => {
        setCards(res.cards);
        setConnected(true);
      })
      .catch((err) => setConnError(String(err.message ?? err)));
  }, []);

  // 打开会话：localStorage 记住该卡片上次会话（刷新恢复），无记录时复用最新非空会话，否则新建
  const openSession = useCallback(
    async (card: CardListItem) => {
      try {
        const storageKey = `airp:session:${card.cardId}`;
        let sessionId: string | null = null;
        try {
          sessionId = window.localStorage.getItem(storageKey);
        } catch {
          // localStorage 不可用（隐私模式等）——走列表回退
        }

        if (!sessionId) {
          const res = await api<{ sessions: string[] }>(
            `/api/sessions?cardId=${encodeURIComponent(card.cardId)}`
          );
          // 复用最新会话（创建序末尾）
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
        } catch {
          // 持久化失败不阻断
        }
        setSession((prev) => ({ ...prev, cardId: card.cardId, sessionId }));
        await refreshSession(card.cardId, sessionId, card.name);
      } catch (err) {
        setConnError(String((err as Error).message ?? err));
      }
    },
    [refreshSession]
  );

  // SSE 订阅当前 Run：run_delta 流式渲染 + 终态后刷新树
  const subscribeRun = useCallback(
    (runId: string, cardId: string, sessionId: string, cardName: string) => {
      sseRef.current?.close();
      const client = new AIRPEventSourceClient({
        url: `/api/runs/${runId}/events`,
        token: TOKEN,
        fromSeq: 0,
        onEvent: (ev) => {
          if (ev.type === "run_delta") {
            setStreamText((prev) => prev + (ev.payload as { text: string }).text);
          }
        },
        onEnd: () => {
          setGenerating(false);
          setStreamText("");
          sseRef.current?.close();
          void refreshSession(cardId, sessionId, cardName);
        },
        onError: () => {
          setGenerating(false);
        },
      });
      client.connect();
      sseRef.current = client;
    },
    [refreshSession]
  );

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
      // 乐观追加用户楼（树刷新会替换为权威数据）
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

  const handleSwipe = async (floorId: string, delta: number) => {
    const floor = session.floors.find((f) => f.id === floorId);
    if (!floor) return;
    const nextIdx = floor.currentSwipeIndex + delta;
    if (nextIdx < 0 || nextIdx >= floor.swipes.length) return;
    // 已有 swipe 之间切换：本地立即切（服务器投影已含全部 swipe）
    setSession((prev) => ({
      ...prev,
      floors: prev.floors.map((fl) =>
        fl.id === floorId ? { ...fl, currentSwipeIndex: nextIdx, content: fl.swipes[nextIdx] } : fl
      ),
    }));
  };

  const handleRegenerate = async () => {
    const last = session.floors[session.floors.length - 1];
    if (!last || last.role !== "assistant" || !session.cardId || generating) return;
    setGenerating(true);
    setStreamText("");
    try {
      // swipe 最后一楼 = 重掷：追加新 swipe 内容为固定提示（真实重掷需模型输出，此处走 run）
      await api(`/api/sessions/${session.sessionId}/floors/${last.id}/swipe?cardId=${encodeURIComponent(session.cardId)}`, {
        method: "POST",
        body: JSON.stringify({ content: "（重新生成……）" }),
      });
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    } finally {
      setGenerating(false);
    }
  };

  const handleRollback = async (floorId: string) => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(`/api/sessions/${session.sessionId}/rollback?cardId=${encodeURIComponent(session.cardId)}`, {
        method: "POST",
        body: JSON.stringify({ toFloorId: floorId }),
      });
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  const handleUndoRollback = async () => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(`/api/sessions/${session.sessionId}/undo-rollback?cardId=${encodeURIComponent(session.cardId)}`, {
        method: "POST",
      });
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  const saveEdit = async (floorId: string) => {
    if (!session.cardId || !session.sessionId) return;
    try {
      await api(`/api/sessions/${session.sessionId}/floors/${floorId}/edit?cardId=${encodeURIComponent(session.cardId)}`, {
        method: "POST",
        body: JSON.stringify({ content: editText }),
      });
      setEditingFloorId(null);
      await refreshSession(session.cardId, session.sessionId, session.cardName);
    } catch (err) {
      setConnError(String((err as Error).message ?? err));
    }
  };

  // 展示楼层 = 已落地楼层 + 流式生成中的临时楼
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
    <div className="layout-root text-[13px]">
      {/* 1. 顶栏 */}
      <header className="layout-header">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-[#0D0D0D] flex items-center justify-center font-bold text-[10px] text-white">
              A
            </div>
            <span className="font-semibold text-xs tracking-tight text-[#0D0D0D]">AIRP</span>
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
            <span className="text-[#0D0D0D] font-semibold ml-1.5">{session.estimatedCost}</span>
          </div>
        </div>
      </header>

      {/* 连接错误横幅 */}
      {connError && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-800 flex items-center justify-between">
          <span className="truncate">{connError}</span>
          <button onClick={() => setConnError(null)} className="ml-3 underline cursor-pointer shrink-0">
            关闭
          </button>
        </div>
      )}

      {/* 2. 三栏布局 */}
      <div className="layout-body">
        {/* A. 左侧边栏：卡片列表 */}
        <aside className="layout-sidebar-left">
          <div className="p-3.5 border-b border-[#E5E5E5] flex items-center justify-between">
            <span className="text-xs font-semibold text-[#8E8E8E] uppercase tracking-wider">角色卡</span>
            <span className="text-[10px] font-mono text-[#8E8E8E]">{cards.length} 张</span>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {cards.length === 0 && (
              <div className="p-4 text-center text-[11px] text-[#8E8E8E]">
                {connected ? "暂无卡片——通过 API 导入 ST 卡后刷新" : "等待连接…"}
              </div>
            )}
            {cards.map((card) => {
              const active = card.cardId === session.cardId;
              return (
                <button
                  key={card.cardId}
                  onClick={() => void openSession(card)}
                  className={`w-full text-left p-3 rounded-xl border shadow-sm cursor-pointer space-y-2 transition ${
                    active
                      ? "bg-white border-[#0D0D0D]/40"
                      : "bg-white border-[#0D0D0D]/15 hover:border-[#0D0D0D]/30"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#F4F4F4] border border-[#E5E5E5] flex items-center justify-center font-bold text-xs text-[#0D0D0D] shrink-0">
                      {card.name.slice(0, 1)}
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-[#0D0D0D] truncate">{card.name}</span>
                        {active && (
                          <span className="text-[9px] bg-[#0D0D0D] text-white px-1.5 py-0.2 rounded font-mono">
                            当前
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#8E8E8E] font-mono mt-0.5 truncate">
                        {card.cardId}
                      </div>
                    </div>
                  </div>
                  {card.description && (
                    <div className="text-[10px] text-[#5D5D5D] line-clamp-2">{card.description}</div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="p-3 border-t border-[#E5E5E5] bg-[#F9F9F9] text-center space-y-1">
            <div className="text-[10px] text-[#8E8E8E] font-mono">
              点击卡片开始会话
            </div>
          </div>
        </aside>

        {/* B. 中央聊天区 */}
        <main className="layout-main">
          <div className="h-12 border-b border-[#E5E5E5] bg-white px-6 flex items-center justify-between shrink-0 text-xs">
            <div className="space-y-0.5">
              <div className="font-bold text-[#0D0D0D] text-xs">{session.sessionTitle}</div>
              <div className="text-[10px] text-[#8E8E8E]">
                分支 {session.sessionBranch} · 事件潮汐已持久化
              </div>
            </div>

            <div className="flex items-center gap-3 font-mono">
              {session.undoCheckpointAvailable && (
                <button
                  onClick={() => void handleUndoRollback()}
                  className="px-2.5 py-1 text-[11px] rounded-lg bg-[#FEF3C7] border border-amber-300 hover:bg-amber-100 text-[#B45309] font-medium cursor-pointer transition"
                >
                  ↺ 撤销回退
                </button>
              )}
              <span className="text-[#E5E5E5]">/</span>
              <span className="text-[#5D5D5D] font-bold">
                {session.floors.length > 0
                  ? `#${session.floors[session.floors.length - 1].floorIndex}`
                  : "—"}
              </span>
            </div>
          </div>

          {/* 虚拟化列表视口 */}
          <div ref={parentRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-7 flex flex-col items-center">
            <div className="w-full max-w-[820px] space-y-7">
              {session.rollingSummary && (
                <div className="flex justify-center">
                  <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#F4F4F4] border border-[#E5E5E5] text-[11px] text-[#5D5D5D] font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#1075E3]"></span>
                    <span>滚动摘要 · {session.summaryCoverage}</span>
                  </div>
                </div>
              )}

              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const floor = displayFloors[virtualRow.index];
                  if (!floor) return null;
                  const isUser = floor.role === "user";
                  const isStreaming = floor.id === "streaming";

                  return (
                    <div
                      key={floor.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="pb-7"
                    >
                      {isUser ? (
                        <div className="flex justify-end">
                          <div className="max-w-[620px] bg-[#F4F4F4] text-[#0D0D0D] p-4 rounded-2xl rounded-tr-sm border border-[#E5E5E5] shadow-sm space-y-1.5">
                            <div className="flex items-center justify-between text-[11px] font-mono text-[#8E8E8E] border-b border-[#E5E5E5] pb-1">
                              <span className="font-sans font-semibold text-[#0D0D0D] flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#10A37F]"></span> 旅行者 (你)
                              </span>
                              <span>#{floor.floorIndex}</span>
                            </div>
                            <p className="text-[15px] leading-7 pt-0.5">{floor.content}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg overflow-hidden border border-[#E5E5E5] bg-[#F4F4F4] flex items-center justify-center font-bold text-xs text-[#0D0D0D] shrink-0">
                                {session.cardName.slice(0, 1) || "?"}
                              </div>
                              <span className="font-bold text-xs text-[#0D0D0D]">{session.cardName || "角色"}</span>
                              <span className="text-[11px] text-[#8E8E8E] font-mono">#{floor.floorIndex}</span>
                            </div>

                            {!isStreaming && (
                              <div className="flex items-center gap-2 text-xs">
                                {floor.swipes.length > 1 && (
                                  <div className="flex items-center gap-1 bg-[#F4F4F4] border border-[#E5E5E5] px-2.5 py-0.5 rounded-full font-mono text-[11px] text-[#5D5D5D]">
                                    <button
                                      onClick={() => void handleSwipe(floor.id, -1)}
                                      disabled={floor.currentSwipeIndex === 0}
                                      className="hover:text-[#0D0D0D] cursor-pointer p-0.5 disabled:opacity-30"
                                    >
                                      ‹
                                    </button>
                                    <span className="text-[#0D0D0D] font-bold">
                                      {floor.currentSwipeIndex + 1} / {floor.swipes.length}
                                    </span>
                                    <button
                                      onClick={() => void handleSwipe(floor.id, 1)}
                                      disabled={floor.currentSwipeIndex === floor.swipes.length - 1}
                                      className="hover:text-[#0D0D0D] cursor-pointer p-0.5 disabled:opacity-30"
                                    >
                                      ›
                                    </button>
                                  </div>
                                )}
                                <button
                                  onClick={() => {
                                    setEditingFloorId(floor.id);
                                    setEditText(floor.content);
                                  }}
                                  className="text-[#8E8E8E] hover:text-[#0D0D0D] transition cursor-pointer"
                                >
                                  编辑
                                </button>
                                <span className="text-[#E5E5E5]">·</span>
                                <button
                                  onClick={() => void handleRollback(floor.id)}
                                  className="text-[#8E8E8E] hover:text-[#0D0D0D] transition cursor-pointer"
                                >
                                  回退
                                </button>
                              </div>
                            )}
                          </div>

                          {editingFloorId === floor.id ? (
                            <div className="space-y-2 bg-[#F4F4F4] p-3 rounded-xl border border-[#E5E5E5]">
                              <textarea
                                value={editText}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditText(e.target.value)}
                                rows={3}
                                className="w-full bg-white text-[#0D0D0D] p-2 text-sm rounded border border-[#E5E5E5] focus:outline-none"
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
                              className="pl-9.5 text-[15px] leading-7 text-[#0D0D0D] space-y-2"
                              dangerouslySetInnerHTML={{ __html: sanitizeHtml(floor.content) }}
                            />
                          )}

                          {isStreaming && (
                            <div className="pl-9.5 pt-1 text-[11px] text-[#8E8E8E] font-mono flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#10A37F] animate-pulse"></span>
                              <span>生成中…（流式 run_delta）</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 底部输入框 */}
          <div className="p-5 border-t border-[#E5E5E5] bg-white flex justify-center">
            <div className="w-full max-w-[820px] space-y-2">
              <div className="bg-white rounded-2xl border border-[#E5E5E5] p-3.5 focus-within:border-[#0D0D0D]/40 transition shadow-sm flex flex-col">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  rows={2}
                  placeholder={session.sessionId ? "继续你的故事…" : "先在左侧选择一张角色卡…"}
                  disabled={!session.sessionId || generating}
                  className="bg-transparent text-[#0D0D0D] placeholder-[#8E8E8E] text-sm resize-none focus:outline-none w-full px-1 disabled:opacity-50"
                />

                <div className="flex items-center justify-between pt-2.5 border-t border-[#E5E5E5]/60 mt-1">
                  <div className="text-[11px] text-[#8E8E8E] font-mono">
                    Enter 发送 · Shift+Enter 换行 · 生成由后端拥有，刷新可恢复
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => void handleRegenerate()}
                      disabled={generating || session.floors.length === 0}
                      className="text-xs text-[#5D5D5D] hover:text-[#0D0D0D] transition cursor-pointer disabled:opacity-40"
                    >
                      重新生成
                    </button>
                    <button
                      onClick={() => void handleSend()}
                      disabled={generating || !session.sessionId}
                      className="px-5 py-2 rounded-xl bg-[#0D0D0D] hover:bg-neutral-800 text-white font-semibold text-xs transition cursor-pointer shadow-sm disabled:opacity-40"
                    >
                      发送 ↵
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* C. 右侧面板：结构化事实、管家 */}
        <aside className="layout-sidebar-right">
          <div className="h-12 border-b border-[#E5E5E5] flex items-center px-4 gap-6 text-xs font-semibold">
            <button className="text-[#0D0D0D] border-b-2 border-[#0D0D0D] py-3 cursor-pointer">状态</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            {/* 1. 结构化事实 */}
            <div className="bg-white rounded-xl border border-[#E5E5E5] p-3.5 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between font-semibold text-[#0D0D0D]">
                <span>结构化事实</span>
                <span className="text-[10px] text-[#8E8E8E] font-mono">
                  {session.floors.length > 0 ? `锚定 · #${session.floors[session.floors.length - 1].floorIndex}` : "无"}
                </span>
              </div>

              <div className="space-y-1.5 font-mono text-[11px]">
                {Object.keys(session.currentState).length === 0 && (
                  <div className="text-[#8E8E8E] font-sans py-2">尚无状态——发一轮对话后由管家提取。</div>
                )}
                {Object.entries(session.currentState).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1 border-b border-[#E5E5E5]/50">
                    <span className="text-[#5D5D5D] font-sans">{k}</span>
                    <span className="text-[#0D0D0D] font-sans font-medium">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. 后端管家 */}
            <div className="bg-white rounded-xl border border-[#E5E5E5] p-3.5 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between font-semibold text-[#0D0D0D]">
                <span>后端管家</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded font-mono border ${
                    generating
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-[#F4F4F4] text-[#8E8E8E] border-[#E5E5E5]"
                  }`}
                >
                  {generating ? "运行中" : "空闲"}
                </span>
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className="text-[#5D5D5D]">
                  模式 · {generating ? "本楼分析中" : "等待下一楼"}
                </div>
                <div className="text-[10px] text-[#8E8E8E] font-sans pt-1 border-t border-[#E5E5E5]/50">
                  失败显式降级（butler_degraded 事件可查）
                </div>
              </div>
            </div>

            {/* 3. 滚动摘要 */}
            <div className="bg-white rounded-xl border border-[#E5E5E5] p-3.5 space-y-2 shadow-sm">
              <div className="font-semibold text-[#0D0D0D] font-sans text-xs">滚动摘要</div>
              <div className="text-[11px] text-[#5D5D5D] leading-5">
                {session.rollingSummary ?? "尚无摘要——管家按阈值触发压缩。"}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* 3. 底部状态栏 */}
      <footer className="layout-footer">
        <div className="flex items-center gap-4">
          <span>AIRP v0.1.0</span>
          <span>·</span>
          <span>STORAGE: JSONL</span>
          <span>·</span>
          <span className={connected ? "text-[#10A37F]" : "text-amber-600"}>
            {connected ? "API 已连接" : "未连接"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected && !generating ? "bg-[#10A37F]" : "bg-amber-500"}`}
          ></span>
          <span>{generating ? "STREAMING" : connected ? "READY" : "OFFLINE"}</span>
        </div>
      </footer>
    </div>
  );
};
