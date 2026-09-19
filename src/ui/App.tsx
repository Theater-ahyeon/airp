// src/ui/App.tsx
// Complete production React component implementing 100% PDF layout with ChatGPT minimal white palette.

import React, { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Compass,
  DownloadCloud,
  BookOpen,
  Sliders,
  Regex,
  Code,
  FileText,
  Undo2,
  ChevronLeft,
  ChevronRight,
  Send,
  Coins,
  Cpu,
  RotateCw,
} from "lucide-react";
import { ChatFloor, SessionState } from "./types.js";
import { sanitizeHtml } from "./sanitize.js";

const INITIAL_SESSION: SessionState = {
  cardId: "card_xi",
  cardName: "汐",
  cardSubtitle: "汐 · 雾港灯语",
  sessionId: "sess_main",
  sessionTitle: "雾港灯语 · 与汐的第三夜",
  sessionBranch: "主线/B2",
  cacheHitRate: 94.8,
  inputTokens: 9210,
  outputTokens: 2104,
  cachedTokens: 8730,
  estimatedCost: "¥0.31",
  butlerStatus: "running",
  undoCheckpointAvailable: true,
  summaryCoverage: "#1,100 至 #1,240 (已压缩为 312 tok)",
  rollingSummary:
    "夜潮拍打灯塔第三级台阶，旅行者向汐询问地下二层的古老封印。汐出示了生锈的铜钥匙，并警告午夜涨潮前必须返航。",
  currentState: {
    "地点": "雾港 · 灯塔酒馆",
    "时刻": "第三夜 · 雨",
    "汐 · 好感": "47 (+2)",
    "持有物": "铜钥匙 · 满声贝壳",
    "当前目标": "找到潮汐罗盘",
  },
  floors: [
    {
      id: "f_1281",
      floorIndex: 1281,
      role: "assistant",
      content:
        "夜潮拍打着灯塔底座的黑礁，潮水泛起冰冷的白沫。<br><br>汐将一盏铜制防风灯推到木桌中央，灯芯爆出微小的毕剥声。她没有立刻回答你关于潮汐罗盘的问题，而是伸手抚过满是盐渍的航海图，目光沉静得像暴风雨前的海面。",
      swipes: [
        "夜潮拍打着灯塔底座的黑礁，潮水泛起冰冷的白沫。<br><br>汐将一盏铜制防风灯推到木桌中央，灯芯爆出微小的毕剥声。她没有立刻回答你关于潮汐罗盘的问题，而是伸手抚过满是盐渍的航海图，目光沉静得像暴风雨前的海面。",
        "窗外海浪呼啸。汐拨了拨灯芯，淡然道：“罗盘在地下二层，但你现在下不去。”",
        "汐抬头打量着你：“今晚的浪太急了，你真的打算在这个时候启程吗？”",
      ],
      currentSwipeIndex: 0,
      createdAt: Date.now() - 120000,
      tokens: 48,
    },
    {
      id: "f_1282",
      floorIndex: 1282,
      role: "user",
      content: "“既然枢密院封锁了灯塔的地下暗室，你为什么还要留在这里？今晚的浪已经漫过第三级台阶了。”",
      swipes: ["“既然枢密院封锁了灯塔的地下暗室，你为什么还要留在这里？今晚的浪已经漫过第三级台阶了。”"],
      currentSwipeIndex: 0,
      createdAt: Date.now() - 60000,
      tokens: 28,
    },
    {
      id: "f_1284",
      floorIndex: 1284,
      role: "assistant",
      content:
        "“因为除了我，没人知道这盏灯该怎么亮着。”<br><br>她从围裙口袋里摸出一枚生锈的铜钥匙，轻轻按在桌角的潮汐刻度线上。金属与湿润木板碰撞发出沉闷的轻响。“海水漫不过第七级台阶，至少在午夜之前不会。拿上它，往地下二层走。”",
      swipes: [
        "“因为除了我，没人知道这盏灯该怎么亮着。”<br><br>她从围裙口袋里摸出一枚生锈的铜钥匙，轻轻按在桌角的潮汐刻度线上。金属与湿润木板碰撞发出沉闷的轻响。“海水漫不过第七级台阶，至少在午夜之前不会。拿上它，往地下二层走。”",
      ],
      currentSwipeIndex: 0,
      createdAt: Date.now(),
      tokens: 56,
      stateDeltas: [{ key: "汐 · 好感", value: "+2" }],
    },
  ],
};

