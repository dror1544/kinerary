import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TripClockPanel, TodayView } from './App';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TodayContext } from './api';
afterEach(cleanup);
it('does not replace an empty next activity with yesterday’s first itinerary item', () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  client.setQueryData(['today'], { ...today, today: '' });
  render(<QueryClientProvider client={client}><TodayView lang="en" onOpenItinerary={() => {}} itinerary={{ revision: 'test', days: [], items: [{ item_uid: 'old', phase_id: 'ny', date: '2026-09-11', item_type: 'activity', text_he: 'ארוחת בוקר', text_en: 'Yesterday breakfast' }] }} /></QueryClientProvider>);
  expect(screen.queryByText('Yesterday breakfast')).not.toBeInTheDocument();
  expect(screen.getByText('No upcoming activities scheduled.')).toBeInTheDocument();
});
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
