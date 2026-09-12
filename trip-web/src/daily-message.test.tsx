import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TripClockPanel } from './App';
import type { TodayContext } from './api';
afterEach(cleanup);
const today: TodayContext = { today: '2026-09-12', phase: 'active_day', countdown_days: 0, current: null, next: null, events: [], flights: [], companion_message: { date: '2026-09-12', he: 'יש מקום לרגע קטן של גילוי.', en: 'Leave room for a little discovery.' } };
it.each(['he', 'en'] as const)('shows the companion message in %s', lang => {
  render(<TripClockPanel today={today} lang={lang} />);
  expect(screen.getByText(today.companion_message![lang])).toBeInTheDocument();
});
it('never presents an old message as today’s encouragement', () => {
  render(<TripClockPanel today={{ ...today, today: '2026-09-13' }} lang="en" />);
  expect(screen.queryByText(today.companion_message!.en)).not.toBeInTheDocument();
  expect(screen.getByText(/Take today at your own pace/)).toBeInTheDocument();
});
