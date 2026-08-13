export function isOpenAiSdkUserAgent(userAgent: string): boolean {
  const normalized = userAgent.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith('openai/')
    || normalized.startsWith('openai-')
    || normalized.includes('openai/python')
    || normalized.includes('openai-node')
    || normalized.includes('openai-java')
    || normalized.includes('openai-go')
    || normalized.includes('openai-dotnet')
    || normalized.includes('openai-ruby')
    || normalized.includes('openai-php')
    || normalized.includes('asyncopenai')
  );
}
