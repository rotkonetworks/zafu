import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Clipped } from '.';

const ERROR = 'the relay closed the connection before the room was ready · nothing was lost';
const ADDRESS = 'u1v9gaxw0lxkq3c6m4j8yq5z0r2t7s9d4f6h8k0n2p4r6t8v0x2z4b6d8qrdva';

// jsdom has no layout: give every element a box narrower than its content
const overflow = (scroll: number, client: number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Clipped />', () => {
  test('text that fits renders plain', () => {
    overflow(100, 100);
    render(<Clipped>{ERROR}</Clipped>);
    const el = screen.getByText(ERROR);
    expect(el).not.toHaveAttribute('title');
    expect(el).not.toHaveAttribute('role');
    expect(el).not.toHaveAttribute('tabindex');
    fireEvent.click(el);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('clipped text gets a title and opens a sheet with the full text and copy', () => {
    overflow(400, 100);
    render(<Clipped label='what happened'>{ERROR}</Clipped>);
    const el = screen.getByRole('button', { name: ERROR });
    expect(el).toHaveAttribute('title', ERROR);
    fireEvent.click(el);
    const sheet = screen.getByRole('dialog', { name: 'what happened' });
    expect(sheet).toHaveTextContent(ERROR);
    expect(screen.getByRole('button', { name: 'copy' })).toBeInTheDocument();
  });

  test('enter and space open the sheet', () => {
    overflow(400, 100);
    render(<Clipped>{ERROR}</Clipped>);
    fireEvent.keyDown(screen.getByRole('button', { name: ERROR }), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toHaveTextContent(ERROR);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: ERROR }), { key: ' ' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('copy takes the full text, and presses in the sheet stay out of the row underneath', () => {
    overflow(400, 100);
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <Clipped>{ERROR}</Clipped>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: ERROR }));
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    expect(writeText).toHaveBeenCalledWith(ERROR);
    expect(onRow).not.toHaveBeenCalled();
  });

  test('inside something pressable only the title remains', () => {
    overflow(400, 100);
    const onRow = vi.fn();
    render(
      <button type='button' onClick={onRow}>
        <Clipped>{ERROR}</Clipped>
      </button>,
    );
    const el = screen.getByText(ERROR);
    expect(el).toHaveAttribute('title', ERROR);
    expect(el).not.toHaveAttribute('role');
    fireEvent.click(el);
    expect(onRow).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('middle ellipsis keeps head and tail and names the full text', () => {
    render(
      <Clipped head={6} tail={5} label='address'>
        {ADDRESS}
      </Clipped>,
    );
    expect(screen.getByText('u1v9ga…qrdva')).toHaveAttribute('aria-hidden', 'true');
    const el = screen.getByRole('button', { name: ADDRESS });
    expect(el).toHaveAttribute('title', ADDRESS);
    fireEvent.click(el);
    expect(screen.getByRole('dialog', { name: 'address' })).toHaveTextContent(ADDRESS);
  });

  test('a short string in middle mode stays plain', () => {
    render(<Clipped head={6}>t1abcdef</Clipped>);
    const el = screen.getByText('t1abcdef');
    expect(el).not.toHaveAttribute('title');
    expect(el).not.toHaveAttribute('role');
  });
});
