// src/core/pipeline/ejs-lite.ts
// EJS-lite 安全子集求值器（clean-room 实现，零外部依赖）。
// 对应提案 L-A: 仅支持变量安全访问、三元表达式、条件判断子集，解析失败返回诊断态。
// 防御代码注入：绝不使用 eval() 或 new Function() 执行任意 JS。

export interface EjsContext {
  /** 当前状态变量，如 stat_data.主角.声望 */
  variables?: Record<string, unknown>;
  /** 用户名 */
  user?: string;
  /** 角色名 */
  char?: string;
  [key: string]: unknown;
}

/**
 * 递归根据 "a.b.c" 路径获取嵌套对象的值。
 */
export function getPathValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object" || !path) return undefined;
  const parts = path.split(".").map((p) => p.trim());
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 安全解析类似 getvar('stat_data.xxx', { defaults: ... }) 或直接属性访问。
 */
function resolveVarExpression(expr: string, context: EjsContext): unknown {
  const trimmed = expr.trim();

  // 匹配 getvar('path') 或 getvar('path', { defaults: val })
  const getvarMatch = trimmed.match(/^get(?:Message)?Var\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*\{\s*defaults:\s*([^}]+)\s*\})?\s*\)$/i);
  if (getvarMatch) {
    const [, path, defaultRaw] = getvarMatch;
    const val = getPathValue(context.variables ?? context, path);
    if (val !== undefined) return val;
    if (defaultRaw !== undefined) {
      const d = defaultRaw.trim();
      if (d === "true") return true;
      if (d === "false") return false;
      if (d === "null") return null;
      if (!isNaN(Number(d))) return Number(d);
      if ((d.startsWith("'") && d.endsWith("'")) || (d.startsWith('"') && d.endsWith('"'))) {
        return d.slice(1, -1);
      }
    }
    return undefined;
  }

  // 直接变量路径访问
  const directVal = getPathValue(context.variables ?? context, trimmed);
  if (directVal !== undefined) return directVal;

  return undefined;
}

/**
 * 安全 EJS-lite 渲染：
 *  - <%= expression %> 或 <%- expression %>: 变量输出
 *  - <% if (cond) { %> ... <% } %>: 安全条件分支
 *  - <%# comment %>: 注释移除
 *  - {{format_message_variable::path}} / {{get_message_variable::path}}: MVU 宏替换
 */
export function renderEjsLite(template: string, context: EjsContext = {}): string {
  if (!template || typeof template !== "string") return "";

  let result = template;

  // 1. 处理 ST/MVU 宏替换：{{format_message_variable::path}}
  result = result.replace(/\{\{(?:format|get)_message_variable::([^}]+)\}\}/g, (_, path) => {
    const val = getPathValue(context.variables ?? context, path.trim());
    if (val === undefined || val === null) return "";
    if (typeof val === "object") return JSON.stringify(val, null, 2);
    return String(val);
  });

  // 2. 移除 EJS 注释 <%# ... %> 和纯控制逻辑声明 <%_ ... _%>
  result = result.replace(/<%#[\s\S]*?%>/g, "");
  result = result.replace(/<%_[^=][\s\S]*?_%>/g, "");

  // 3. 处理 EJS 条件判断：<% if (condition) { %> content <% } %>
  result = result.replace(/<%\s*if\s*\(([^)]+)\)\s*\{\s*%>(.*?)<%\s*\}\s*%>/gs, (_, cond, body) => {
    const val = resolveVarExpression(cond, context);
    // 判断真值
    if (Boolean(val)) {
      return body;
    }
    return "";
  });

  // 4. 处理 EJS 输出：<%= expr %> 或 <%- expr %> 或 <%_ ... = expr %>
  result = result.replace(/<%[=-_]?\s*([a-zA-Z0-9_.'"\s\(\):]+?)\s*_?%>/g, (_, expr) => {
    const val = resolveVarExpression(expr, context);
    if (val === undefined || val === null) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });

  return result;
}
