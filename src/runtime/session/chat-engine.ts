// src/runtime/session/chat-engine.ts
// 会话级对话回合引擎：组装（AssemblyPipeline）→ 生成（RunManager）→ 楼层落地 → 管家提取。
// 修复审查 H-4：POST /api/runs 不再裸透传 prompt，而是走完整组装链路。

import type {
  CardStoreFacade,
  ChatEngineFacade,
  ModelStreamPort,
  RunManagerFacade,
  RunRecord,
  StartRunInput,
} from "../contracts.js";
import { AssemblyPipeline } from "../../core/pipeline/assembly-pipeline.js";
import { RegexPipeline, type StRegexScript } from "../../core/pipeline/regex-pipeline.js";
import { ButlerService } from "../../core/butler/butler.js";
import type { ButlerInspectionInput, ButlerInspectionOutput } from "../../core/butler/contracts.js";
import type { MockModelAdapter } from "../../core/adapters/mock-model.js";
import { createCharacterCard } from "../../core/types/character.js";

/** 同一会话已有进行中回合时抛出。 */
export class TurnConflictError extends Error {
  constructor(cardId: string, sessionId: string) {
    super(`A turn is already in progress for session ${cardId}/${sessionId}`);
    this.name = "TurnConflictError";
  }
}

export interface ChatEngineOptions {
  /** 上下文 token 预算，默认 32768。 */
  maxContextTokens?: number;
  /** 输出 token 预算，默认 2048。 */
  maxOutputTokens?: number;
}
interface TurnState {
  runId: string;
  userFloorId: string;
  completion: Promise<RunRecord>;
}

export class ChatEngine implements ChatEngineFacade {
  private readonly cardStore: CardStoreFacade;
  private readonly runManager: RunManagerFacade;
  private readonly modelPort: ModelStreamPort;
  private readonly pipeline = new AssemblyPipeline();
  private readonly butler: ButlerService;
  private readonly opts: Required<ChatEngineOptions>;
  /** 会话级单飞行：key = cardId:sessionId */
  private readonly activeTurns = new Map<string, TurnState>();

  constructor(
    cardStore: CardStoreFacade,
    runManager: RunManagerFacade,
    modelPort: ModelStreamPort,
    butlerRunnerModel: MockModelAdapter,
    options?: ChatEngineOptions
  ) {
    this.cardStore = cardStore;
    this.runManager = runManager;
    this.modelPort = modelPort;
    this.opts = {
      maxContextTokens: options?.maxContextTokens ?? 32768,
      maxOutputTokens: options?.maxOutputTokens ?? 2048,
    };
    this.butler = new ButlerService(
      {
        getLatestFloorState: async (cardId, sessionId) => {
          const r = await this.cardStore.replay(cardId, sessionId);
          return { ...r.state };
        },
        appendStateOps: async (cardId, sessionId, floorId, branchId, ops) => {
          for (const op of ops) {
            await this.cardStore.applyStateOp(cardId, sessionId, {
              ...op,
              floorId,
              branchId
            });
          }
        },
        updateSummary: async (cardId, sessionId, branchId, upToFloorId, summary) => {
          await this.cardStore.appendEvent(cardId, sessionId, {
            cardId,
            sessionId,
            ts: Date.now(),
            type: "summary_updated",
            payload: { branchId, summary, upToFloorId }
          });
        }
      },
      {
        run: async (_tier, prompt, systemPrompt) => {
          // 管家复用主模型端口做一次性非流式调用（done chunk 汇总全文）。
          let rawText = "";
          let usage = { input: 0, output: 0 };
          for await (const chunk of this.modelPort.stream({
            model: "butler",
            messages: [
              { role: "system", content: systemPrompt ?? "" },
              { role: "user", content: prompt }
            ],
            abortSignal: new AbortController().signal
          })) {
            if (chunk.type === "text_delta") {
              rawText += chunk.text;
            } else if (chunk.type === "done") {
              usage = {
                input: chunk.usage?.promptTokens ?? 0,
                output: chunk.usage?.completionTokens ?? 0
              };
            }
          }
          return { rawText, tokensUsed: usage };
        }
      }
    );
    // 管家降级阶梯：默认 Tier 2（JSON mode）。无 tool calling 端点时 Tier 1 永不可达，
    // 与其永久钉死不如显式声明当前能力。
    void butlerRunnerModel;
  }

  /** 暴露管家（测试与诊断用）。 */
  getButler(): ButlerService {
    return this.butler;
  }

