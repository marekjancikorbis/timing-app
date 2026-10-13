// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOnboarded, needsIosInstallHint, Onboarding } from './Onboarding';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Onboarding', () => {
  it('needs the safety terms accepted, then remembers it on this device', () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} iosHint={false} />);
    const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(isOnboarded()).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(start);
    expect(onDone).toHaveBeenCalled();
    expect(isOnboarded()).toBe(true);
  });

  it('shows the Add to Home Screen tip only when asked', () => {
    const { rerender } = render(<Onboarding onDone={vi.fn()} iosHint={false} />);
    expect(screen.queryByText('Add to Home Screen')).toBeNull();
    rerender(<Onboarding onDone={vi.fn()} iosHint />);
    expect(screen.getByText('Add to Home Screen')).toBeTruthy();
  });

  it('treats blocked storage as not onboarded', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(isOnboarded(throwing)).toBe(false);
  });
});

describe('needsIosInstallHint', () => {
  const nav = (userAgent: string, standalone?: boolean) =>
    ({ userAgent, standalone }) as unknown as Navigator;
  it('is for iPhone Safari, not the installed app or other phones', () => {
    expect(needsIosInstallHint(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'))).toBe(true);
    expect(needsIosInstallHint(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', true))).toBe(false);
    expect(needsIosInstallHint(nav('Mozilla/5.0 (Linux; Android 15)'))).toBe(false);
  });
});
