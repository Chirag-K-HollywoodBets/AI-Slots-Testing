import { describe, expect, it } from 'vitest';
import { fixtureMatchesTeams, textContainsTeam } from '../../src/agent/sports-fixtures';

describe('sports fixture team matching', () => {
  it('matches Ipswich Town to the site label Ipswich', () => {
    expect(fixtureMatchesTeams('IPSWICH vs NOTTINGHAM', 'nottingham forest', 'Ipswich Town')).toBe(true);
  });

  it('matches Ipswich to the site label Ipswich Town', () => {
    expect(fixtureMatchesTeams('Ipswich Town v Nottingham Forest', 'Nottingham', 'Ipswich')).toBe(true);
  });

  it('does not match a different opponent fixture', () => {
    expect(fixtureMatchesTeams('BRENTFORD vs NOTTINGHAM', 'Nottingham Forest', 'Ipswich Town')).toBe(false);
  });

  it('matches user-named teams and opponents on other Premier League fixtures', () => {
    expect(fixtureMatchesTeams('ARSENAL vs CHELSEA', 'Arsenal', 'Chelsea')).toBe(true);
    expect(fixtureMatchesTeams('ARSENAL vs CHELSEA', 'Arsenal', 'Tottenham')).toBe(false);
    expect(textContainsTeam('Arsenal 1X2 Chelsea', 'Arsenal')).toBe(true);
  });

  it('checks betslip team text with aliases', () => {
    expect(textContainsTeam('Ipswich 1X2 Nottingham', 'Ipswich Town')).toBe(true);
    expect(textContainsTeam('Ipswich 1X2 Nottingham', 'Nottingham Forest')).toBe(true);
  });
});
