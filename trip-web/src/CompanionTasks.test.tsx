import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionTasks } from './CompanionTasks';
import { api } from './api';
vi.mock('./api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const state = { available: true, scheduler_running: true, tasks: [{ id: 'a', label: { he: 'עדכון בוקר', en: 'Morning update' }, enabled: true, audience: 'group', schedule: '0 8 * * *', timezone: 'Asia/Tokyo', next_run: '2026-09-14T08:00:00+09:00' }] };
function show() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CompanionTasks lang="en" /></QueryClientProvider>); fireEvent.click(screen.getByRole('button', { name: 'Companion settings' })); }
it('changes the toggle only when the scheduler confirms and disables Run now for paused tasks', async () => {
  let finish: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce(state).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  show();
  const toggle = await screen.findByRole('switch', { name: 'Morning update' });
  expect(screen.getByText('Telegram group · Daily at 08:00')).toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeDisabled());
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  finish!({ ...state, tasks: [{ ...state.tasks[0], enabled: false }] });
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
});
it('keeps the confirmed state on error', async () => {
  vi.mocked(api).mockResolvedValueOnce(state).mockRejectedValueOnce(new Error('offline'));
  show();
  const toggle = await screen.findByRole('switch');
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
});
it('does not show fake tasks or toggles when the integration is absent', async () => {
  vi.mocked(api).mockResolvedValue({ available: false, scheduler_running: false, tasks: [] });
  show();
  await screen.findByText('Scheduled updates are not connected for this trip yet.');
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});
