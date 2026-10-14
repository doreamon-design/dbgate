const {
  MASK_MODES,
  buildColumnMaskRules,
  findColumnMaskRule,
  maskValue,
  applyColumnMasks,
} = require('./columnMasking');

function makeResult() {
  return {
    columns: [
      { columnName: 'id', dataType: 'INTEGER' },
      { columnName: 'name', dataType: 'TEXT', tableName: 'customers', sourceColumnName: 'name' },
      { columnName: 'phone', dataType: 'TEXT', tableName: 'customers', sourceColumnName: 'phone' },
    ],
    rows: [
      { id: 1, name: 'alice', phone: '13800001111' },
      { id: 2, name: 'bob', phone: '13900002222' },
    ],
  };
}

describe('maskValue', () => {
  test('partial keeps the first 3 and last 2 characters', () => {
    expect(maskValue('13800001111', 'partial')).toBe('138******11');
  });

  test('partial on a short value masks everything', () => {
    expect(maskValue('abc', 'partial')).toBe('***');
    expect(maskValue('abcde', 'partial')).toBe('*****');
  });

  test('hash is deterministic and short', () => {
    const first = maskValue('13800001111', 'hash');
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(maskValue('13800001111', 'hash')).toBe(first);
    expect(maskValue('13900002222', 'hash')).not.toBe(first);
  });

  test('null mode replaces the value entirely', () => {
    expect(maskValue('13800001111', 'null')).toBeNull();
  });

  test('null and undefined inputs survive partial/hash', () => {
    expect(maskValue(null, 'partial')).toBeNull();
    expect(maskValue(undefined, 'partial')).toBeUndefined();
    expect(maskValue(null, 'hash')).toBeNull();
  });

  test('exposes the supported modes', () => {
    expect(MASK_MODES).toEqual(['hide', 'partial', 'hash', 'null']);
  });
});

describe('rule matching', () => {
  test('a rule without a table matches any table', () => {
    const rules = buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'partial' }]);
    expect(findColumnMaskRule({ columnName: 'phone', tableName: 'customers' }, rules)).toBeTruthy();
    expect(findColumnMaskRule({ columnName: 'phone', tableName: 'users' }, rules)).toBeTruthy();
  });

  test('a table-scoped rule only matches its table', () => {
    const rules = buildColumnMaskRules([
      { table_names_list: 'customers', column_names_list: 'phone', column_mask_mode: 'partial' },
    ]);
    expect(findColumnMaskRule({ columnName: 'phone', tableName: 'customers' }, rules)).toBeTruthy();
    expect(findColumnMaskRule({ columnName: 'phone', tableName: 'users' }, rules)).toBeFalsy();
  });

  test('matching is case insensitive and splits comma lists', () => {
    const rules = buildColumnMaskRules([
      { table_names_list: 'Customers, Orders', column_names_list: 'Phone, Email', column_mask_mode: 'hide' },
    ]);
    expect(rules).toHaveLength(4);
    expect(findColumnMaskRule({ columnName: 'EMAIL', tableName: 'orders' }, rules)).toBeTruthy();
  });

  test('the last matching rule wins', () => {
    const rules = buildColumnMaskRules([
      { column_names_list: 'phone', column_mask_mode: 'partial' },
      { column_names_list: 'phone', column_mask_mode: 'null' },
    ]);
    expect(findColumnMaskRule({ columnName: 'phone' }, rules).mode).toBe('null');
  });

  test('an alias is matched through sourceColumnName', () => {
    const rules = buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'partial' }]);
    const rule = findColumnMaskRule(
      { columnName: 'p', tableName: 'customers', sourceColumnName: 'phone' },
      rules
    );
    expect(rule).toBeTruthy();
  });

  test('unknown modes are ignored rather than silently applied', () => {
    expect(buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'rot13' }])).toEqual([]);
  });
});

describe('applyColumnMasks', () => {
  test('without rules the result is untouched', () => {
    const result = makeResult();
    const masked = applyColumnMasks(result, []);
    expect(masked.rows).toEqual(result.rows);
    expect(masked.columns).toEqual(result.columns);
    expect(masked.maskedColumns).toEqual({});
  });

  test('partial masks the values in place', () => {
    const masked = applyColumnMasks(makeResult(), buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'partial' }]));
    expect(masked.rows.map(r => r.phone)).toEqual(['138******11', '139******22']);
    expect(masked.rows.map(r => r.name)).toEqual(['alice', 'bob']);
    expect(masked.maskedColumns).toEqual({ phone: 'partial' });
  });

  test('hide drops the column from both the column list and the rows', () => {
    const masked = applyColumnMasks(makeResult(), buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'hide' }]));
    expect(masked.columns.map(c => c.columnName)).toEqual(['id', 'name']);
    expect(masked.rows[0]).toEqual({ id: 1, name: 'alice' });
    expect(masked.maskedColumns).toEqual({ phone: 'hide' });
  });

  test('null mode keeps the column but blanks the values', () => {
    const masked = applyColumnMasks(makeResult(), buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'null' }]));
    expect(masked.columns.map(c => c.columnName)).toContain('phone');
    expect(masked.rows.map(r => r.phone)).toEqual([null, null]);
  });

  test('table scoping is honoured against the column metadata', () => {
    const rules = buildColumnMaskRules([
      { table_names_list: 'orders', column_names_list: 'phone', column_mask_mode: 'hide' },
    ]);
    const masked = applyColumnMasks(makeResult(), rules);
    expect(masked.columns.map(c => c.columnName)).toEqual(['id', 'name', 'phone']);
  });

  test('does not mutate the input result', () => {
    const result = makeResult();
    applyColumnMasks(result, buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'hide' }]));
    expect(result.columns.map(c => c.columnName)).toEqual(['id', 'name', 'phone']);
    expect(result.rows[0].phone).toBe('13800001111');
  });

  test('rows without the masked column are left alone', () => {
    const result = {
      columns: [{ columnName: 'phone', dataType: 'TEXT' }],
      rows: [{ phone: '13800001111' }, {}],
    };
    const masked = applyColumnMasks(result, buildColumnMaskRules([{ column_names_list: 'phone', column_mask_mode: 'partial' }]));
    expect(masked.rows).toEqual([{ phone: '138******11' }, {}]);
  });
});
