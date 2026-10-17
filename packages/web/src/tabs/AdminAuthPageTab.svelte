<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import './adminPages.css';

  // 原型 section「登录 / 成员来源」：哆啦A梦登录链路 + 成员来源分布
  export const matchingProps = [];
  let summary = null, users = [], loading = true, errorMessage = '';

  onMount(async () => {
    const [s, u] = await Promise.all([apiCall('permissions/get-summary'), apiCall('permissions/get-user-list')]);
    if (s?.errorMessage) errorMessage = s.errorMessage;
    summary = s ?? null;
    users = u?.users ?? [];
    loading = false;
  });

  $: bySource = users.reduce((acc, u) => { const k = u.source || '未知'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
</script>

<div class="aP" data-testid="AdminAuthPage">
  {#if loading}
    <div class="aP-empty">加载中…</div>
  {:else}
    {#if errorMessage}<div class="aP-err">{errorMessage}</div>{/if}
    <div class="aP-card">
      <div class="aP-h"><h2>登录链路</h2></div>
      <table class="aP-tbl">
        <tbody>
          <tr><td style="width:200px">哆啦A梦登录（X-Connect-Token）</td>
            <td>{#if summary?.connectAuth?.enabled}<span class="aP-pill g">已启用</span>{:else}<span class="aP-pill r">未启用</span>{/if}</td></tr>
          <tr><td>身份密钥</td>
            <td>{#if summary?.connectAuth?.hasSecret}<span class="aP-pill g">已配置</span>{:else}<span class="aP-pill r">未配置</span>{/if}
              <span class="aP-sub">与网关注入的 token 同值，用于校验身份</span></td></tr>
          <tr><td>超级管理员规则</td>
            <td><span class="aP-mono">{summary?.superAdminPermission ?? 'SUPER_ADMIN'}</span>
              <span class="aP-sub">token 里带这个权限即自动成为超管（幂等，写审计）</span></td></tr>
          <tr><td>配置存储</td><td class="aP-mono">{summary?.path ?? '—'}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="aP-card">
      <div class="aP-h"><h2>成员来源分布</h2></div>
      <table class="aP-tbl">
        <thead><tr><th>来源</th><th>人数</th><th>说明</th></tr></thead>
        <tbody>
          {#each Object.entries(bySource) as [src, n] (src)}
            <tr><td>{src}</td><td>{n}</td>
              <td class="aP-sub">{src === '哆啦A梦' || src === 'connect' ? '首次登录自动落成本地成员，需在此授权后才可见库' : src === '本地' ? '本地管理员（兜底账号）' : '环境变量导入'}</td></tr>
          {/each}
        </tbody>
      </table>
      <div class="aP-sub" style="margin-top:8px">未在权限库里的账号首次登录会自动建成员并落到「待分配」（无任何库权限）。</div>
    </div>
  {/if}
</div>
