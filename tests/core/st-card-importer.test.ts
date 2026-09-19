// tests/core/st-card-importer.test.ts
import { describe, it, expect } from "vitest";
import { importSillyTavernV2Card } from "../../src/core/importers/st-card-importer.js";

describe("Stage 5 Core: SillyTavern V2 Spec Card Importer", () => {
  it("无损导入标准 SillyTavern V2 角色卡（含世界书条目与备用开场白）", () => {
    const stCardFixture = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "汐 · 雾港灯语",
        description: "守灯人，负责指引夜潮中的归航船只。",
        personality: "冷静、警惕、内敛、守口如瓶",
        scenario: "深夜海边灯塔下的旧酒馆",
        first_mes: "夜潮拍打着黑礁，汐推来了一盏防风灯。",
        mes_example: "<START>\n汐: “海水漫不过第七级台阶。”",
        system_prompt: "遵循沉浸式严肃叙事小说风格，切忌出戏。",
        post_history_instructions: "根据当前好感度决定是否透露地下封印线索。",
        tags: ["奇幻", "悬疑", "灯塔"],
        creator_notes: "AIRP 官方 First Playable 验证用卡",
        alternate_greetings: ["暴风雨呼啸，汐递给你一杯热朗姆酒。"],
        character_book: {
          name: "雾港世界书",
          entries: [
            {
              keys: ["潮汐罗盘", "罗盘"],
              content: "指引迷雾之海生路的唯一古老航海器具。",
              enabled: true,
              insertion_order: 100,
            },
            {
              keys: ["黑礁", "灯塔"],
              content: "灯塔建于黑礁之上，午夜潮涨时会淹没前六级台阶。",
              enabled: true,
              insertion_order: 50,
            },
          ],
        },
      },
    };

    const imported = importSillyTavernV2Card(stCardFixture);

    expect(imported.attributes.name).toBe("汐 · 雾港灯语");
    expect(imported.attributes.description).toContain("守灯人");
    expect(imported.attributes.personality).toBe("冷静、警惕、内敛、守口如瓶");
    expect(imported.attributes.systemPrompt).toContain("遵循沉浸式严肃叙事小说风格");
    expect(imported.attributes.tags).toEqual(["奇幻", "悬疑", "灯塔"]);
    expect(imported.alternateGreetings).toHaveLength(1);
    expect(imported.alternateGreetings[0]).toContain("热朗姆酒");
    expect(imported.worldbookEntries).toHaveLength(2);
    expect(imported.worldbookEntries[0].keys).toContain("潮汐罗盘");
  });
  it("异常容错：根对象非法或缺少 name 时显式报错拒绝", () => {
    expect(() => importSillyTavernV2Card(null)).toThrowError();
    expect(() => importSillyTavernV2Card({})).toThrowError("missing required 'name'");
  });

  it("P1 导入保全：生成兼容报告且覆盖全部字段状态", () => {
    const stCardWithExt = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "测试角色",
        description: "测试描述",
        personality: "测试性格",
        first_mes: "测试开场白",
        creator: "测试作者",
        character_version: "1.0.0",
        extensions: {
          regex_scripts: [
            { id: "s1", scriptName: "StatusBlock", findRegex: "<status>", replaceString: "<div>" }
          ],
          tavern_helper: { version: "1.0" }
        },
        character_book: {
          name: "测试书",
          entries: [
            {
              keys: ["测试主键"],
              secondary_keys: ["测试副键"],
              content: "测试条目内容",
              enabled: true,
              selective: true,
              selectiveLogic: 0,
              extensions: {
                scan_depth: 4,
                probability: 100
              }
            }
          ]
        }
      }
    };

    const imported = importSillyTavernV2Card(stCardWithExt);
    expect(imported.compatReport).toBeDefined();
    expect(imported.compatReport.spec).toBe("chara_card_v2");
    expect(imported.compatReport.stats.supported).toBeGreaterThan(0);
    expect(imported.compatReport.stats.preserved).toBeGreaterThan(0);

    // 检查是否有 extensions 的 preserved 标注
    const extStatus = imported.compatReport.fields.find((f) => f.path === "data.extensions");
    expect(extStatus).toBeDefined();
    expect(extStatus?.status).toBe("preserved");

    // 检查世界书条目 extensions 属性的正确解析
    expect(imported.worldbookEntries[0].secondaryKeys).toEqual(["测试副键"]);
    expect(imported.worldbookEntries[0].secondaryLogic).toBe("AND_ANY");
    expect(imported.worldbookEntries[0].scanDepth).toBe(4);
  });
});
