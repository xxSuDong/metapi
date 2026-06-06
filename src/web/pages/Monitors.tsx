import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';

type RuntimeHealthInfo = {
  state: string;
  reason: string;
  source?: string;
  checkedAt?: string | null;
};

type MonitorOverview = {
  generatedAt: string;
  accounts: {
    total: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
    disabled: number;
    expired: number;
    problemItems: Array<{
      id: number;
      username: string | null;
      siteId: number;
      siteName: string;
      status: string | null;
      runtimeHealth: RuntimeHealthInfo;
    }>;
  };
  sites: {
    total: number;
    active: number;
    disabled: number;
  };
  routes: {
    total: number;
    enabled: number;
    disabled: number;
    zeroEnabledChannels: number;
    cooldownChannels: number;
    problemItems: Array<{
      id: number;
      title: string;
      modelPattern: string;
      enabled: boolean;
      channelCount: number;
      enabledChannelCount: number;
      cooldownChannelCount: number;
      failedChannelCount: number;
      siteNames: string[];
      decisionRefreshedAt: string | null;
    }>;
  };
  traffic24h: {
    total: number;
    success: number;
    failed: number;
    retried: number;
    successRate: number;
    averageLatencyMs: number | null;
    totalCost: number;
    totalTokens: number;
    recentFailures: Array<{
      id: number;
      modelRequested: string | null;
      modelActual: string | null;
      siteName: string | null;
      accountUsername: string | null;
      httpStatus: number | null;
      errorMessage: string | null;
      createdAt: string | null;
    }>;
  };
};

function formatNumber(value: number | null | undefined): string {
  return Number(value || 0).toLocaleString();
}

