import { ALLOWED_GAMES } from './schema';

/** Build the canonical full URL for a catalogued slot game. */
export function getSlotGameUrl(game: string, origin: string): string {
  const path = (ALLOWED_GAMES as Record<string, string>)[game];
  if (!path) throw new Error('GAME_NOT_ALLOWED');
  return new URL(path, origin).href;
}

/** Navigate to an allowlisted slot game with the adapter's single retry. */
export async function navigateToSlotGame(
  game: string,
  origin: string,
  navigate: (url: string) => Promise<unknown>,
  onRetry: (attempt: number) => void = (attempt) => console.log(`GAME NAVIGATION attempt ${attempt} failed`),
): Promise<void> {
  const gameUrl = getSlotGameUrl(game, origin);
  await navigateToSlotGameUrl(gameUrl, navigate, onRetry);
}

export async function navigateToSlotGameUrl(
  gameUrl: string,
  navigate: (url: string) => Promise<unknown>,
  onRetry: (attempt: number) => void = (attempt) => console.log(`GAME NAVIGATION attempt ${attempt} failed`),
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await navigate(gameUrl);
      return;
    } catch {
      onRetry(attempt);
      if (attempt === 2) throw new Error('GAME_NAVIGATION_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}
