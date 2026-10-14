const {
  ALLOWED_USER_FIELDS,
  ALLOWED_OPERATORS,
  resolveRowFilterValue,
  buildRowFilterCondition,
  buildRowFilterRules,
  findApplicableFilters,
  injectRowFilters,
} = require('./rowFiltering');

const select = () => ({
  commandType: 'select',
  from: { name: { pureName: 'customers', schemaName: 'main' } },
  columns: [],
});

const usersRule = (overrides = {}) => ({
  table_names_list: 'customers',
  column_name: 'tenant',
  filter_operator: '=',
  value_type: 'user',
  user_field: 'tenant',
  ...overrides,
});

describe('resolving rule values', () => {
  test('a user field is read from the member record', () => {
    expect(resolveRowFilterValue({ valueType: 'user', userField: 'tenant' }, { tenant: 'T-1042' })).toBe('T-1042');
  });

  test('a literal is used as is', () => {
    expect(resolveRowFilterValue({ valueType: 'literal', value: 'ACME' }, { tenant: 'x' })).toBe('ACME');
  });

  test('a missing member field resolves to null, so the condition matches nothing', () => {
    expect(resolveRowFilterValue({ valueType: 'user', userField: 'tenant' }, {})).toBeNull();
    expect(resolveRowFilterValue({ valueType: 'user', userField: 'tenant' }, { tenant: '' })).toBeNull();
  });

  test('an unknown user field is refused', () => {
    expect(() => resolveRowFilterValue({ valueType: 'user', userField: 'isAdmin' }, {})).toThrow(/Unknown row filter variable/);
    expect(ALLOWED_USER_FIELDS).toContain('tenant');
  });
});

describe('building conditions', () => {
  test('produces a binary condition on a named column', () => {
    const condition = buildRowFilterCondition({ column: 'tenant', operator: '=', valueType: 'user', userField: 'tenant' }, { tenant: 'T-1042' });
    expect(condition).toEqual({
      conditionType: 'binary',
      operator: '=',
      left: { exprType: 'column', columnName: 'tenant' },
      right: { exprType: 'value', value: 'T-1042' },
    });
  });

  test('a missing value becomes a null comparison (fail closed)', () => {
    const condition = buildRowFilterCondition({ column: 'tenant', valueType: 'user', userField: 'tenant' }, {});
    expect(condition.right).toEqual({ exprType: 'value', value: null });
  });

  test('only known operators are accepted', () => {
    for (const operator of ALLOWED_OPERATORS) {
      expect(buildRowFilterCondition({ column: 'c', operator, valueType: 'literal', value: 'x' }, {}).operator).toBe(operator);
    }
    expect(() => buildRowFilterCondition({ column: 'c', operator: 'LIKE' }, {})).toThrow(/Unsupported row filter operator/);
    expect(() => buildRowFilterCondition({ column: 'c', valueType: 'user' }, {})).toThrow(/user field is required/);
  });

  test('a missing column is refused', () => {
    expect(() => buildRowFilterCondition({ column: '  ' }, {})).toThrow(/column is required/);
  });
});

describe('rule expansion', () => {
  test('an empty table list means any table', () => {
    const rules = buildRowFilterRules([usersRule({ table_names_list: '' })]);
    expect(rules).toHaveLength(1);
    expect(rules[0].table).toBeNull();
  });

  test('a comma separated table list expands to one entry per table', () => {
    const rules = buildRowFilterRules([usersRule({ table_names_list: 'customers, orders' })]);
    expect(rules.map(r => r.table)).toEqual(['customers', 'orders']);
  });

  test('rules without a column are dropped', () => {
    expect(buildRowFilterRules([usersRule({ column_name: '  ' })])).toEqual([]);
  });
});

describe('injecting into a select', () => {
  test('matches the table case-insensitively and keeps the original select untouched', () => {
    const original = select();
    const rules = buildRowFilterRules([usersRule({ table_names_list: 'CUSTOMERS' })]);
    const { select: injected, applied } = injectRowFilters(original, rules, { tenant: 'T-1042' });
    expect(applied).toEqual([{ table: 'CUSTOMERS', column: 'tenant' }]);
    expect(original.where).toBeUndefined();
    expect(injected.where).toBeTruthy();
    expect(injected).not.toBe(original);
  });

  test('a rule for another table is not applied', () => {
    const rules = buildRowFilterRules([usersRule({ table_names_list: 'orders' })]);
    const { select: injected, applied } = injectRowFilters(select(), rules, { tenant: 'T-1042' });
    expect(applied).toEqual([]);
    expect(injected.where).toBeUndefined();
  });

  test('an any-table rule applies', () => {
    const rules = buildRowFilterRules([usersRule({ table_names_list: '' })]);
    const { applied } = injectRowFilters(select(), rules, { tenant: 'T-1042' });
    expect(applied).toEqual([{ table: '*', column: 'tenant' }]);
  });

  test('an existing where is preserved and ANDed', () => {
    const existing = { conditionType: 'binary', operator: '>', left: { exprType: 'column', columnName: 'id' }, right: { exprType: 'value', value: '10' } };
    const rules = buildRowFilterRules([usersRule()]);
    const { select: injected } = injectRowFilters({ ...select(), where: existing }, rules, { tenant: 'T-1042' });
    expect(injected.where.conditionType).toBe('and');
    expect(injected.where.conditions).toHaveLength(2);
    expect(injected.where.conditions[0]).toBe(existing);
  });

  test('several rules on the same table are ANDed together', () => {
    const rules = buildRowFilterRules([usersRule(), usersRule({ column_name: 'region', filter_operator: '=', user_field: 'login' })]);
    const { select: injected } = injectRowFilters(select(), rules, { tenant: 'T-1042', login: 'wangwu' });
    expect(injected.where.conditionType).toBe('and');
    expect(injected.where.conditions).toHaveLength(2);
  });

  test('a select without a from clause is left alone', () => {
    const bare = { commandType: 'select', columns: [] };
    const rules = buildRowFilterRules([usersRule()]);
    expect(injectRowFilters(bare, rules, { tenant: 'T' }).select).toBe(bare);
  });

  test('no rules means no injection', () => {
    const original = select();
    expect(injectRowFilters(original, [], { tenant: 'T' }).select).toBe(original);
  });

  test('findApplicableFilters is case-insensitive', () => {
    const rules = buildRowFilterRules([usersRule({ table_names_list: 'CUSTOMERS' })]);
    expect(findApplicableFilters(rules, 'customers')).toHaveLength(1);
    expect(findApplicableFilters(rules, 'orders')).toHaveLength(0);
  });
});
