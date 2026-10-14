// 守卫测试：操作开关清单里的每一个 permission 必须真的被强制。
//
// 动机：仓库里有一批「看起来像权限」的字符串（例如 * _meta 里声明的
// `connections/save`、`server-connections/drop-database`），在社区版里其实没有任何
// 强制点（useController 的字符串 meta 分支是注释掉的）。如果照着它们做开关，就是在
// 界面上提供假开关。这个测试扫源码，保证每个开关都能对应到一处真实的
// hasPermission(...) / testStandardPermission(...) 调用。

const fs = require('fs');
const path = require('path');
const { OPERATION_PERMISSIONS } = require('./operationPermissions');

const SRC_ROOT = path.join(__dirname, '..');

function collectSourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('operation permission switches', () => {
  const sources = collectSourceFiles(SRC_ROOT).map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));

  test('the source tree was actually scanned', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  test.each(OPERATION_PERMISSIONS.map(x => [x.permission, x]))('%s has a real enforcement point', (permission, entry) => {
    // 允许两种写法：testStandardPermission('x', ...) 与 hasPermission('x', ...)
    const pattern = new RegExp(
      `(testStandardPermission|hasPermission)\\(\\s*['"\`]${escapeRegExp(permission)}['"\`]`
    );
    const hits = sources.filter(s => pattern.test(s.text)).map(s => path.relative(SRC_ROOT, s.file));
    expect({ permission, hits }).toEqual({ permission, hits: expect.any(Array) });
    expect(hits.length).toBeGreaterThan(0);
  });

  test('every entry is uniquely keyed and described', () => {
    const keys = OPERATION_PERMISSIONS.map(x => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    const permissions = OPERATION_PERMISSIONS.map(x => x.permission);
    expect(new Set(permissions).size).toBe(permissions.length);
    for (const entry of OPERATION_PERMISSIONS) {
      expect(entry.labelKey).toMatch(/^admin\.operations\./);
      expect(entry.defaultLabel).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  test('the deny-prefixed form is what a switch writes', () => {
    for (const entry of OPERATION_PERMISSIONS) {
      // 开关关闭 = 加一条 deny；开关开启 = 删掉这条 deny
      expect(entry.permission.startsWith('~')).toBe(false);
    }
  });
});
