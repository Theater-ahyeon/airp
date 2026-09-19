// tests/core/regex-pipeline.test.ts
import { describe, it, expect } from "vitest";
import { RegexPipeline, parseStRegex, type StRegexScript } from "../../src/core/pipeline/regex-pipeline.js";

describe("Stage 5 Core / P2: RegexPipeline", () => {
  it("解析 /pattern/flags 正则表达式及字面量", () => {
    const reg1 = parseStRegex("/<status>([\\s\\S]*?)<\\/status>/gi");
    expect(reg1).not.toBeNull();
    expect(reg1?.test("<STATUS>ok</status>")).toBe(true);

    const reg2 = parseStRegex("foo");
    expect(reg2).not.toBeNull();
    expect(reg2?.test("foobar")).toBe(true);
  });

  it("双侧分离：display 侧生效而 prompt 侧跳过（markdownOnly: true）", () => {
    const scripts: StRegexScript[] = [
      {
        findRegex: "<StatusPlaceHolderImpl/>",
        replaceString: "<div class=\"status-box\">状态已更新</div>",
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
      },
    ];

    const pipeline = new RegexPipeline(scripts);
    const rawText = "正文内容\n<StatusPlaceHolderImpl/>";

    // 1. 在 display 侧（展示给用户），状态占位符被渲染为 div
    const displayRes = pipeline.process(rawText, { side: "display", placement: 2 });
    expect(displayRes).toContain("<div class=\"status-box\">状态已更新</div>");
    expect(displayRes).not.toContain("<StatusPlaceHolderImpl/>");

    // 2. 在 prompt 侧（发给大模型），markdownOnly 规则不触发，保留原始占位符以稳定上下文
    const promptRes = pipeline.process(rawText, { side: "prompt", placement: 2 });
    expect(promptRes).toBe(rawText);
  });

  it("双侧分离：prompt 侧生效而 display 侧跳过（promptOnly: true）", () => {
    const scripts: StRegexScript[] = [
      {
        findRegex: "<think>[\\s\\S]*?<\\/think>",
        replaceString: "",
        placement: [2],
        markdownOnly: false,
        promptOnly: true,
      },
    ];

    const pipeline = new RegexPipeline(scripts);
    const rawText = "<think>思考过程</think>最终回复";

    // prompt 侧：过滤掉思考标签
    const promptRes = pipeline.process(rawText, { side: "prompt", placement: 2 });
    expect(promptRes).toBe("最终回复");

    // display 侧：不过滤，允许前端展示思考折叠块
    const displayRes = pipeline.process(rawText, { side: "display", placement: 2 });
    expect(displayRes).toBe(rawText);
  });

  it("按 placement（1=用户，2=助手）区分执行范围", () => {
    const scripts: StRegexScript[] = [
      {
        findRegex: "敏感词",
        replaceString: "和谐",
        placement: [1], // 仅作用于用户输入
        markdownOnly: false,
        promptOnly: false,
      },
    ];

    const pipeline = new RegexPipeline(scripts);

    // 用户输入（placement 1）触发替换
    const userRes = pipeline.process("包含敏感词", { side: "display", placement: 1 });
    expect(userRes).toBe("包含和谐");

    // 助手回复（placement 2）不触发
    const botRes = pipeline.process("包含敏感词", { side: "display", placement: 2 });
    expect(botRes).toBe("包含敏感词");
  });

  it("trimStrings 修剪支持", () => {
    const scripts: StRegexScript[] = [
      {
        findRegex: "```json\\s*([\\s\\S]*?)\\s*```",
        replaceString: "$1",
        trimStrings: ["\r\n"],
        placement: [2],
      },
    ];

    const pipeline = new RegexPipeline(scripts);
    const res = pipeline.process("```json\r\n{\"hp\": 100}\r\n```", { side: "display", placement: 2 });
    expect(res).toBe("{\"hp\": 100}");
  });
});
