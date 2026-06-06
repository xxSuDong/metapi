import { describe, expect, it } from 'vitest';
import { translateText } from './i18n.js';

describe('translateText', () => {
  it('keeps zh text unchanged in zh mode', () => {
    expect(translateText('模型广场', 'zh')).toBe('模型广场');
  });

  it('translates exact key in en mode', () => {
    expect(translateText('模型广场', 'en')).toBe('Model Marketplace');
  });

  it('supports phrase replacement for mixed text', () => {
    expect(translateText('覆盖槽位 3', 'en')).toBe('Coverage Slots 3');
    expect(translateText('共 12 个模型', 'en')).toBe('Total 12 models');
  });

  it('never returns Chinese characters in strict en mode', () => {
    const samples = [
      '站点已禁用',
      '缓存清理后重建失败：unknown error',
      '签到任务执行中，请稍后查看签到日志',
    ];

    for (const sample of samples) {
      expect(translateText(sample, 'en')).not.toMatch(/[㐀-鿿]/);
    }
  });

  it('uses concrete english translations instead of fallback for common runtime text', () => {
    expect(translateText('切换到中文', 'en')).toBe('Switch to Chinese');
    expect(translateText('中', 'en')).toBe('ZH');

    const samples = [
      '站点已禁用',
      '签到任务执行中，请稍后查看签到日志',
      '下游访问令牌至少 6 位（含 sk-）',
      '路由重建任务执行中，请稍后查看程序日志',
    ];

    for (const sample of samples) {
      const translated = translateText(sample, 'en');
      expect(translated).not.toBe('Untranslated');
      expect(translated).not.toMatch(/[㐀-鿿]/);
    }
  });

  it('translates internal monitor dashboard labels without Untranslated placeholders', () => {
    const samples = [
      '实例监控',
      '监控当前 Metapi 的站点、账号、路由和请求健康',
      '账号健康',
      '路由通道',
      '近 24h 请求',
      '站点状态',
      '健康检查',
      '检查中...',
      '异常账号',
      '风险路由',
      '近期失败请求',
      '暂无异常账号',
      '暂无风险路由',
      '暂无近期失败请求',
      '快速排查：',
      '更新时间：',
      '波动',
      '检查时间',
      '站点/账号',
      '状态码',
    ];

    for (const sample of samples) {
      const translated = translateText(sample, 'en');
      expect(translated, sample).not.toBe('Untranslated');
      expect(translated, sample).not.toMatch(/[㐀-鿿]/);
    }
  });
});