function formatCost(value: number): string {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusLabel(state: string): string {
  switch (state) {
    case 'healthy': return '健康';
    case 'unhealthy': return '异常';
    case 'degraded': return '波动';
    case 'disabled': return '禁用';
    case 'unknown': return '未知';
    default: return state || '未知';
  }
}

function MetricCard(props: { title: string; value: string; detail: string; tone?: 'success' | 'warning' | 'danger' | 'info' }) {
  return (
    <div className={`monitor-metric-card monitor-metric-${props.tone || 'info'}`.trim()}>
      <div className="monitor-metric-title">{props.title}</div>
      <div className="monitor-metric-value">{props.value}</div>
      <div className="monitor-metric-detail">{props.detail}</div>
    </div>
  );
}

function StatusBadge({ state }: { state: string }) {
  const normalized = state || 'unknown';
  return <span className={`monitor-status-badge monitor-status-${normalized}`}>{statusLabel(normalized)}</span>;
}

function EmptyState({ children }: { children: string }) {
  return <div className="monitor-empty-state">{children}</div>;
}

export default function Monitors() {
  const toast = useToast();
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const loadOverview = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setErrorMessage('');
    try {
      const res = await api.getMonitorOverview({ refresh });
      setOverview(res as MonitorOverview);
    } catch (err: any) {
      const message = err?.message || '加载实例监控失败';
      setErrorMessage('加载实例监控失败');
      toast.error(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview(false);
  }, []);

  const handleHealthCheck = async () => {
    setCheckingHealth(true);
    try {
      await api.refreshAccountHealth({ wait: true });
      await loadOverview(true);
      toast.success('账号健康检查已完成');
    } catch (err: any) {
      toast.error(err?.message || '健康检查失败');
    } finally {
      setCheckingHealth(false);
    }
  };

  const successTone = useMemo(() => {
    if (!overview) return 'info';
    if (overview.traffic24h.successRate >= 95) return 'success';
    if (overview.traffic24h.successRate >= 80) return 'warning';
    return 'danger';
  }, [overview]);

  return (
    <div className="animate-fade-in monitor-page">
      <div className="monitor-toolbar page-header">
        <div>
          <h2 className="page-title">实例监控</h2>
          <div className="monitor-subtitle">监控当前 Metapi 的站点、账号、路由和请求健康</div>
        </div>
        <div className="monitor-actions">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => void loadOverview(true)}
            disabled={refreshing || loading}
          >
            {refreshing ? '刷新中...' : '刷新'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleHealthCheck}
            disabled={checkingHealth || loading}
          >
            {checkingHealth ? '检查中...' : '健康检查'}
          </button>
        </div>
      </div>

      {errorMessage && <div className="monitor-hint">{errorMessage}</div>}
      {loading && !overview && <div className="card monitor-section">加载实例监控中...</div>}

      {overview && (
        <>
          <div className="monitor-grid">
            <MetricCard
              title="账号健康"
              value={`${overview.accounts.healthy}/${overview.accounts.total}`}
              detail={`异常 ${overview.accounts.unhealthy} · 未知 ${overview.accounts.unknown} · 禁用 ${overview.accounts.disabled} · 过期 ${overview.accounts.expired}`}
              tone={overview.accounts.unhealthy || overview.accounts.expired ? 'danger' : 'success'}
            />
            <MetricCard
              title="路由通道"
              value={`${overview.routes.enabled}/${overview.routes.total}`}
              detail={`无可用通道 ${overview.routes.zeroEnabledChannels} · 冷却中 ${overview.routes.cooldownChannels}`}
              tone={overview.routes.zeroEnabledChannels || overview.routes.cooldownChannels ? 'warning' : 'success'}
            />
            <MetricCard
              title="近 24h 请求"
              value={`${overview.traffic24h.successRate}%`}
              detail={`总量 ${formatNumber(overview.traffic24h.total)} · 成功 ${formatNumber(overview.traffic24h.success)} · 失败 ${formatNumber(overview.traffic24h.failed)} · 平均 ${overview.traffic24h.averageLatencyMs ?? '—'}ms`}
              tone={successTone}
            />
            <MetricCard
              title="站点状态"
              value={`${overview.sites.active}/${overview.sites.total}`}
              detail={`禁用 ${overview.sites.disabled} · Token ${formatNumber(overview.traffic24h.totalTokens)} · 花费 ${formatCost(overview.traffic24h.totalCost)}`}
              tone={overview.sites.disabled ? 'warning' : 'info'}
            />
          </div>

          <div className="monitor-quick-links card">
            <span>快速排查：</span>
            <Link to="/accounts" className="btn btn-ghost">账号管理</Link>
            <Link to="/routes" className="btn btn-ghost">智能路由</Link>
            <Link to="/logs" className="btn btn-ghost">使用日志</Link>
            <span className="monitor-generated-at">更新时间：{formatTime(overview.generatedAt)}</span>
          </div>

          <section className="card monitor-section">
            <div className="monitor-section-header">
              <h3>异常账号</h3>
              <span>{overview.accounts.problemItems.length} 个问题</span>
            </div>
            {overview.accounts.problemItems.length === 0 ? (
              <EmptyState>暂无异常账号</EmptyState>
            ) : (
              <div className="monitor-table-wrap">
                <table className="monitor-table">
                  <thead>
                    <tr>
                      <th>账号</th>
                      <th>站点</th>
                      <th>状态</th>
                      <th>原因</th>
                      <th>检查时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.accounts.problemItems.map((item) => (
                      <tr key={item.id}>
                        <td>{item.username || `#${item.id}`}</td>
                        <td>{item.siteName}</td>
                        <td><StatusBadge state={item.runtimeHealth.state} /></td>
                        <td>{item.runtimeHealth.reason}</td>
                        <td>{formatTime(item.runtimeHealth.checkedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card monitor-section">
            <div className="monitor-section-header">
              <h3>风险路由</h3>
              <span>{overview.routes.problemItems.length} 个问题</span>
            </div>
            {overview.routes.problemItems.length === 0 ? (
              <EmptyState>暂无风险路由</EmptyState>
            ) : (
              <div className="monitor-table-wrap">
                <table className="monitor-table">
                  <thead>
                    <tr>
                      <th>路由</th>
                      <th>模型</th>
                      <th>通道</th>
                      <th>冷却/失败</th>
                      <th>站点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.routes.problemItems.map((item) => (
                      <tr key={item.id}>
                        <td>{item.title}</td>
                        <td>{item.modelPattern}</td>
                        <td>{item.enabledChannelCount}/{item.channelCount}</td>
                        <td>{item.cooldownChannelCount}/{item.failedChannelCount}</td>
                        <td>{item.siteNames.length ? item.siteNames.join('、') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card monitor-section">
            <div className="monitor-section-header">
              <h3>近期失败请求</h3>
              <span>{overview.traffic24h.recentFailures.length} 条</span>
            </div>
            {overview.traffic24h.recentFailures.length === 0 ? (
              <EmptyState>暂无近期失败请求</EmptyState>
            ) : (
              <div className="monitor-table-wrap">
                <table className="monitor-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>站点/账号</th>
                      <th>状态码</th>
                      <th>错误</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.traffic24h.recentFailures.map((item) => (
                      <tr key={item.id}>
                        <td>{item.modelActual || item.modelRequested || '—'}</td>
                        <td>{item.siteName || '—'} / {item.accountUsername || '—'}</td>
                        <td>{item.httpStatus || '—'}</td>
                        <td>{item.errorMessage || '—'}</td>
                        <td>{formatTime(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
