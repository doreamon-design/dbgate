// 数据库 / 对象 / 对象范围的档位与数字 id 的映射。
//
// 数字 id 与 packages/api/src/storageModel.js 中 role_databases / role_tables 的外键取值完全一致
// （-1..-5、-1..-9），这样社区版存下来的授权行可以原样导入 Team(Premium) 版，反之亦然。
// hasPermission.js 里的解析逻辑直接用这些常数，避免两处各写一份。

const DATABASE_ROLE_ID_NAMES = {
  '-1': 'view',
  '-2': 'read_content',
  '-3': 'write_data',
  '-4': 'run_script',
  '-5': 'deny',
};

const TABLE_ROLE_ID_NAMES = {
  '-1': 'read',
  '-2': 'update_only',
  '-3': 'create_update_delete',
  '-4': 'run_script',
  '-5': 'deny',
};

const TABLE_SCOPE_ID_NAMES = {
  '-1': 'all_objects',
  '-2': 'tables',
  '-3': 'views',
  '-4': 'tables_views_collections',
  '-5': 'procedures',
  '-6': 'functions',
  '-7': 'triggers',
  '-8': 'sql_objects',
  '-9': 'collections',
};

function invert(map) {
  const res = {};
  for (const key of Object.keys(map)) res[map[key]] = Number(key);
  return res;
}

const DATABASE_ROLE_NAME_IDS = invert(DATABASE_ROLE_ID_NAMES);
const TABLE_ROLE_NAME_IDS = invert(TABLE_ROLE_ID_NAMES);
const TABLE_SCOPE_NAME_IDS = invert(TABLE_SCOPE_ID_NAMES);

// 由弱到强，用于「多角色取最高」与「是否达到所需档位」的比较
const DATABASE_ROLE_ORDER = ['deny', 'view', 'read_content', 'write_data', 'run_script'];
const TABLE_ROLE_ORDER = ['deny', 'read', 'update_only', 'create_update_delete', 'run_script'];

module.exports = {
  DATABASE_ROLE_ID_NAMES,
  TABLE_ROLE_ID_NAMES,
  TABLE_SCOPE_ID_NAMES,
  DATABASE_ROLE_NAME_IDS,
  TABLE_ROLE_NAME_IDS,
  TABLE_SCOPE_NAME_IDS,
  DATABASE_ROLE_ORDER,
  TABLE_ROLE_ORDER,
};
