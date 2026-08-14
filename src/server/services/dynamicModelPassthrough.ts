const DYNAMIC_PASSTHROUGH_PLATFORM_ALLOWLIST = new Set([
  '',
  'new-api',
  'newapi',
  'one-api',
  'oneapi',
  'one-hub',
  'onehub',
  'done-hub',
  'donehub',
  'sub2api',
  'veloera',
  'openai',
]);

const DYNAMIC_PASSTHROUGH_BRAND_PREFIXES = [
  'gpt',
  'o',
  'chatgpt',
  'codex',
  'claude',
  'fable',
  'gemini',
  'deepseek',
  'zai',
  'glm',
  'qwen',
  'kimi',
  'moonshot',
  'mistral',
  'llama',
  'grok',
  'ernie',
  'doubao',
  'hunyuan',
  'yi',
];

export function normalizeDynamicPassthroughPlatform(platform: unknown): string {
  return typeof platform === 'string' ? platform.trim().toLowerCase() : '';
}

export function isDynamicPassthroughPlatform(platform: unknown): boolean {
  return DYNAMIC_PASSTHROUGH_PLATFORM_ALLOWLIST.has(normalizeDynamicPassthroughPlatform(platform));
}

export function isSafeDynamicPassthroughModelName(modelName: string): boolean {
  const normalized = (modelName || '').trim();
  if (!normalized || normalized.length > 160) return false;
  if (normalized.startsWith('__')) return false;
  if (/[\x00-\x1f\x7f\s]/.test(normalized)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(normalized);
}

export function normalizeDynamicPassthroughModelAlias(modelName: string): string {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

export function resolveDynamicPassthroughModelFamilyKeys(modelName: string): Set<string> {
  const normalized = normalizeDynamicPassthroughModelAlias(modelName).replace(/\s+/g, '').toLowerCase();
  const keys: Set<string> = new Set();
  if (!normalized) return keys;

  if (/^k\d+(?:[._-].*)?$/.test(normalized)) {
    keys.add('kimi');
    keys.add('moonshot');
  }
  if (normalized.startsWith('kimi') || normalized.startsWith('moonshot')) {
    keys.add('kimi');
    keys.add('moonshot');
  }

  const tokens: string[] = normalized.match(/[a-z]+/g) ?? [];
  for (const prefix of DYNAMIC_PASSTHROUGH_BRAND_PREFIXES) {
    if (
      normalized.startsWith(prefix)
      || tokens.includes(prefix)
      || tokens.some((token) => token.startsWith(prefix) && prefix.length >= 3)
    ) {
      keys.add(prefix);
    }
  }

  if (keys.size === 0 && /^5(?:[._-]?\d+)*(?:[a-z]+)?$/.test(normalized)) {
    keys.add('gpt');
  }

  return keys;
}

export function hasSharedDynamicPassthroughModelFamily(left: string, right: string): boolean {
  const leftKeys = resolveDynamicPassthroughModelFamilyKeys(left);
  if (leftKeys.size === 0) return false;
  const rightKeys = resolveDynamicPassthroughModelFamilyKeys(right);
  for (const key of leftKeys) {
    if (rightKeys.has(key)) return true;
  }
  return false;
}

export function resolveDynamicPassthroughPriority(input: {
  requestedModel: string;
  sourceModel: string;
  sitePlatform: string | null | undefined;
}): { priorityOffset: number; familyMatched: boolean } | null {
  if (!isDynamicPassthroughPlatform(input.sitePlatform)) return null;
  const normalizedSourceModel = (input.sourceModel || '').trim();
  if (!normalizedSourceModel) return null;

  const familyMatched = hasSharedDynamicPassthroughModelFamily(input.requestedModel, normalizedSourceModel);
  if (familyMatched) {
    return { priorityOffset: 0, familyMatched: true };
  }

  const platform = normalizeDynamicPassthroughPlatform(input.sitePlatform);
  if (platform === 'openai' || platform === 'new-api' || platform === 'newapi') {
    return { priorityOffset: 20, familyMatched: false };
  }
  if (platform === 'one-api' || platform === 'oneapi' || platform === 'one-hub' || platform === 'onehub') {
    return { priorityOffset: 30, familyMatched: false };
  }
  return { priorityOffset: 40, familyMatched: false };
}