export const App: React.FC = () => {
  const [session, setSession] = useState<SessionState>(INITIAL_SESSION);
  const [inputText, setInputText] = useState("");
  const [editingFloorId, setEditingFloorId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: session.floors.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  });

  const handleSend = () => {
    if (!inputText.trim()) return;
    const newFloor: ChatFloor = {
      id: `f_${Date.now()}`,
      floorIndex: session.floors.length + 1284,
      role: "user",
      content: inputText,
      swipes: [inputText],
      currentSwipeIndex: 0,
      createdAt: Date.now(),
      tokens: Math.ceil(inputText.length * 0.8),
    };
    setSession((prev) => ({
      ...prev,
      floors: [...prev.floors, newFloor],
      undoCheckpointAvailable: false,
    }));
    setInputText("");
  };

  const handleSwipe = (floorId: string, delta: number) => {
    setSession((prev) => ({
      ...prev,
      floors: prev.floors.map((fl) => {
        if (fl.id !== floorId) return fl;
        const nextIdx = fl.currentSwipeIndex + delta;
        if (nextIdx < 0 || nextIdx >= fl.swipes.length) return fl;
        return {
          ...fl,
          currentSwipeIndex: nextIdx,
          content: fl.swipes[nextIdx],
        };
      }),
    }));
  };

  const handleRollback = (floorIndex: number) => {
    setSession((prev) => ({
      ...prev,
      floors: prev.floors.filter((f) => f.floorIndex <= floorIndex),
      undoCheckpointAvailable: true,
    }));
  };

  const handleUndoRollback = () => {
    setSession(INITIAL_SESSION);
  };

  const saveEdit = (floorId: string) => {
    setSession((prev) => ({
      ...prev,
      floors: prev.floors.map((fl) => {
        if (fl.id !== floorId) return fl;
        const updatedSwipes = [...fl.swipes];
        updatedSwipes[fl.currentSwipeIndex] = editText;
        return {
          ...fl,
          content: editText,
          swipes: updatedSwipes,
        };
      }),
    }));
    setEditingFloorId(null);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-cg-bgMain text-cg-txtMain overflow-hidden select-none text-[13px]">
      {/* 1. 顶部导航栏 (48px) - 纯正 PDF 结构 */}
      <header className="h-12 border-b border-cg-borderSubtle bg-cg-bgMain px-5 flex items-center justify-between shrink-0 z-40 text-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-widest text-cg-txtMain">AIRP</span>
            <span className="text-[11px] text-cg-txtDim tracking-tight">酒馆生态的记忆引擎</span>
          </div>
          <span className="text-cg-borderSubtle">|</span>
          <div className="flex items-center gap-1.5 font-medium text-cg-txtMain">
            <Compass className="w-3.5 h-3.5 text-cg-accentBlue" />
            <span>{session.cardSubtitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-[11px] font-mono">
          <div className="flex items-center gap-1.5 text-cg-txtMuted">
            <span className="w-1.5 h-1.5 rounded-full bg-cg-statusGreen animate-pulse"></span>
            <span className="font-sans">OpenAI 兼容 · 已连接</span>
          </div>
          <span className="text-cg-borderSubtle">/</span>
          <div className="text-cg-txtMuted">
            <span>{session.inputTokens + session.outputTokens} tok</span>
            <span className="text-cg-borderSubtle ml-1">·</span>
            <span className="font-semibold text-cg-txtMain ml-1">{session.estimatedCost}</span>
          </div>
          <span className="text-cg-borderSubtle">/</span>
          <button className="text-cg-txtMuted hover:text-cg-txtMain transition cursor-pointer p-1" title="刷新状态">
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* 2. 主体三栏布局 (左: 270px, 中: 1fr, 右: 310px) */}
      <div className="flex-1 flex overflow-hidden">
        {/* A. 左侧边栏 (角色卡、会话分支、生态资产、脱敏导出) */}
        <aside className="w-[270px] border-r border-cg-borderSubtle bg-cg-bgSidebar flex flex-col shrink-0">
          <div className="p-3.5 border-b border-cg-borderSubtle flex items-center justify-between">
            <span className="text-xs font-semibold text-cg-txtMuted">角色卡</span>
            <button className="text-xs text-cg-accentBlue hover:underline flex items-center gap-1 cursor-pointer transition font-medium">
              <DownloadCloud className="w-3.5 h-3.5" /> 导入 ST 卡
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            <div className="p-3 rounded-xl bg-white border border-black/20 shadow-sm cursor-pointer space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg overflow-hidden bg-cg-bgCardSubtle border border-cg-borderSubtle flex items-center justify-center font-bold text-slate-700 text-sm shrink-0">
                  {session.cardName}
                </div>
                <div className="flex-1 overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-cg-txtMain truncate">{session.cardSubtitle}</span>
                    <span className="text-[9px] bg-black text-white px-1.5 py-0.2 rounded font-medium">工作坊</span>
                  </div>
                  <div className="text-[11px] text-cg-txtDim font-mono mt-0.5">1,284 楼 · 守灯人</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 pt-1 text-[10px]">
                <span className="bg-cg-bgCardSubtle text-cg-txtMuted border border-cg-borderSubtle px-1.5 py-0.5 rounded">
                  世界书 ×3
                </span>
                <span className="bg-cg-bgCardSubtle text-cg-txtMuted border border-cg-borderSubtle px-1.5 py-0.5 rounded truncate">
                  预设 · 雾港夜话
                </span>
              </div>
            </div>

            <div className="pt-4 space-y-1">
              <div className="text-[11px] font-semibold text-cg-txtDim px-2 py-1 uppercase tracking-wider">生态资产</div>
              <div className="p-2 rounded-lg hover:bg-white text-cg-txtMuted hover:text-cg-txtMain text-xs flex items-center justify-between cursor-pointer transition">
                <span className="flex items-center gap-2">
                  <BookOpen className="w-3.5 h-3.5 text-cg-accentBlue" /> 世界书 · 双模检索
                </span>
                <span className="text-[10px] font-mono text-cg-txtDim">3 条目</span>
              </div>
              <div className="p-2 rounded-lg hover:bg-white text-cg-txtMuted hover:text-cg-txtMain text-xs flex items-center justify-between cursor-pointer transition">
                <span className="flex items-center gap-2">
                  <Sliders className="w-3.5 h-3.5 text-cg-txtDim" /> 预设转译
                </span>
                <span className="text-[10px] font-mono text-cg-txtDim">2</span>
              </div>
              <div className="p-2 rounded-lg hover:bg-white text-cg-txtMuted hover:text-cg-txtMain text-xs flex items-center justify-between cursor-pointer transition">
                <span className="flex items-center gap-2">
                  <Regex className="w-3.5 h-3.5 text-cg-txtDim" /> 正则脚本
                </span>
                <span className="text-[10px] font-mono text-cg-txtDim">4 规则</span>
              </div>
              <div className="p-2 rounded-lg hover:bg-white text-cg-txtMuted hover:text-cg-txtMain text-xs flex items-center justify-between cursor-pointer transition">
                <span className="flex items-center gap-2">
                  <Code className="w-3.5 h-3.5 text-cg-txtDim" /> 宏 / STScript
                </span>
                <span className="text-[10px] font-mono text-cg-txtDim">纯函数子集</span>
              </div>
            </div>
          </div>

          <div className="p-3 border-t border-cg-borderSubtle bg-cg-bgSidebar space-y-1 text-center">
            <button className="w-full py-2 bg-white hover:bg-slate-50 border border-cg-borderSubtle text-cg-txtMain rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition cursor-pointer shadow-sm">
              <FileText className="w-3.5 h-3.5 text-cg-txtMuted" /> 导出调试日志
            </button>
            <span className="text-[10px] text-cg-txtDim">导出含隐私脱敏提示</span>
          </div>
        </aside>

        {/* B. 中央聊天主区 (万楼虚拟化) */}
        <main className="flex-1 flex flex-col bg-cg-bgMain overflow-hidden">
          <div className="h-12 border-b border-cg-borderSubtle bg-white px-6 flex items-center justify-between shrink-0 text-xs">
            <div className="space-y-0.5">
              <div className="font-bold text-cg-txtMain text-xs flex items-center gap-2">
                <span>{session.sessionTitle}</span>
              </div>
              <div className="text-[10px] text-cg-txtDim flex items-center gap-1.5">
                <span>分支 {session.sessionBranch}</span>
                <span>·</span>
                <span>事件潮汐已持久化</span>
              </div>
            </div>

            <div className="flex items-center gap-3 font-mono">
              {session.undoCheckpointAvailable && (
                <button
                  onClick={handleUndoRollback}
                  className="px-2.5 py-1 text-[11px] rounded-lg bg-cg-amberBadgeBg border border-amber-300 hover:bg-amber-100 text-cg-amberBadge flex items-center gap-1 cursor-pointer transition font-medium"
                >
                  <Undo2 className="w-3 h-3" /> 撤销回退
                </button>
              )}
              <span className="text-cg-borderSubtle">/</span>
              <span className="text-cg-txtMuted font-bold">#1,284 / 1,284</span>
            </div>
          </div>

          {/* 虚拟化楼层流 */}
          <div ref={parentRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-7 flex flex-col items-center">
            <div className="w-full max-w-[820px] space-y-7">
              <div className="flex justify-center">
                <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-cg-bgCardSubtle border border-cg-borderSubtle text-[11px] text-cg-txtMuted font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-cg-accentBlue"></span>
                  <span>滚动摘要 · {session.summaryCoverage}</span>
                </div>
              </div>

              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const floor = session.floors[virtualRow.index];
                  const isUser = floor.role === "user";

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
                          <div className="max-w-[620px] bg-cg-bgCardSubtle text-cg-txtMain p-4 rounded-2xl rounded-tr-sm border border-cg-borderSubtle/80 shadow-sm space-y-1.5">
                            <div className="flex items-center justify-between text-[11px] font-mono text-cg-txtDim border-b border-cg-borderSubtle pb-1">
                              <span className="font-sans font-semibold text-cg-txtMain flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-cg-statusGreen"></span> 旅行者 (你)
                              </span>
                              <span>#{floor.floorIndex}</span>
                            </div>
                            <p className="text-[15px] leading-7 text-cg-txtMain pt-0.5">{floor.content}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg overflow-hidden border border-cg-borderSubtle bg-cg-bgCardSubtle flex items-center justify-center font-bold text-xs text-slate-700 shrink-0">
                                {session.cardName}
                              </div>
                              <span className="font-bold text-xs text-cg-txtMain">{session.cardName}</span>
                              <span className="text-[11px] text-cg-txtDim font-mono">#{floor.floorIndex}</span>
                            </div>

                            <div className="flex items-center gap-2 text-xs">
                              {floor.swipes.length > 1 && (
                                <div className="flex items-center gap-1 bg-cg-bgCardSubtle border border-cg-borderSubtle px-2 py-0.5 rounded-full font-mono text-[11px] text-cg-txtMuted">
                                  <button
                                    onClick={() => handleSwipe(floor.id, -1)}
                                    disabled={floor.currentSwipeIndex === 0}
                                    className="hover:text-cg-txtMain cursor-pointer p-0.5 disabled:opacity-30"
                                  >
                                    <ChevronLeft className="w-3 h-3" />
                                  </button>
                                  <span className="text-cg-txtMain font-bold">
                                    {floor.currentSwipeIndex + 1} / {floor.swipes.length}
                                  </span>
                                  <button
                                    onClick={() => handleSwipe(floor.id, 1)}
                                    disabled={floor.currentSwipeIndex === floor.swipes.length - 1}
                                    className="hover:text-cg-txtMain cursor-pointer p-0.5 disabled:opacity-30"
                                  >
                                    <ChevronRight className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                              <button
                                onClick={() => {
                                  setEditingFloorId(floor.id);
                                  setEditText(floor.content);
                                }}
                                className="text-cg-txtDim hover:text-cg-txtMain transition cursor-pointer"
                              >
                                编辑
                              </button>
                              <span className="text-cg-borderSubtle">·</span>
                              <button
                                onClick={() => handleRollback(floor.floorIndex)}
                                className="text-cg-txtDim hover:text-cg-txtMain transition cursor-pointer"
                              >
                                回退
                              </button>
                            </div>
                          </div>

                          {editingFloorId === floor.id ? (
                            <div className="space-y-2 bg-cg-bgCardSubtle p-3 rounded-xl border border-cg-borderSubtle">
                              <textarea
                                value={editText}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditText(e.target.value)}
                                rows={3}
                                className="w-full bg-white text-cg-txtMain p-2 text-sm rounded border border-cg-borderSubtle focus:outline-none"
                              />
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => setEditingFloorId(null)}
                                  className="px-2 py-1 text-xs text-cg-txtDim hover:text-cg-txtMain cursor-pointer"
                                >
                                  取消
                                </button>
                                <button
                                  onClick={() => saveEdit(floor.id)}
                                  className="px-3 py-1 text-xs bg-black text-white font-semibold rounded cursor-pointer"
                                >
                                  保存
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="pl-9.5 text-[15px] leading-7 text-cg-txtMain space-y-2"
                              dangerouslySetInnerHTML={{ __html: sanitizeHtml(floor.content) }}
                            />
                          )}

                          {virtualRow.index === session.floors.length - 1 && (
                            <div className="pl-9.5 pt-1 text-[11px] text-cg-txtDim font-mono flex items-center gap-1.5">
                              <Cpu className="w-3.5 h-3.5 text-cg-txtDim" />
                              <span>管家排队中 · 等待本楼完成后更新状态（一致性协议）</span>
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

          {/* 底部输入框与发射器 */}
          <div className="p-5 border-t border-cg-borderSubtle bg-white flex justify-center">
            <div className="w-full max-w-[820px] space-y-2">
              <div className="bg-white rounded-2xl border border-cg-borderSubtle p-3.5 focus-within:border-black/30 transition shadow-sm flex flex-col">
                <textarea
                  value={inputText}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInputText(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={2}
                  placeholder="继续你的故事…"
                  className="bg-transparent text-cg-txtMain placeholder-cg-txtDim text-sm resize-none focus:outline-none w-full px-1"
                />

                <div className="flex items-center justify-between pt-2.5 border-t border-cg-borderSubtle/60 mt-1">
                  <div className="text-[11px] text-cg-txtDim font-mono">
                    Enter 发送 · Shift+Enter 换行 · 生成由后端拥有，刷新可恢复
                  </div>

                  <div className="flex items-center gap-3">
                    <button className="text-xs text-cg-txtMuted hover:text-cg-txtMain transition cursor-pointer">
                      重新生成
                    </button>
                    <button
                      onClick={handleSend}
                      className="px-5 py-2 rounded-xl bg-black hover:bg-neutral-800 text-white font-semibold text-xs transition cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <span>发送</span> <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* C. 右侧面板 (310px 常驻：结构化事实、管家、时间线、Token账本) */}
        <aside className="w-[310px] border-l border-cg-borderSubtle bg-cg-bgSidebar flex flex-col shrink-0">
          <div className="h-12 border-b border-cg-borderSubtle flex items-center px-4 gap-6 text-xs font-semibold">
            <button className="text-cg-txtMain border-b-2 border-black py-3 cursor-pointer">状态</button>
            <button className="text-cg-txtDim hover:text-cg-txtMuted py-3 cursor-pointer transition">时间线</button>
            <button className="text-cg-txtDim hover:text-cg-txtMuted py-3 cursor-pointer transition">记忆</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            <div className="bg-white rounded-xl border border-cg-borderSubtle p-3.5 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between font-semibold text-cg-txtMain">
                <span>结构化事实</span>
                <span className="text-[10px] text-cg-txtDim font-mono">锚定 · #1,284</span>
              </div>

              <div className="space-y-1.5 font-mono text-[11px]">
                {Object.entries(session.currentState).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1 border-b border-cg-borderSubtle/50">
                    <span className="text-cg-txtMuted font-sans">{k}</span>
                    <span className="text-cg-txtMain font-sans font-medium">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-cg-borderSubtle p-3.5 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between font-semibold text-cg-txtMain">
                <span>后端管家</span>
                <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.2 rounded font-mono">
                  运行中
                </span>
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className="text-cg-txtMuted">模式 · tool calling (阶梯降级 L1)</div>
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-cg-txtDim">滚动摘要触发阈值</span>
                    <span className="text-cg-txtMain font-bold">68%</span>
                  </div>
                  <div className="w-full bg-cg-bgCardSubtle h-1.5 rounded-full overflow-hidden border border-cg-borderSubtle">
                    <div className="bg-emerald-500 h-full w-[68%]"></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-cg-borderSubtle p-3.5 space-y-2 shadow-sm font-mono text-[11px]">
              <div className="font-semibold text-cg-txtMain font-sans">运行时间线 · Run #1284</div>
              <div className="space-y-1 text-cg-txtMuted">
                <div className="flex justify-between">
                  <span>排队 212ms</span>
                  <span className="text-cg-statusGreen font-bold">缓存命中 94%</span>
                </div>
                <div className="flex justify-between">
                  <span>生成 8.4s</span>
                  <span className="text-cg-txtMain">2,104 tok</span>
                </div>
                <div className="text-[10px] text-cg-txtDim font-sans pt-1 border-t border-cg-borderSubtle/50">
                  状态更新 · 完成 · +3 事件 · 摘要已入队
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-cg-borderSubtle p-3.5 space-y-2 shadow-sm font-mono text-[11px]">
              <div className="font-semibold text-cg-txtMain font-sans flex justify-between items-center">
                <span>本次会话成本</span>
                <Coins className="w-3.5 h-3.5 text-cg-txtMuted" />
              </div>
              <div className="space-y-1 text-cg-txtMuted">
                <div className="flex justify-between">
                  <span>tok 进 / 出</span>
                  <span className="text-cg-txtMain font-bold">
                    {session.inputTokens} / {session.outputTokens}
                  </span>
                </div>
                <div className="flex justify-between items-center pt-1 border-t border-cg-borderSubtle/50">
                  <span className="text-cg-txtDim font-sans">估算成本</span>
                  <span className="text-cg-txtMain font-bold text-xs">{session.estimatedCost}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* 3. 底部状态栏 (28px) */}
      <footer className="h-7 border-t border-cg-borderSubtle bg-cg-bgSidebar px-5 flex items-center justify-between shrink-0 text-[11px] font-mono text-cg-txtDim">
        <div className="flex items-center gap-4">
          <span>AIRP v0.1.0-alpha</span>
          <span>·</span>
          <span>STORAGE: JSONL (PATCH-FIRST)</span>
          <span>·</span>
          <span className="text-cg-statusGreen">PORT: 127.0.0.1:5173</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-cg-statusGreen"></span>
          <span>ENGINE IDLE</span>
        </div>
      </footer>
    </div>
  );
};
