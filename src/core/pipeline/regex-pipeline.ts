// src/core/pipeline/regex-pipeline.ts
// SillyTavern 角色内嵌正则脚本（extensions.regex_scripts）渲染管线。
// clean-room 实现：根据卡库真实卡片普查确证的规则进行解析与应用。
// 字段语义：
//   - findRegex: 正则表达式字符串，支持字面量（带或不带 /.../flags）
//   - replaceString: 替换模板，支持捕获组 $1, $2 等
//   - trimStrings: 匹配后额外需要修剪剥离的前后置字符串
//   - placement: 适用位置，1 = 用户输入 / 2 = AI 输出 / 3 = 快捷指令等
//   - disabled: 是否禁用
//   - markdownOnly: 仅在前端展示侧生效（Display 侧）
//   - promptOnly: 仅在组装发送给模型的 Prompt 侧生效（Prompt 侧）
//   - runOnEdit: 编辑时是否触发
//   - minDepth / maxDepth: 作用楼层深度范围约束

export interface StRegexScript {
  id?: string;
  scriptName?: string;
  findRegex: string;
  replaceString: string;
  trimStrings?: string[];
  placement?: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  substituteRegex?: number;
  minDepth?: number | null;
  maxDepth?: number | null;
}

export type RegexTargetSide = "display" | "prompt";

export interface RegexPipelineOptions {
  /** 当前渲染侧：display（UI展示）或 prompt（上下文组装）。 */
  side: RegexTargetSide;
  /** 楼层位置：1 = 用户消息 / 2 = AI助手回复。 */
  placement: number;
  /** 相对当前对话末尾的楼层深度（可选，用于 minDepth/maxDepth 过滤）。 */
  depth?: number;
}

/**
 * 将 ST 的 findRegex 字符串解析为 RegExp 实例。
 * 支持形如 "/pattern/flags" 或普通纯文本模式。
 */
export function parseStRegex(patternStr: string): RegExp | null {
  if (!patternStr || typeof patternStr !== "string") return null;

  try {
    const match = patternStr.match(/^\/(.*)\/([a-z]*)$/s);
    if (match) {
      const [, body, flags] = match;
      return new RegExp(body, flags);
    }
    // 普通字符串模式，默认全局匹配
    return new RegExp(patternStr, "g");
  } catch {
    return null;
  }
}

/**
 * 核心管线：按顺序应用符合条件的正则脚本。
 */
export class RegexPipeline {
  private readonly scripts: StRegexScript[];

  constructor(scripts: StRegexScript[] = []) {
    this.scripts = scripts.filter((s) => !s.disabled && s.findRegex);
  }

  /**
   * 判断脚本在当前上下文是否应激活。
   */
  private shouldApply(script: StRegexScript, opts: RegexPipelineOptions): boolean {
    if (script.disabled) return false;

    // 1. placement 判定：若配置了 placement 且不包含当前位置，则跳过
    if (Array.isArray(script.placement) && script.placement.length > 0) {
      if (!script.placement.includes(opts.placement)) {
        return false;
      }
    }

    // 2. 渲染侧分离（display vs prompt）
    if (opts.side === "display") {
      // display 侧：排除 promptOnly 标记的脚本
      if (script.promptOnly === true && script.markdownOnly !== true) {
        return false;
      }
    } else if (opts.side === "prompt") {
      // prompt 侧：排除 markdownOnly（且非 promptOnly）的脚本
      if (script.markdownOnly === true && script.promptOnly !== true) {
        return false;
      }
    }

    // 3. 楼层深度过滤
    if (typeof opts.depth === "number") {
      if (typeof script.minDepth === "number" && script.minDepth !== null && opts.depth < script.minDepth) {
        return false;
      }
      if (typeof script.maxDepth === "number" && script.maxDepth !== null && opts.depth > script.maxDepth) {
        return false;
      }
    }

    return true;
  }

  /**
   * 对输入文本执行全部命中规则的替换。
   */
  process(text: string, opts: RegexPipelineOptions): string {
    if (!text || typeof text !== "string") return "";

    let result = text;

    for (const script of this.scripts) {
      if (!this.shouldApply(script, opts)) continue;

      const regex = parseStRegex(script.findRegex);
      if (!regex) continue;

      try {
        result = result.replace(regex, script.replaceString ?? "");

        // 处理 trimStrings 修剪
        if (Array.isArray(script.trimStrings) && script.trimStrings.length > 0) {
          for (const trimStr of script.trimStrings) {
            if (trimStr) {
              result = result.split(trimStr).join("");
            }
          }
        }
      } catch {
        // 容错：单个脚本执行异常不中断后续脚本
      }
    }

    return result;
  }
}
