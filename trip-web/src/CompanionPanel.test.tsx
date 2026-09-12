import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPanel } from './CompanionPanel';
import { api } from './api';
vi.mock('./api', () => ({ api: vi.fn() }));
vi.mock('./CompanionTasks', () => ({ CompanionTasks: () => <button aria-label="Companion settings" /> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const empty = { connection: null, latest_update: null, messages: [] };
function show(organizer = false, lang: 'en' | 'he' = 'en') {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CompanionPanel name="Trip friend" lang={lang} isOrganizer={organizer} /></QueryClientProvider>);
}
it('saves member questions and shows pending state without implying bot delivery', async () => {
  vi.mocked(api).mockResolvedValue(empty);
  show(); await screen.findByText('No group update has been shared here yet.');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Can we start later?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to companion' }));
  await screen.findByText('Saved. Waiting for the companion to reply.');
  expect(api).toHaveBeenCalledWith('/api/companion/conversation', { method: 'POST', body: JSON.stringify({ text: 'Can we start later?' }) });
  expect(screen.queryByRole('button', { name: 'Companion settings' })).not.toBeInTheDocument();
  expect(api).not.toHaveBeenCalledWith('/api/companion/connection');
});
it('preserves the draft when saving fails', async () => {
  vi.mocked(api).mockImplementation((_path, init) => init ? Promise.reject(new Error('offline')) : Promise.resolve(empty));
  show(); await screen.findByText('No group update has been shared here yet.');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My idea' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to companion' }));
  await screen.findByRole('alert'); expect(screen.getByRole('textbox')).toHaveValue('My idea');
});
it('shows real updates and replies, with organizer-only links and icon settings', async () => {
  vi.mocked(api).mockImplementation(path => Promise.resolve(path.endsWith('/connection') ? { binding_command: '/group KIN-ABCDEFGH' } : {
    ...empty, connection: { group_url: 'https://t.me/+trip', bot_username: 'trip_bot' },
    latest_update: { text: 'Meet at nine', created_at: '2026-09-12T09:00:00Z' },
    messages: [{ id: 'q', author: 'bob', text: 'Later?', kind: 'question', created_at: '2026-09-12T09:00:00Z', answered: 1 }, { id: 'r', author: 'companion', text: 'Yes, nine works.', kind: 'reply', reply_to: 'q', created_at: '2026-09-12T09:01:00Z' }],
  }));
  show(true); await screen.findByText('Meet at nine');
  expect(screen.getByText('Yes, nine works.')).toBeInTheDocument();
  expect(screen.queryByText('Waiting for the companion')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open Telegram group' })).toHaveAttribute('href', 'https://t.me/+trip');
  expect(screen.getByRole('link', { name: 'Private companion chat' })).toHaveAttribute('href', 'https://t.me/trip_bot');
  expect(screen.getByRole('button', { name: 'Companion settings' })).toHaveTextContent('');
  expect(screen.getByRole('button', { name: 'Copy group connection command' })).toBeInTheDocument();
});
it('localizes shared visibility and does not show missing Telegram connections', async () => {
  vi.mocked(api).mockResolvedValue(empty); show(false, 'he');
  await screen.findByText('עדיין לא שותף כאן עדכון מהקבוצה.');
  expect(screen.getByText(/משותפות לכל משתתפי הטיול/)).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'פתיחת קבוצת הטלגרם' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'שליחה לעוזר' })).toBeDisabled());
});
