import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { BookingCreatePanel } from './App';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('does not create a second booking when retrying a failed attachment', async () => {
  let creates = 0, uploads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/bookings') return { ok: true, status: 200, json: async () => ({ ok: true, id: ++creates }) };
    uploads++;
    return uploads === 1 ? { ok: false, status: 500, json: async () => ({ error: 'Attachment upload failed' }) } : { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  render(<QueryClientProvider client={new QueryClient()}><BookingCreatePanel isOrganizer lang="en" config={{ phases: [{ id: 'ny', title: 'NY' }] }} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: /add booking/i }));
  fireEvent.change(screen.getByLabelText(/booking name/i), { target: { value: 'My hotel' } });
  fireEvent.change(screen.getByLabelText(/confirmation pdf/i), { target: { files: [new File(['pdf'], 'confirmation.pdf', { type: 'application/pdf' })] } });
  fireEvent.click(screen.getByRole('button', { name: /save booking/i }));
  await screen.findByText(/Attachment upload failed/);
  fireEvent.click(screen.getByRole('button', { name: /save booking/i }));
  await waitFor(() => expect(uploads).toBe(2));
  await screen.findByRole('button', { name: /add booking/i });
  expect(creates, 'retry must reuse the already persisted booking').toBe(1);
});

it('keeps completed uploads and applies edits to the same booking on retry', async () => {
  let creates = 0, confirmations = 0, wallets = 0;
  const patches: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const success = { ok: true, status: 200, json: async () => ({ ok: true, id: 17 }) };
    if (url === '/api/bookings') creates++;
    if (url === '/api/bookings/17') patches.push(JSON.parse(init.body));
    if (url === '/api/bookings/17/confirmation') confirmations++;
    if (url === '/api/bookings/17/wallet-apple' && ++wallets === 1) return { ok: false, status: 500, json: async () => ({ error: 'Wallet upload failed' }) };
    return success;
  }));
  render(<QueryClientProvider client={new QueryClient()}><BookingCreatePanel isOrganizer lang="en" config={{ phases: [{ id: 'ny', title: 'NY' }] }} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: /add booking/i }));
  fireEvent.change(screen.getByLabelText(/booking name/i), { target: { value: 'Original booking' } });
  fireEvent.change(screen.getByLabelText(/confirmation pdf/i), { target: { files: [new File(['pdf'], 'confirmation.pdf', { type: 'application/pdf' })] } });
  fireEvent.change(screen.getByLabelText(/apple wallet file/i), { target: { files: [new File(['pass'], 'ticket.pkpass')] } });
  fireEvent.click(screen.getByRole('button', { name: /save booking/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The booking is saved');
  fireEvent.change(screen.getByLabelText(/booking name/i), { target: { value: 'Corrected booking' } });
  fireEvent.click(screen.getByRole('button', { name: /save booking/i }));
  await screen.findByRole('button', { name: /add booking/i });
  expect(creates).toBe(1);
  expect(confirmations).toBe(1);
  expect(wallets).toBe(2);
  expect(patches).toEqual([expect.objectContaining({ name: 'Corrected booking' })]);
  // A successfully completed form must start a genuinely new booking next time.
  fireEvent.click(screen.getByRole('button', { name: /add booking/i }));
  fireEvent.change(screen.getByLabelText(/booking name/i), { target: { value: 'Next booking' } });
  fireEvent.click(screen.getByRole('button', { name: /save booking/i }));
  await screen.findByRole('button', { name: /add booking/i });
  expect(creates).toBe(2);
});
