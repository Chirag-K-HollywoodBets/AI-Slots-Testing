/** Return true for a slot spin request, regardless of whether fields are in URL or body. */
export function isDoSpinRequest(url: string, postData: string | null): boolean {
  const actions: string[] = [];
  try {
    const parsedUrl = new URL(url);
    const queryAction = parsedUrl.searchParams.get('action');
    if (queryAction) actions.push(queryAction);
  } catch {
    return false;
  }

  const body = postData?.trim() ?? '';
  if (body) {
    const form = new URLSearchParams(body);
    const bodyAction = form.get('action');
    if (bodyAction) actions.push(bodyAction);
    if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as { action?: unknown };
        if (typeof parsed.action === 'string') actions.push(parsed.action);
      } catch {
        // A malformed or non-JSON body cannot be interpreted as doSpin.
      }
    }
  }

  return actions.includes('doSpin');
}
