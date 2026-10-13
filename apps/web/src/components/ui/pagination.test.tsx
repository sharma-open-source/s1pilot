import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { pageCountOf, paginate, Pagination, parsePageParam } from './pagination';

describe('pagination helpers', () => {
  it('slices a page and clamps out-of-range pages', () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(paginate(rows, 1, 3)).toEqual({ items: [0, 1, 2], page: 1, pageCount: 3, total: 7 });
    expect(paginate(rows, 3, 3).items).toEqual([6]);
    expect(paginate(rows, 9, 3)).toMatchObject({ items: [6], page: 3 });
    expect(paginate([], 2, 3)).toEqual({ items: [], page: 1, pageCount: 1, total: 0 });
  });

  it('counts pages and parses the page param', () => {
    expect(pageCountOf(0, 25)).toBe(1);
    expect(pageCountOf(26, 25)).toBe(2);
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam(2)).toBe(2);
    expect(parsePageParam('1')).toBeUndefined();
    expect(parsePageParam('x')).toBeUndefined();
    expect(parsePageParam('2.5')).toBeUndefined();
  });
});

describe('Pagination', () => {
  it('shows counts and moves between pages', async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageCount={3} shown={25} total={60} onPageChange={onPageChange} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByText('Showing 25 of 60')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange.mock.calls).toEqual([[3], [1]]);
  });

  it('disables the ends and can hide a single page', () => {
    const { rerender } = render(
      <Pagination page={1} pageCount={1} shown={3} total={3} onPageChange={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    rerender(
      <Pagination
        page={1}
        pageCount={1}
        shown={3}
        total={3}
        onPageChange={() => undefined}
        hideSingle
      />,
    );
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });
});
