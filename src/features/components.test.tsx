// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { straightGeometry } from '../../tests/harness';
import { routeFromDraft } from '../data/routeModel';
import { IntervalSlider } from './editor/IntervalSlider';
import { RouteList } from './routes/RouteList';

afterEach(cleanup);

describe('IntervalSlider', () => {
  it('reports slider moves immediately', () => {
    const onChange = vi.fn();
    render(<IntervalSlider value={100} onChange={onChange} />);
    const slider = screen.getByLabelText('Sector interval');
    expect(slider).toHaveProperty('min', '100');
    expect(slider).toHaveProperty('max', '1000');
    expect(slider).toHaveProperty('step', '50');
    fireEvent.change(slider, { target: { value: '350' } });
    expect(onChange).toHaveBeenCalledWith(350);
  });

  it('commits typed values on Enter, snapped to the 50 m grid and clamped', () => {
    const onChange = vi.fn();
    render(<IntervalSlider value={100} onChange={onChange} />);
    const box = screen.getByLabelText('Sector interval in metres') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '262' } });
    expect(onChange).not.toHaveBeenCalled(); // nothing until committed
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(250);
    fireEvent.change(box, { target: { value: '9000' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith(1000);
    expect(box.value).toBe('1000');
  });

  it('reverts garbage input and does not report unchanged values', () => {
    const onChange = vi.fn();
    render(<IntervalSlider value={300} onChange={onChange} />);
    const box = screen.getByLabelText('Sector interval in metres') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(box.value).toBe('300');
    fireEvent.change(box, { target: { value: '300' } });
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('follows the value prop and shows the sector summary', () => {
    const { rerender } = render(
      <IntervalSlider value={100} onChange={() => {}} summary="23 sectors" />,
    );
    rerender(<IntervalSlider value={500} onChange={() => {}} summary="5 sectors" warn />);
    expect((screen.getByLabelText('Sector interval in metres') as HTMLInputElement).value).toBe(
      '500',
    );
    expect(screen.getByRole('status').textContent).toBe('5 sectors');
    expect(screen.getByRole('status').className).toMatch(/amber/);
  });
});

describe('RouteList', () => {
  const routes = [
    routeFromDraft(
      { name: 'Hill climb', type: 'stage', geometry: straightGeometry(2330), source: 'drawn' },
      'a',
      1,
    ),
    routeFromDraft(
      {
        name: 'Kart track',
        type: 'circuit',
        geometry: straightGeometry(800),
        source: 'gpx',
        intervalM: 200,
      },
      'b',
      1,
    ),
  ];
  const handlers = () => ({ onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() });

  it('shows an empty state', () => {
    render(<RouteList routes={[]} {...handlers()} />);
    expect(screen.getByText(/No routes yet/)).toBeTruthy();
  });

  it('lists routes with type, length and interval, and opens one', () => {
    const h = handlers();
    render(<RouteList routes={routes} {...h} />);
    expect(screen.getByText('Stage · 2.33 km · 100 m sectors')).toBeTruthy();
    expect(screen.getByText(/Circuit · 1\.\d\d km · 200 m sectors/)).toBeTruthy();
    fireEvent.click(screen.getByText('Kart track'));
    expect(h.onOpen).toHaveBeenCalledWith('b');
  });

  it('renames inline, ignoring blank names', () => {
    const h = handlers();
    render(<RouteList routes={routes} {...h} />);
    fireEvent.click(screen.getAllByText('Rename')[0] as HTMLElement);
    const input = screen.getByLabelText('Route name') as HTMLInputElement;
    expect(input.value).toBe('Hill climb');
    fireEvent.change(input, { target: { value: '  Hill climb (wet) ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(h.onRename).toHaveBeenCalledWith('a', 'Hill climb (wet)');

    fireEvent.click(screen.getAllByText('Rename')[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Route name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(h.onRename).toHaveBeenCalledTimes(1);
  });

  it('offers Drive only when a handler is given', () => {
    const onDrive = vi.fn();
    const { unmount } = render(<RouteList routes={routes} {...handlers()} />);
    expect(screen.queryByText('Drive')).toBeNull();
    unmount();
    render(<RouteList routes={routes} {...handlers()} onDrive={onDrive} />);
    fireEvent.click(screen.getAllByText('Drive')[1] as HTMLElement);
    expect(onDrive).toHaveBeenCalledWith('b');
  });

  it('asks before deleting, and can be cancelled', () => {
    const h = handlers();
    render(<RouteList routes={routes} {...h} />);
    fireEvent.click(screen.getAllByText('Delete')[1] as HTMLElement);
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Keep'));
    expect(screen.queryByText('Delete with all runs')).toBeNull();
    fireEvent.click(screen.getAllByText('Delete')[1] as HTMLElement);
    fireEvent.click(screen.getByText('Delete with all runs'));
    expect(h.onDelete).toHaveBeenCalledWith('b');
  });
});
