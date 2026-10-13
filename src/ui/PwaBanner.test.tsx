// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InstallPromptEvent, usePwa } from '../app/pwa';
import { InstallButton, PwaBanner } from './PwaBanner';

const initial = usePwa.getState();
beforeEach(() => usePwa.setState(initial, true));
afterEach(cleanup);

describe('PwaBanner', () => {
  it('offers a reload when a new version is waiting', () => {
    const applyUpdate = vi.fn();
    usePwa.setState({ updateReady: true, applyUpdate });
    render(<PwaBanner quiet={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(applyUpdate).toHaveBeenCalled();
  });

  it('can be put off', () => {
    usePwa.setState({ updateReady: true });
    render(<PwaBanner quiet={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays hidden while driving', () => {
    usePwa.setState({ updateReady: true, offlineReady: true });
    render(<PwaBanner quiet />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says once that the app works offline', () => {
    usePwa.setState({ offlineReady: true });
    render(<PwaBanner quiet={false} />);
    expect(screen.getByRole('status').textContent).toContain('works offline');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(usePwa.getState().offlineReady).toBe(false);
  });
});

describe('InstallButton', () => {
  it('appears only when the browser offers installation, and uses the offer once', async () => {
    const { rerender } = render(<InstallButton />);
    expect(screen.queryByRole('button')).toBeNull();

    const prompt = vi.fn(async () => {});
    act(() => usePwa.setState({ installEvent: { prompt } as unknown as InstallPromptEvent }));
    rerender(<InstallButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
