// 行级过滤的纯函数实现。
//
// 与列脱敏同一个策略：把「规则 → WHERE 条件」做成不依赖存储与上下文的纯函数，单测钉死。
//
// ★ 为什么是「结构化」而不是让管理员写一段 WHERE 文本：
//   1. 把自由文本解析成 Condition AST 需要列清单上下文（dbgate-filterparser 的 parseFilter
//      在拿不到列时会退化成把裸词当成 like 的占位条件，产出错误的 AST）；
//   2. 值要拼进 SQL，自由文本意味着要自己做转义与注入防护 —— 结构化写法里列名是标识符、
//      值走 AST 的 value 节点，由 dumpSql 统一转义，没有这个问题。
//   v1 支持：列 + 比较符 + 值来源（成员字段 / 字面量），多条规则之间取 AND。
//   这已经覆盖「只能看自己租户/自己的数据」这个主场景；更复杂的表达留给后续。

// 允许在表达式里引用的成员字段
const ALLOWED_USER_FIELDS = ['id', 'login', 'name', 'email', 'tenant', 'connectUserId'];

const ALLOWED_OPERATORS = ['=', '!=', '>', '>=', '<', '<='];

const VALUE_TYPES = ['user', 'literal'];

function assertAllowedOperator(operator) {
  if (!ALLOWED_OPERATORS.includes(operator)) {
    throw new Error(`DBGM-00000 Unsupported row filter operator: ${operator}`);
  }
  return operator;
}

/** 解析规则里的值：来自成员字段或字面量 */
function resolveRowFilterValue(rule, user = {}) {
  if (rule.valueType === 'literal' || rule.value_type === 'literal') {
    return rule.value ?? rule.filter_value ?? '';
  }
  const field = rule.userField ?? rule.user_field;
  if (!field) {
    throw new Error('DBGM-00000 Row filter user field is required when the value comes from the member');
  }
  if (!ALLOWED_USER_FIELDS.includes(field)) {
    throw new Error(`DBGM-00000 Unknown row filter variable: user.${field}`);
  }
  const value = user?.[field];
  // 成员没有该字段时给 null：条件变成 `col = NULL`，匹配不到任何行（失败时收紧）
  return value === undefined || value === '' ? null : value;
}

/** 单条规则 → Condition AST 的一个二元节点 */
function buildRowFilterCondition(rule, user = {}) {
  const columnName = String(rule.column ?? rule.column_name ?? '').trim();
  if (!columnName) throw new Error('DBGM-00000 Row filter column is required');
  const operator = assertAllowedOperator(rule.operator ?? rule.filter_operator ?? '=');
  const value = resolveRowFilterValue(rule, user);
  return {
    conditionType: 'binary',
    operator,
    left: { exprType: 'column', columnName },
    right: value === null ? { exprType: 'value', value: null } : { exprType: 'value', value },
  };
}

function combineConditions(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  return { conditionType: 'and', conditions: [base, extra] };
}

/** 把存储行摊平成 [{ table, rule }]（table 为 null = 任意表） */
function buildRowFilterRules(rows) {
  const res = [];
  for (const row of rows ?? []) {
    const column = String(row.column_name ?? row.column ?? '').trim();
    if (!column) continue;
    const tables = String(row.table_names_list ?? row.table ?? '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);
    const rule = {
      column,
      operator: row.filter_operator ?? row.operator ?? '=',
      valueType: row.value_type ?? 'user',
      userField: row.user_field ?? row.userField ?? null,
      value: row.filter_value ?? row.value ?? '',
      ruleId: row.id ?? null,
    };
    if (!tables.length) res.push({ table: null, rule });
    else for (const table of tables) res.push({ table, rule });
  }
  return res;
}

function findApplicableFilters(rules, tableName) {
  const want = String(tableName ?? '').toLowerCase();
  return (rules ?? []).filter(entry => !entry.table || String(entry.table).toLowerCase() === want);
}

/**
 * 把行级过滤注入结构化的 select（sqlSelect 用的对象）。
 * 返回新的 select，不改动入参；没有命中任何规则时原样返回。
 */
function injectRowFilters(select, rules, user) {
  const pureName = select?.from?.name?.pureName;
  if (!select || !pureName || !rules?.length) return { select, applied: [] };

  const matching = findApplicableFilters(rules, pureName);
  if (!matching.length) return { select, applied: [] };

  let where = select.where;
  for (const entry of matching) {
    where = combineConditions(where, buildRowFilterCondition(entry.rule, user));
  }

  return {
    select: { ...select, where },
    applied: matching.map(entry => ({ table: entry.table ?? '*', column: entry.rule.column })),
  };
}

module.exports = {
  ALLOWED_USER_FIELDS,
  ALLOWED_OPERATORS,
  VALUE_TYPES,
  resolveRowFilterValue,
  buildRowFilterCondition,
  combineConditions,
  buildRowFilterRules,
  findApplicableFilters,
  injectRowFilters,
};
