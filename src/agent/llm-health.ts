export async function checkLLMHealth(
  baseUrl: string,
  timeoutMs = 5000
): Promise<{
  available: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/models`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    return {
      available: response.ok,
      status: response.status,
      error: response.ok
        ? undefined
        : `LLM API returned HTTP ${response.status}`,
    };
  } catch {
    return {
      available: false,
      error: 'LLM API could not be reached',
    };
  }
}