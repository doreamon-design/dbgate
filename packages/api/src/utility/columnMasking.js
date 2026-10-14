// 列级脱敏/隐藏的纯函数实现。
//
// 放在 API 侧（parent 与 child 都能 require），不依赖任何存储或请求上下文，
// 这样它可以被单测钉死，也能在结果管线的任何一层复用。
//
// 判定规则：一条规则 = { table, column, mode }
//   - column 必填（忽略大小写）
//   - table 为 null/空 = 匹配任意来源表
//   - 同一列被多条规则命中时，后面的覆盖前面的（与库/对象规则一致）
//   - 结果列优先用 sourceColumnName（真实来源列），回退 columnName；
//     表名用列的 tableName

const MASK_MODES = ['hide', 'partial', 'hash', 'null'];

// partial 的保留位数
const PARTIAL_KEEP_START = 3;
const PARTIAL_KEEP_END = 2;

function normalize(text) {
  return String(text ?? '').trim().toLowerCase();
}

function splitList(text) {
  return String(text ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

/**
 * 把存储里的规则行摊平成 [{ table, column, mode }]，便于纯函数使用。
 * @param {Array} rows roleColumns 里的行（或 getRoleDetail 返回的 columns）
 */
function buildColumnMaskRules(rows) {
  const rules = [];
  for (const row of rows ?? []) {
    const mode = row.column_mask_mode ?? row.mode;
    if (!MASK_MODES.includes(mode)) continue;
    const tables = splitList(row.table_names_list ?? row.table);
    const columns = splitList(row.column_names_list ?? row.column);
    if (!columns.length) continue;
    if (!tables.length) {
      for (const column of columns) rules.push({ table: null, column, mode, ruleId: row.id ?? null });
    } else {
      for (const table of tables) {
        for (const column of columns) rules.push({ table, column, mode, ruleId: row.id ?? null });
      }
    }
  }
  return rules;
}

/** 找出某一列命中的脱敏规则（后一条覆盖前一条） */
function findColumnMaskRule(column, rules) {
  const columnName = normalize(column?.sourceColumnName ?? column?.columnName);
  const tableName = normalize(column?.tableName);
  let hit = null;
  for (const rule of rules ?? []) {
    if (normalize(rule.column) !== columnName) continue;
    if (rule.table && normalize(rule.table) !== tableName) continue;
    hit = rule;
  }
  return hit;
}

function maskValue(value, mode) {
  if (mode === 'null') return null;
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (mode === 'hash') {
    return require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8);
  }
  if (mode === 'partial') {
    if (text.length <= PARTIAL_KEEP_START + PARTIAL_KEEP_END) return '*'.repeat(text.length);
    const hidden = '*'.repeat(text.length - PARTIAL_KEEP_START - PARTIAL_KEEP_END);
    return `${text.slice(0, PARTIAL_KEEP_START)}${hidden}${text.slice(text.length - PARTIAL_KEEP_END)}`;
  }
  // hide 由列级处理（整列不返回），走到这里说明用错了，按原样返回
  return value;
}

/**
 * 对查询结果应用列脱敏。
 * @returns {{columns, rows, maskedColumns}} 新对象，不改动入参
 */
function applyColumnMasks(result, rules) {
  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];
  if (!rules?.length || !columns.length) {
    return { ...result, maskedColumns: {} };
  }

  const maskedColumns = {};
  const keptColumns = [];
  const columnModes = [];
  const hiddenKeys = [];

  for (const column of columns) {
    const rule = findColumnMaskRule(column, rules);
    const name = column?.columnName;
    if (rule?.mode === 'hide') {
      maskedColumns[name] = 'hide';
      // 必须连行里的键一起删掉：只去掉列元数据的话，值仍然在返回体里，等于没隐藏
      hiddenKeys.push(name);
      continue;
    }
    keptColumns.push(column);
    columnModes.push(rule ? { name, mode: rule.mode } : null);
    if (rule) maskedColumns[name] = rule.mode;
  }

  const maskedRows = rows.map(row => {
    const out = {};
    for (const key of Object.keys(row ?? {})) out[key] = row[key];
    for (const key of hiddenKeys) delete out[key];
    columnModes.forEach((entry, index) => {
      if (!entry) return;
      const key = keptColumns[index]?.columnName;
      if (key === undefined) return;
      out[key] = maskValue(out[key], entry.mode);
    });
    return out;
  });

  return { ...result, columns: keptColumns, rows: maskedRows, maskedColumns };
}

module.exports = {
  MASK_MODES,
  PARTIAL_KEEP_START,
  PARTIAL_KEEP_END,
  buildColumnMaskRules,
  findColumnMaskRule,
  maskValue,
  applyColumnMasks,
};