  async startTurn(input: StartRunInput): Promise<RunRecord> {
    const key = `${input.cardId}:${input.sessionId}`;
    const existing = this.activeTurns.get(key);
    if (existing) {
      // 等待旧回合终态后再判定：若已结束则允许新回合
      const rec = await existing.completion;
      if (rec.status === "running" || rec.status === "queued") {
        throw new TurnConflictError(input.cardId, input.sessionId);
      }
      this.activeTurns.delete(key);
    }

    // 1. 追加用户楼层（会话互斥内完成 floorIndex 分配）
    const userFloor = await this.cardStore.appendFloor(input.cardId, input.sessionId, {
      role: "user",
      content: input.prompt
    });
    const userFloorId = userFloor.payload.floorId;
    // 2. 组装上下文：卡片 + 世界书 + 楼层历史 + 状态 + 摘要 + ST 原版正则
    const [card, replayRes, worldbook, stOriginal] = await Promise.all([
      this.cardStore.readCard(input.cardId),
      this.cardStore.replay(input.cardId, input.sessionId),
      this.cardStore.readWorldbook(input.cardId),
      this.cardStore.readStOriginal(input.cardId)
    ]);
    const characterCard = createCharacterCard(input.cardId, card.workingCopy);
    let floors = Object.values(replayRes.tree.floors)
      .filter((f) => f.branchId === replayRes.tree.activeBranchId)
      .sort((a, b) => a.floorIndex - b.floorIndex);

    // 若卡内含 ST 正则脚本，应用 prompt 侧正则管线（剥离状态栏占位等，稳定模型上下文）
    const regexScripts = (stOriginal as { data?: { extensions?: { regex_scripts?: StRegexScript[] } } })
      ?.data?.extensions?.regex_scripts;
    if (Array.isArray(regexScripts) && regexScripts.length > 0) {
      const promptPipeline = new RegexPipeline(regexScripts);
      floors = floors.map((f, idx) => {
        const depth = floors.length - 1 - idx;
        const placement = f.role === "user" ? 1 : 2;
        return {
          ...f,
          content: promptPipeline.process(f.content, { side: "prompt", placement, depth })
        };
      });
    }

    const assembled = this.pipeline.assemble({
      character: characterCard,
      floorHistory: floors,
      latestUserInput: input.prompt,
      worldbook: worldbook ?? undefined,
      state: replayRes.state,
      rollingSummary: replayRes.summary ?? undefined,
      maxContextTokens: input.maxContextTokens ?? this.opts.maxContextTokens,
      maxOutputTokens: input.maxOutputTokens ?? this.opts.maxOutputTokens,
      provider: "openai"
    });

    // 3. 启动 Run（messages 已含 system 前缀与历史；RunManager 不再裸发 prompt）
    const record = await this.runManager.startRun({
      ...input,
      messages: assembled.messages
    });

    const turn: TurnState = {
      runId: record.runId,
      userFloorId,
      completion: this.finalizeTurn(input.cardId, input.sessionId, record.runId)
    };
    this.activeTurns.set(key, turn);
    // 后台推进，不阻塞 202 返回
    void turn.completion.catch(() => {});
    return record;
  }

  /**
   * Run 终态后：追加助手楼层 → 管家提取（失败写显式降级事件，绝不静默）。
   */
  private async finalizeTurn(cardId: string, sessionId: string, runId: string): Promise<RunRecord> {
    let record: RunRecord | null = null;
    // 轮询等待终态（RunManager 无完成回调注册面；间隔 25ms，上限 10 分钟）
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      record = await this.runManager.getRun(runId);
      if (record && record.status !== "running" && record.status !== "queued") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!record) throw new Error(`Run vanished before completion: ${runId}`);

    const key = `${cardId}:${sessionId}`;

    if (record.status === "completed" && record.text.trim().length > 0) {
      const assistantFloor = await this.cardStore.appendFloor(cardId, sessionId, {
        role: "assistant",
        content: record.text
      });
      await this.runButlerForFloor(cardId, sessionId, assistantFloor.payload.floorId, record.text);
    }

    const turn = this.activeTurns.get(key);
    if (turn && turn.runId === runId) {
      this.activeTurns.delete(key);
    }
    return record;
  }

  /** 管家提取：成功写 butler_extracted；任何失败写 butler_degraded（显式降级，绝不静默吞掉）。 */
  private async runButlerForFloor(
    cardId: string,
    sessionId: string,
    floorId: string,
    assistantText: string
  ): Promise<void> {
    try {
      const replayRes = await this.cardStore.replay(cardId, sessionId);
      const floor = replayRes.tree.floors[floorId];
      const parentFloor = floor?.parentId ? replayRes.tree.floors[floor.parentId] : null;
      const input: ButlerInspectionInput = {
        floorId,
        userMessage: parentFloor?.content ?? "",
        assistantMessage: assistantText,
        currentState: { ...replayRes.state },
        rollingSummary: replayRes.summary
      };

      const output: ButlerInspectionOutput | null = await this.butler.scheduleFloorAnalysis(
        cardId,
        sessionId,
        replayRes.tree.activeBranchId,
        input
      );

      await this.cardStore.appendEvent(cardId, sessionId, {
        cardId,
        sessionId,
        ts: Date.now(),
        type: "butler_extracted",
        payload: {
          floorId,
          stateOpsCount: output?.stateOps?.length ?? 0,
          summaryUpdated: Boolean(output?.suggestedSummary),
          tokensUsed: output?.tokensUsed
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await this.cardStore.appendEvent(cardId, sessionId, {
          cardId,
          sessionId,
          ts: Date.now(),
          type: "butler_degraded",
          payload: { floorId, reason }
        });
      } catch {
        // 事件日志本身不可写时无法再降级记录；此处必须继续放行对话主流程
        console.error(`[butler] degradation event write failed for ${floorId}:`, reason);
      }
    }
  }
}
